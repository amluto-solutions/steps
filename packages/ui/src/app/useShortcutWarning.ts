import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { ToastMessage } from "../components/Toast";
import type { RecorderBridge } from "../recorder-bridge";
import { displayKeys } from "../settings/preferences";
import { useLatest } from "../useLatest";

/** The clashes already told about (this window's local storage), so each is told once. */
const TOLD_KEY = "amluto-steps-shortcut-clash-told";
/** Windows registers the shortcuts as the app starts; this leaves time for that to finish. */
const SETTLE_MS = 2_000;

const readTold = (): string => {
  try {
    return window.localStorage.getItem(TOLD_KEY) ?? "";
  } catch {
    return "";
  }
};

const saveTold = (value: string) => {
  try {
    if (value) window.localStorage.setItem(TOLD_KEY, value);
    else window.localStorage.removeItem(TOLD_KEY);
  } catch {
    // Without storage the notice may come again at the next start; nothing worse.
  }
};

/** Resolves once the main window has the focus: at once, or when it's first opened from the tray. */
const focused = (): Promise<void> =>
  document.hasFocus()
    ? Promise.resolve()
    : new Promise((resolve) => window.addEventListener("focus", () => resolve(), { once: true }));

/**
 * A shortcut Windows refused because another app already uses it
 * (docs/spec/07-settings-and-policy.md#keyboard-shortcuts): said once, when the app starts and
 * the person can see it, with a way to Settings > Keyboard shortcuts. The same clash isn't
 * repeated at every start; a different one is, and once nothing clashes the memory is cleared.
 */
export function useShortcutWarning(
  recorder: RecorderBridge | undefined,
  notify: (toast: Omit<ToastMessage, "id">) => void,
  showShortcuts: () => void,
) {
  const { t } = useTranslation();
  const latest = useLatest({ notify, showShortcuts, t });

  useEffect(() => {
    if (!recorder) return undefined;
    let cancelled = false;
    void (async () => {
      await new Promise((resolve) => window.setTimeout(resolve, SETTLE_MS));
      await focused();
      if (cancelled) return;
      // Test and preview bridges may not have it; then there's nothing to say.
      const bindings = await Promise.resolve()
        .then(() => recorder.getHotkeys())
        .catch(() => null);
      if (cancelled || !Array.isArray(bindings)) return;
      const clashes = bindings.filter((binding) => binding.keys && !binding.registered);
      const key = clashes
        .map((binding) => `${binding.action}=${binding.keys}`)
        .sort()
        .join(";");
      if (key === readTold()) return;
      saveTold(key);
      const [first] = clashes;
      if (!first?.keys) return;
      const { notify: tell, showShortcuts: show, t: say } = latest.current;
      tell({
        text:
          clashes.length === 1
            ? say("shortcutClash.one", {
                keys: displayKeys(first.keys).join(" + "),
                name: say(`settings.shortcuts.actions.${first.action}`),
              })
            : say("shortcutClash.other", { count: clashes.length }),
        action: { label: say("shortcutClash.change"), run: show },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [recorder, latest]);
}
