import { HOTKEY_ACTIONS, type HotkeyBinding, type Hotkeys } from "./hotkeys";

/** Steps' own shortcuts, as the desktop starts with them. */
export const DEFAULT_HOTKEYS: readonly HotkeyBinding[] = [
  { action: "startRecording", keys: "ctrl+alt+shift+n", registered: true },
  { action: "togglePause", keys: "ctrl+alt+shift+r", registered: true },
  { action: "stop", keys: "ctrl+alt+shift+x", registered: true },
  { action: "captureNow", keys: "ctrl+alt+shift+s", registered: true },
  { action: "addShortcut", keys: "ctrl+alt+shift+k", registered: true },
];

/**
 * Keyboard shortcuts for tests and the preview, kept in memory: Steps' own to start with, or the
 * `bindings` given (Windows refusing one is `registered: false`). Every binding is always listed,
 * as the desktop lists them.
 */
export function fakeHotkeys(bindings: readonly HotkeyBinding[] = DEFAULT_HOTKEYS): Hotkeys {
  const start = HOTKEY_ACTIONS.map(
    (action) =>
      bindings.find((binding) => binding.action === action) ?? {
        action,
        keys: null,
        registered: true,
      },
  );
  let current = start.map((binding) => ({ ...binding }));
  const answer = () => Promise.resolve(current.map((binding) => ({ ...binding })));
  return {
    getHotkeys: answer,
    setHotkey(action, keys) {
      current = current.map((binding) =>
        binding.action === action ? { ...binding, keys, registered: true } : binding,
      );
      return answer();
    },
    resetHotkeys() {
      current = DEFAULT_HOTKEYS.map((binding) => ({ ...binding }));
      return answer();
    },
    suspendHotkeys: answer,
  };
}
