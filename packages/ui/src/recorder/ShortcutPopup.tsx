import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_LANGUAGE,
  matchLanguage,
  renderPhrase,
  type RecordingFact,
  type StepWording,
} from "@amluto-steps/core";

import { Icon } from "../components/icons";
import { factToStep } from "../recorded-step";
import { readStepTone } from "../settings/preferences";
import type { RecorderBridge } from "../recorder-bridge";

/**
 * The key's name for a shortcut step, from its physical position where that is a letter or digit
 * (`event.code`), so Ctrl+Shift+1 reads "1", not the "!" that Shift types.
 */
export const shortcutKeyName = (event: Pick<KeyboardEvent, "code" | "key">): string => {
  const letterOrDigit = /^(?:Key([A-Z])|Digit([0-9])|Numpad([0-9]))$/.exec(event.code);
  if (letterOrDigit) return letterOrDigit[1] ?? letterOrDigit[2] ?? letterOrDigit[3] ?? event.key;
  if (event.key === " ") return "Space";
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
};

/**
 * How new steps are worded: in the app's language, in the tone Settings chose
 * (docs/spec/02-capture.md#step-wording). A function, called as each step is worded, so a change
 * in Settings applies to the next step recorded: a value read while rendering was kept by the
 * React Compiler, and Settings' tone never reached new recordings (F063, 01/10/2026).
 */
export const useStepWording = (): (() => StepWording) => {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return () => ({ language: matchLanguage(language) ?? DEFAULT_LANGUAGE, tone: readStepTone() });
};

/**
 * "Add a keyboard shortcut step" (design canvas, board 5). It reads keys only while it has focus;
 * Steps never listens to the keyboard anywhere else (docs/spec/02-capture.md).
 */
export function ShortcutPopup({ recorder }: { recorder: RecorderBridge }) {
  const { t } = useTranslation();
  const wording = useStepWording();
  const [fact, setFact] = useState<RecordingFact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void recorder
      .onFact((next) => {
        if (next.record.kind === "manual" && next.record.purpose === "shortcut") {
          setFact(next);
          setError(null);
        }
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [recorder]);

  const close = useCallback(async () => {
    setFact(null);
    try {
      await recorder.closeShortcutPopup();
    } catch {
      setError(t("recorder.errorTitle"));
    }
  }, [recorder, t]);

  const save = useCallback(
    async (combo: string) => {
      if (!fact || fact.record.kind !== "manual") return;
      const displayFact: RecordingFact = {
        ...fact,
        record: { ...fact.record, purpose: "captureNow" },
      };
      const words = wording();
      const step = factToStep(displayFact, words);
      if (!step) return;
      step.action = "keypress";
      step.actionText = renderPhrase({ key: "press", keys: combo }, words.language, words.tone);
      step.textParts = { verb: "Press", target: combo, kind: "shortcut" };
      step.reviewRequired = false;
      setBusy(true);
      setError(null);
      try {
        await recorder.appendStep(fact.sessionId, step);
        await close();
      } catch {
        setError(t("recorder.saveFailed"));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wording only wraps t()
    [fact, recorder, t, close],
  );

  useEffect(() => {
    if (!fact) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
      // Keep the popup usable from the keyboard: plain Tab moves between its buttons, and
      // Enter or Space presses the focused button, rather than being recorded as shortcuts.
      const onButton = event.target instanceof HTMLButtonElement;
      if (
        (event.key === "Tab" && !hasModifier) ||
        (onButton && (event.key === "Enter" || event.key === " "))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !hasModifier && !event.shiftKey) {
        void close();
        return;
      }
      // Ctrl, Alt, Shift or Win on its own is the start of a combination, not one: pressing Alt
      // used to save "Alt + Alt".
      if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
      const special = /^(Enter|Tab|Delete|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(event.key);
      if (!hasModifier && !special) {
        setError(t("recorder.shortcutInvalid"));
        return;
      }
      const key = shortcutKeyName(event);
      const modifiers = [
        event.ctrlKey ? "Ctrl" : null,
        event.altKey ? "Alt" : null,
        event.shiftKey ? "Shift" : null,
        event.metaKey ? "Win" : null,
      ].filter((modifier): modifier is string => modifier !== null);
      void save([...modifiers, key].join(" + "));
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [fact, close, save, t]);

  return (
    <main
      aria-labelledby="shortcut-title"
      className="flex h-screen flex-col overflow-hidden rounded-xl border border-line bg-background text-body"
    >
      <div className="flex items-center gap-2 pt-3.5 pr-2.5 pl-5">
        <h1 id="shortcut-title" className="flex-1 font-heading text-[17px] text-navy">
          {t("recorder.shortcutTitle")}
        </h1>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("common.close")}
          disabled={busy}
          onClick={() => void close()}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="mx-5 mt-1 text-sm text-secondary">{t("recorder.shortcutHelp")}</p>
      <div
        className="flex flex-1 items-center justify-center gap-2 text-secondary"
        aria-hidden="true"
      >
        {["Ctrl", "Shift", "?"].map((key) => (
          <kbd
            key={key}
            className="flex h-10 min-w-11 items-center justify-center rounded-lg border border-b-[3px] border-line bg-subtle px-3 font-sans text-[15px] font-bold text-secondary"
          >
            {key}
          </kbd>
        ))}
      </div>
      {error && (
        <p role="alert" className="mx-5 mb-2 text-sm text-recording">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2.5 border-t border-subtle px-5 py-3.5">
        <span className="flex-1 text-xs text-secondary">{t("recorder.shortcutPrivacy")}</span>
        <button type="button" className="btn" disabled={busy} onClick={() => void close()}>
          {t("recorder.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !fact}
          onClick={() => void save("Esc")}
        >
          {t("recorder.addEscape")}
        </button>
      </div>
    </main>
  );
}
