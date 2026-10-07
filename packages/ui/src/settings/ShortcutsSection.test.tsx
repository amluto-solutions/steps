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
});
