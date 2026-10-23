// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HotkeyBinding, Hotkeys } from "../bridge/hotkeys";
import { fakeHotkeys } from "../bridge/hotkeys-fake";
import { initI18n } from "../i18n";
import { ShortcutsSection } from "./ShortcutsSection";

initI18n();
afterEach(cleanup);

describe("keyboard shortcuts", () => {
  it("still warns about a shortcut another app holds after changing a different one", async () => {
    // Windows refuses Pause's combination; while the box waits, nothing is registered, so the
    // list saved then says everything works.
    const held: HotkeyBinding[] = [
      { action: "startRecording", keys: "ctrl+n", registered: true },
      { action: "togglePause", keys: "ctrl+alt+shift+r", registered: false },
    ];
    let suspended = false;
    const listed = () =>
      held.map((binding) => ({ ...binding, registered: binding.registered || suspended }));
    const recorder: Hotkeys = {
      ...fakeHotkeys(held),
      getHotkeys: async () => listed(),
      suspendHotkeys: async (on) => {
        suspended = on;
        return listed();
      },
      setHotkey: async (action, keys) => {
        const binding = held.find((each) => each.action === action);
        if (binding) binding.keys = keys;
        return held.map((each) => ({ ...each, registered: true }));
      },
    };
    render(<ShortcutsSection recorder={recorder} notify={vi.fn()} />);
    const warning = "Another app already uses this, so it doesn't work right now.";
    expect(await screen.findByText(warning)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /^Change/ })[0] as HTMLElement);
    const box = await screen.findByRole("button", { name: /Press the new keys/ });
    await act(async () => {
      fireEvent.keyDown(box, { key: "m", code: "KeyM", ctrlKey: true });
    });

    expect(await screen.findByText(warning)).toBeTruthy();
  });

  it("warns, but keeps, a combination other apps use themselves (P24)", async () => {
    const recorder = fakeHotkeys([
      { action: "startRecording", keys: "ctrl+alt+shift+n", registered: true },
      { action: "stop", keys: "ctrl+alt+shift+x", registered: true },
    ]);
    render(<ShortcutsSection recorder={recorder} notify={vi.fn()} />);
    await screen.findByText("Start a recording");
    expect(screen.queryByText(/Other apps use/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Change the shortcut for Start a recording" }),
    );
    const box = await screen.findByRole("button", { name: /Press the new keys/ });
    await act(async () => {
      fireEvent.keyDown(box, { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true });
    });

    expect(
      await screen.findByText(
        "Other apps use Ctrl + Shift + R for “Reload without cache”. While Steps has it, it won’t do that there.",
      ),
    ).toBeTruthy();
    expect((await recorder.getHotkeys())[0]?.keys).toBe("ctrl+shift+r");
  });

  it("says many apps use Ctrl with a single letter", async () => {
    render(
      <ShortcutsSection
        recorder={fakeHotkeys([{ action: "captureNow", keys: "ctrl+c", registered: true }])}
        notify={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(
        "Many apps use Ctrl + C themselves. While Steps has it, it won’t work in them.",
      ),
    ).toBeTruthy();
  });
});
