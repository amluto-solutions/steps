// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../i18n";
import type { HotkeyBinding, RecorderBridge } from "../recorder-bridge";
import { useShortcutWarning } from "./useShortcutWarning";

initI18n();

const binding = (
  action: HotkeyBinding["action"],
  keys: string | null,
  registered = true,
): HotkeyBinding => ({ action, keys, registered });

let hasFocus = true;
beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  hasFocus = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function start(bindings: HotkeyBinding[]) {
  const notify = vi.fn();
  const showShortcuts = vi.fn();
  const recorder = { getHotkeys: vi.fn(async () => bindings) } as unknown as RecorderBridge;
  renderHook(() => useShortcutWarning(recorder, notify, showShortcuts));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  return { notify, showShortcuts };
}

describe("a shortcut another app already uses", () => {
  it("is named once when the app starts, with a way to change it", async () => {
    const { notify, showShortcuts } = await start([
      binding("startRecording", "ctrl+alt+shift+n", false),
      binding("stop", "ctrl+alt+shift+x"),
      binding("captureNow", null, false),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    const toast = notify.mock.calls[0]?.[0] as { text: string; action: { run: () => void } };
    expect(toast.text).toBe(
      "Another app already uses Ctrl + Alt + Shift + N, so “Start a recording” won’t work from the keyboard.",
    );
    toast.action.run();
    expect(showShortcuts).toHaveBeenCalled();
  });

  it("counts several, isn't repeated for the same clash, and is for a new one", async () => {
    const both = [
      binding("togglePause", "ctrl+alt+shift+r", false),
      binding("stop", "ctrl+alt+shift+x", false),
    ];
    const first = await start(both);
    expect(first.notify.mock.calls[0]?.[0]).toMatchObject({
      text: "Another app already uses 2 of Steps’ keyboard shortcuts, so they won’t work.",
    });
    cleanup();
    expect((await start(both)).notify).not.toHaveBeenCalled();
    cleanup();
    expect(
      (await start([binding("togglePause", "ctrl+alt+shift+r", false)])).notify,
    ).toHaveBeenCalledTimes(1);
  });

  it("waits until the window has the focus (a start in the tray)", async () => {
    hasFocus = false;
    const { notify } = await start([binding("stop", "ctrl+alt+shift+x", false)]);
    expect(notify).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("says nothing when every shortcut works, and forgets an old clash", async () => {
    await start([binding("stop", "ctrl+alt+shift+x", false)]);
    cleanup();
    expect((await start([binding("stop", "ctrl+alt+shift+x")])).notify).not.toHaveBeenCalled();
    cleanup();
    // The clash is back after it had cleared: said again.
    expect(
      (await start([binding("stop", "ctrl+alt+shift+x", false)])).notify,
    ).toHaveBeenCalledTimes(1);
  });
});
