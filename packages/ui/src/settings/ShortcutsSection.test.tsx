// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../i18n";
import type { HotkeyBinding, RecorderBridge } from "../recorder-bridge";
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
    const recorder = {
      getHotkeys: vi.fn(async () =>
        held.map((binding) => ({ ...binding, registered: binding.registered || suspended })),
      ),
      suspendHotkeys: vi.fn(async (on: boolean) => {
        suspended = on;
      }),
      setHotkey: vi.fn(async (action: string, keys: string | null) => {
        const binding = held.find((each) => each.action === action);
        if (binding) binding.keys = keys;
        return held.map((each) => ({ ...each, registered: true }));
      }),
    } as unknown as RecorderBridge;
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
