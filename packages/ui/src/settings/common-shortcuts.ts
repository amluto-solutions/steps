/**
 * Combinations other apps use themselves, so a shortcut set to one takes it from them while Steps
 * holds it (docs/spec/07-settings-and-policy.md#keyboard-shortcuts). From the 10/10/2026 test
 * (P24): Start set to Ctrl+Shift+R took browsers' hard reload. Settings warns; it doesn't refuse,
 * since someone may never use the other app's.
 *
 * Named ones do the same thing in most apps or every browser. Keys are written as the shortcut
 * settings store them (`ctrl+shift+r`).
 */
const NAMED = {
  "ctrl+shift+r": "reloadNoCache",
  "ctrl+f5": "reloadNoCache",
  "ctrl+shift+t": "reopenTab",
  "ctrl+shift+n": "privateWindow",
  "ctrl+shift+p": "privateWindow",
  "ctrl+shift+w": "closeWindow",
  "alt+f4": "closeWindow",
  "ctrl+f4": "closeTab",
  "ctrl+shift+i": "devTools",
  "ctrl+shift+j": "devTools",
  "ctrl+shift+c": "devTools",
  "ctrl+shift+v": "pastePlain",
  "ctrl+shift+z": "redo",
  "ctrl+shift+s": "saveAs",
  "ctrl+shift+b": "bookmarksBar",
} as const;

export type CommonUse = (typeof NAMED)[keyof typeof NAMED];

const ORDER = ["ctrl", "alt", "shift"];

/**
 * What other apps do with `keys`: a use named in `settings.shortcuts.uses`, "many" for a
 * combination nearly every app gives its own meaning (Ctrl with one letter or number, Alt with a
 * letter, which opens a menu), or null for one few apps use.
 */
export function commonShortcut(keys: string): CommonUse | "many" | null {
  const parts = keys.toLowerCase().split("+");
  const modifiers = parts.filter((part) => ORDER.includes(part));
  const rest = parts.filter((part) => !ORDER.includes(part));
  modifiers.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const canonical = [...modifiers, ...rest].join("+");
  const named = (NAMED as Record<string, CommonUse | undefined>)[canonical];
  if (named) return named;
  if (/^ctrl\+[a-z0-9]$/.test(canonical) || /^alt\+[a-z]$/.test(canonical)) return "many";
  return null;
}
