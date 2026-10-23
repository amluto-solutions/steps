// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initI18n, RecorderBar } from "@amluto-steps/ui";

import { desktopRecorder } from "./recorder-bridge";
import { commandsOf } from "./test/capabilities";
import { rustBackend, type Handler } from "./test/rust-backend";

initI18n();
afterEach(cleanup);

/**
 * The recording bar as the desktop app runs it: the desktop adapter over a stand-in for the Rust
 * side that answers only what the bar's own capability (`capabilities/recorder-bar.json`) grants,
 * so a command the bar sends but isn't allowed fails here as Tauri would refuse it.
 */
function barBackend(answers: Record<string, Handler>) {
  const granted = new Set(commandsOf("recorder-bar"));
  rustBackend(
    Object.fromEntries(Object.entries(answers).filter(([command]) => granted.has(command))),
    // core:window:allow-set-size, for fitting the window to the bar.
    { "plugin:window|set_size": () => undefined },
  );
}

describe("The recording bar in the desktop app", () => {
  it("shows the keys set for Show a keyboard shortcut in its menu (#101)", async () => {
    barBackend({
      recorder_get_state: () => ({
        state: "recording",
        reason: null,
        sessionId: "session-1",
        stepCount: 2,
        missedCount: 0,
        inputSource: "rawInput",
        keysRecorded: false,
      }),
      recorder_bar_heartbeat: () => undefined,
      recorder_bar_place: () => null,
      hotkeys_get: () => [{ action: "addShortcut", keys: "ctrl+alt+j", registered: true }],
    });
    render(<RecorderBar recorder={desktopRecorder} />);
    await screen.findByText("Recording");

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const item = screen.getByRole("menuitem", { name: /Show a keyboard shortcut/ });
    expect(await screen.findByText("Ctrl+Alt+J")).toBeTruthy();
    expect(item.textContent).toContain("Ctrl+Alt+J");
  });
});
