// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecordingFact } from "@amluto-steps/core";
import { shortcutKeyName, ShortcutPopup } from "./App";
import { fakeRecorder } from "./bridge/recorder-fake";
import { initI18n } from "./i18n";

initI18n();
afterEach(cleanup);

const shortcutFact: RecordingFact = {
  sessionId: "session-1",
  recordedAt: 1_790_246_400_000,
  sequence: 4,
  record: {
    kind: "manual",
    id: 7,
    tickMs: 100,
    purpose: "shortcut",
    actionText: "Shortcut screenshot",
    window: {
      title: "Document - Word",
      exe: "WINWORD.EXE",
      pid: 10,
      frame: { left: 0, top: 0, right: 100, bottom: 100 },
      elevation: "notElevated",
      remoteSession: false,
    },
    capture: {
      mode: "window",
      rect: { left: 0, top: 0, right: 100, bottom: 100 },
      monitor: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      width: 100,
      height: 100,
      image: "manual-7.webp",
    },
    clickPct: { x: 50, y: 50 },
  },
};

/** The popup, once the recorder has told it about the shortcut's screenshot. */
async function renderPopup() {
  const recorder = fakeRecorder();
  recorder.addSession("session-1");
  const appendStep = vi.spyOn(recorder, "appendStep");
  const onFact = vi.spyOn(recorder, "onFact");
  render(<ShortcutPopup recorder={recorder} />);
  await waitFor(() => expect(onFact).toHaveBeenCalled());
  act(() => recorder.fire.fact(shortcutFact));
  return { appendStep };
}

describe("shortcutKeyName", () => {
  it("names letters and digits by physical key, not the character Shift types", () => {
    expect(shortcutKeyName({ code: "Digit1", key: "!" })).toBe("1");
    expect(shortcutKeyName({ code: "KeyS", key: "s" })).toBe("S");
    expect(shortcutKeyName({ code: "Numpad5", key: "5" })).toBe("5");
    expect(shortcutKeyName({ code: "Space", key: " " })).toBe("Space");
    expect(shortcutKeyName({ code: "F4", key: "F4" })).toBe("F4");
  });
});

describe("ShortcutPopup", () => {
  it("records the combination by physical key", async () => {
    const { appendStep } = await renderPopup();
    fireEvent.keyDown(window, { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(appendStep).toHaveBeenCalledOnce());
    const step = vi.mocked(appendStep).mock.calls[0]?.[1];
    expect(step?.actionText).toContain("Ctrl + Shift + 1");
  });

  it("waits for the rest when a modifier is pressed on its own", async () => {
    const { appendStep } = await renderPopup();
    // Pressing Alt used to save "Alt + Alt".
    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.keyDown(window, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(appendStep).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    await waitFor(() => expect(appendStep).toHaveBeenCalledOnce());
    const step = vi.mocked(appendStep).mock.calls[0]?.[1];
    expect(step?.actionText).toContain("Ctrl + Alt + S");
  });

  it("lets Tab move between its buttons and Enter press them", async () => {
    const { appendStep } = await renderPopup();
    // Not prevented: the browser moves focus as usual.
    expect(fireEvent.keyDown(window, { key: "Tab", code: "Tab" })).toBe(true);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    expect(fireEvent.keyDown(cancel, { key: "Enter", code: "Enter" })).toBe(true);
    expect(appendStep).not.toHaveBeenCalled();
  });
});
