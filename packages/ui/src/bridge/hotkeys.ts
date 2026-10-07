export type HotkeyAction = "startRecording" | "togglePause" | "stop" | "captureNow" | "addShortcut";

/** Every action a shortcut can be set for, in Settings' order. */
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  "startRecording",
  "togglePause",
  "stop",
  "captureNow",
  "addShortcut",
];

export interface HotkeyBinding {
  action: HotkeyAction;
  /** `ctrl+alt+shift+k` style, or null when switched off. */
  keys: string | null;
  /** False when Windows refused it (another app already uses the combination). */
  registered: boolean;
  /** Not registered while another copy of Steps is running, which most likely holds it. */
  heldBySteps?: boolean;
}

/**
 * Keyboard shortcuts for recording (Settings > Keyboard shortcuts), part of the recorder bridge.
 * Each change answers every binding as it now is. An edition without shortcuts (the
 * `hotkeys` capability) answers none, and changing one isn't an error.
 */
export interface Hotkeys {
  getHotkeys(): Promise<HotkeyBinding[]>;
  setHotkey(action: HotkeyAction, keys: string | null): Promise<HotkeyBinding[]>;
  /** Back to Steps' own shortcuts. */
  resetHotkeys(): Promise<HotkeyBinding[]>;
  /** Switches every shortcut off (true) while Settings reads new keys, and back on (false). */
  suspendHotkeys(suspended: boolean): Promise<HotkeyBinding[]>;
}

/** Keyboard shortcuts in an edition without them (Steps for Chrome): none, and nothing to set. */
export function noHotkeys(): Hotkeys {
  const none = () => Promise.resolve([]);
  return { getHotkeys: none, setHotkey: none, resetHotkeys: none, suspendHotkeys: none };
}
