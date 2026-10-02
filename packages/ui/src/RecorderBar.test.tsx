// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecorderBridge, RecorderSnapshot } from "./recorder-bridge";
import { errorMessage, RecorderBar } from "./App";
import { expectNoSeriousAxeViolations } from "../test/axe";
import { initI18n } from "./i18n";

initI18n();
afterEach(cleanup);

const recording: RecorderSnapshot = {
  state: "recording",
  reason: null,
  sessionId: "session-1",
  stepCount: 3,
  missedCount: 1,
  inputSource: "rawInput",
  keysRecorded: false,
};

function createRecorder(pause: ReturnType<typeof vi.fn>): RecorderBridge {
  return {
    getState: vi.fn().mockResolvedValue(recording),
    onState: vi.fn().mockResolvedValue(() => undefined),
    onFact: vi.fn().mockResolvedValue(() => undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    onHeartbeatRequest: vi.fn().mockResolvedValue(() => undefined),
    resizeBar: vi.fn().mockResolvedValue(undefined),
    startAgain: vi.fn().mockResolvedValue({ ...recording, stepCount: 0 }),
    undoStartAgain: vi.fn().mockResolvedValue(recording),
    getHotkeys: vi
      .fn()
      .mockResolvedValue([{ action: "addShortcut", keys: "ctrl+alt+j", registered: true }]),
    pause,
  } as unknown as RecorderBridge;
}

describe("errorMessage", () => {
  it("words Rust errors from en.json by their code, and falls back otherwise", () => {
    // The words come from en.json, not from the Rust message.
    expect(errorMessage({ code: "busy", message: "Recorder is busy (Rust text)" }, "x")).toBe(
      "A recording is already in progress.",
    );
    // Where the Rust message names something specific, it is kept as the detail.
    expect(
      errorMessage({ code: "importRejected", message: "the file is larger than 2 GB" }, "x"),
    ).toBe("That file can’t be imported: the file is larger than 2 GB");
    expect(errorMessage({ code: "somethingNew", message: "Rust words" }, "Fallback")).toBe(
      "Fallback",
    );
    expect(errorMessage(new Error("notBrandFile"), "x")).toBe(
      "Choose a Steps brand file (.amlbrand).",
    );
    expect(errorMessage(new Error("Network down"), "Fallback")).toBe("Fallback");
    expect(errorMessage("weird", "Something went wrong")).toBe("Something went wrong");
  });
});

describe("RecorderBar", () => {
  it("says keys are recorded, and drops the shortcut popup, only when they are", async () => {
    const recorder = createRecorder(vi.fn());
    const { unmount } = render(<RecorderBar recorder={recorder} />);
    await screen.findByText("Recording");
    expect(screen.queryByText("Keys recorded")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /Show a keyboard shortcut/ })).toBeTruthy();
    // The keys shown are the ones set in Settings, not the default.
    expect(await screen.findByText("Ctrl+Alt+J")).toBeTruthy();
    unmount();

    recorder.getState = vi.fn().mockResolvedValue({ ...recording, keysRecorded: true });
    render(<RecorderBar recorder={recorder} />);
    expect(await screen.findByText("Keys recorded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /Show a keyboard shortcut/ })).toBeNull();
  });

  it.each(["pause", "resume", "stop"] as const)(
    "reports a rejected %s command and permits a retry",
    async (command) => {
      const initial = {
        ...recording,
        state: command === "resume" ? "paused" : "recording",
      } as const;
      const next = {
        ...recording,
        state: command === "pause" ? "paused" : command === "stop" ? "stopping" : "recording",
      } as const;
      const action = vi
        .fn()
        .mockRejectedValueOnce({
          code: "invalidState",
          message: "The recorder refused this command.",
        })
        .mockResolvedValue(next);
      const recorder = createRecorder(vi.fn());
      recorder.getState = vi.fn().mockResolvedValue(initial);
      recorder[command] = action;
      render(<RecorderBar recorder={recorder} />);
      await screen.findByText(initial.state === "paused" ? "Paused" : "Recording");
      const name = command.charAt(0).toUpperCase() + command.slice(1);
      const button = screen.getByRole("button", { name });

      fireEvent.click(button);
      const alert = await screen.findByRole("alert");
      // The words for the error code are shown, from en.json.
      expect(alert.textContent).toContain("That can’t be done right now.");
      expect(alert.classList.contains("sr-only")).toBe(false);
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByText(initial.state === "paused" ? "Paused" : "Recording")).toBeDefined();

      fireEvent.click(button);
      await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    },
  );

  it("exposes the live recording state and named controls to assistive technology", async () => {
    const { container } = render(<RecorderBar recorder={createRecorder(vi.fn())} />);

    expect(await screen.findByText("Recording")).toBeDefined();
    expect(screen.getByRole("button", { name: "Capture now" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /Show a keyboard shortcut/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Start again/ })).toBeDefined();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    await expectNoSeriousAxeViolations(container);
  });

  it("keeps focus on Pause while the command runs, so keyboard users don't lose their place", async () => {
    let finish: (value: RecorderSnapshot) => void = () => undefined;
    const pause = vi.fn(
      () =>
        new Promise<RecorderSnapshot>((resolve) => {
          finish = resolve;
        }),
    );
    render(<RecorderBar recorder={createRecorder(pause)} />);
    const button = await screen.findByRole("button", { name: "Pause" });
    button.focus();

    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(pause).toHaveBeenCalledOnce();

    finish({ ...recording, state: "paused" });
    const resume = await screen.findByRole("button", { name: "Resume" });
    expect(resume).toBe(button);
    expect(document.activeElement).toBe(resume);
  });

  it("names the exclude action with its visible words (WCAG 2.5.3)", async () => {
    const recorder = createRecorder(vi.fn());
    recorder.onFact = vi.fn((listener: (fact: unknown) => void) => {
      listener({ record: { kind: "click", window: { exe: "msedge.exe" } } });
      return Promise.resolve(() => undefined);
    }) as unknown as RecorderBridge["onFact"];
    render(<RecorderBar recorder={recorder} />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));

    const exclude = await screen.findByRole("menuitem", { name: "Never record msedge.exe" });
    expect(exclude.textContent).toBe("Never record msedge.exe");
  });

  it("starts again and offers an undo until the next step is recorded", async () => {
    const recorder = createRecorder(vi.fn());
    render(<RecorderBar recorder={recorder} />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Start again/ }));
    await waitFor(() => expect(recorder.startAgain).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("Started again. The 3 earlier steps were cleared."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(recorder.undoStartAgain).toHaveBeenCalledOnce());
  });

  it("asks before discarding from the bar, starting on the safe choice", async () => {
    const discard = vi.fn().mockResolvedValue({ ...recording, state: "stopping" });
    const recorder = createRecorder(vi.fn());
    recorder.discard = discard;
    render(<RecorderBar recorder={recorder} />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Discard this recording" }));
    expect(document.activeElement?.textContent).toBe("Keep recording");
    expect(discard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
    await waitFor(() => expect(discard).toHaveBeenCalledOnce());
  });

  it("tells the recorder it is still showing, once a second", async () => {
    vi.useFakeTimers();
    try {
      const recorder = createRecorder(vi.fn());
      render(<RecorderBar recorder={recorder} />);
      expect(recorder.heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(recorder.heartbeat).toHaveBeenCalledTimes(4);
      cleanup();
      await vi.advanceTimersByTimeAsync(3000);
      expect(recorder.heartbeat).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers the recorder's heartbeat request even without timers", async () => {
    let request: () => void = () => undefined;
    const recorder = createRecorder(vi.fn());
    recorder.onHeartbeatRequest = vi.fn((handler: () => void) => {
      request = handler;
      return Promise.resolve(() => undefined);
    });
    render(<RecorderBar recorder={recorder} />);
    await waitFor(() => expect(recorder.onHeartbeatRequest).toHaveBeenCalledOnce());
    const before = vi.mocked(recorder.heartbeat).mock.calls.length;
    request();
    request();
    expect(recorder.heartbeat).toHaveBeenCalledTimes(before + 2);
  });

  it("runs Pause from its keyboard-accessible named button", async () => {
    const pause = vi.fn().mockResolvedValue({ ...recording, state: "paused" });
    render(<RecorderBar recorder={createRecorder(pause)} />);

    const pauseButton = await screen.findByRole("button", { name: "Pause" });
    fireEvent.click(pauseButton);

    await waitFor(() => expect(pause).toHaveBeenCalledOnce());
  });
});
