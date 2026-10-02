import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { HotkeyAction, HotkeyBinding, RecorderBridge } from "../recorder-bridge";
import { errorMessage } from "../errors";
import { displayKeys, keysFromEvent } from "./preferences";
import type { SettingsProps } from "./settings-props";

/** Start and Stop may share one combination: it then starts, or stops a recording that's running. */
const startStopPair = (one: HotkeyAction, other: HotkeyAction) =>
  (one === "startRecording" && other === "stop") || (one === "stop" && other === "startRecording");

export function ShortcutsSection({
  recorder,
  notify,
}: {
  recorder: RecorderBridge | undefined;
  notify: SettingsProps["notify"];
}) {
  const { t, i18n } = useTranslation();
  const [bindings, setBindings] = useState<HotkeyBinding[]>([]);
  const [editing, setEditing] = useState<HotkeyAction | null>(null);
  const [problem, setProblem] = useState<{ action: HotkeyAction; text: string } | null>(null);
  // When the capture box closes, focus goes back to that row's Change button, not the page.
  const returnTo = useRef<HotkeyAction | null>(null);
  const changeButtons = useRef(new Map<HotkeyAction, HTMLButtonElement>());
  useEffect(() => {
    if (editing !== null || returnTo.current === null) return;
    changeButtons.current.get(returnTo.current)?.focus();
    returnTo.current = null;
  }, [editing]);
  // Focused once when the box appears (an inline ref would pull focus back on every render).
  const focusOnce = useCallback((element: HTMLButtonElement | null) => element?.focus(), []);
  const stopEditing = (action: HotkeyAction) => {
    returnTo.current = action;
    setEditing(null);
  };

  useEffect(() => {
    void recorder
      ?.getHotkeys()
      .then(setBindings)
      .catch(() => setBindings([]));
  }, [recorder]);

  // While the box waits for keys, every shortcut is switched off, so pressing one (Start's, say)
  // is read by the box instead of starting a recording. They come back when it closes.
  const waiting = editing !== null;
  useEffect(() => {
    if (!waiting || !recorder) return;
    void recorder.suspendHotkeys(true).catch(() => undefined);
    // The list saved while waiting says every shortcut works (nothing is registered then), so it is
    // read again once they're back: one another app holds shows its warning again.
    return () =>
      void recorder
        .suspendHotkeys(false)
        .then(() => recorder.getHotkeys())
        .then(setBindings)
        .catch(() => undefined);
  }, [waiting, recorder]);

  const save = async (action: HotkeyAction, keys: string | null) => {
    if (!recorder) return;
    try {
      setBindings(await recorder.setHotkey(action, keys));
      stopEditing(action);
      setProblem(null);
    } catch (error) {
      setProblem({ action, text: errorMessage(error, t("settings.shortcuts.failed")) });
    }
  };

  const capture = (event: KeyboardEvent, action: HotkeyAction) => {
    // Tab and Shift+Tab still move on, to Turn off and Cancel: the box mustn't trap the keyboard.
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopEditing(action);
      setProblem(null);
      return;
    }
    const keys = keysFromEvent(event);
    if (keys === "modifier") return;
    if (keys === null) {
      setProblem({ action, text: t("settings.shortcuts.needModifier") });
      return;
    }
    const clash = bindings.find(
      (binding) =>
        binding.action !== action &&
        binding.keys === keys &&
        !startStopPair(action, binding.action),
    );
    if (clash) {
      setProblem({
        action,
        text: t("settings.shortcuts.inUse", {
          name: t(`settings.shortcuts.actions.${clash.action}`),
        }),
      });
      return;
    }
    void save(action, keys);
  };

  const shared =
    bindings.find((binding) => binding.action === "startRecording")?.keys != null &&
    bindings.find((binding) => binding.action === "startRecording")?.keys ===
      bindings.find((binding) => binding.action === "stop")?.keys;
  const help = (binding: HotkeyBinding): string | null => {
    if ((binding.action === "startRecording" || binding.action === "stop") && shared)
      return t("settings.shortcuts.sharedHelp");
    if (binding.action === "addShortcut") return t("settings.shortcuts.addShortcutHelp");
    if (binding.action === "startRecording") return t("settings.shortcuts.startHelp");
    return null;
  };

  return (
    <>
      <h2 className="mb-1 font-heading text-xl text-navy">{t("settings.sections.shortcuts")}</h2>
      <p className="mb-4 text-sm leading-relaxed text-secondary">{t("settings.shortcuts.intro")}</p>
      <div className="card flex flex-col">
        {bindings.map((binding, index) => {
          const name = t(`settings.shortcuts.actions.${binding.action}`);
          const isEditing = editing === binding.action;
          return (
            <div
              key={binding.action}
              className={`flex min-h-14 items-center gap-3.5 py-2 pr-3 pl-4 ${index > 0 ? "border-t border-subtle" : ""}`}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold text-navy">{name}</span>
                {help(binding) && (
                  <span className="text-xs leading-snug text-secondary">{help(binding)}</span>
                )}
                {problem?.action === binding.action && (
                  <span role="alert" className="text-xs text-recording">
                    {problem.text}
                  </span>
                )}
                {binding.keys && !binding.registered && !isEditing && (
                  <span className="text-xs text-warning">
                    {binding.heldBySteps
                      ? t("settings.shortcuts.heldBySteps")
                      : t("settings.shortcuts.unavailable")}
                  </span>
                )}
              </div>
              {isEditing ? (
                <>
                  <button
                    type="button"
                    // The box only reads keys while it has focus; nothing else is listened to.
                    ref={focusOnce}
                    onKeyDown={(event) => capture(event, binding.action)}
                    className="h-[34px] min-w-48 rounded-lg border-2 border-dashed border-blue bg-selected px-3 text-[13px] font-semibold text-link"
                  >
                    {t("settings.shortcuts.pressKeys")}
                  </button>
                  <button
                    type="button"
                    className="btn h-[34px]"
                    onClick={() => void save(binding.action, null)}
                  >
                    {t("settings.shortcuts.turnOff")}
                  </button>
                  <button
                    type="button"
                    className="btn h-[34px]"
                    onClick={() => {
                      stopEditing(binding.action);
                      setProblem(null);
                    }}
                  >
                    {t("common.cancel")}
                  </button>
                </>
              ) : (
                <>
                  {binding.keys ? (
                    <span className="flex gap-1">
                      {displayKeys(binding.keys, i18n.language).map((key) => (
                        <kbd
                          key={key}
                          className="min-w-5 rounded-md border border-b-2 border-line bg-subtle px-2 py-0.5 text-center font-sans text-xs font-semibold text-navy"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  ) : (
                    <span className="text-[13px] text-secondary">
                      {t("settings.shortcuts.off")}
                    </span>
                  )}
                  <button
                    type="button"
                    ref={(element) => {
                      if (element) changeButtons.current.set(binding.action, element);
                    }}
                    className="btn h-[34px] text-link"
                    aria-label={t("settings.shortcuts.changeFor", { name })}
                    onClick={() => {
                      setEditing(binding.action);
                      setProblem(null);
                    }}
                  >
                    {binding.keys ? t("settings.shortcuts.change") : t("settings.shortcuts.set")}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          className="btn"
          onClick={() =>
            void recorder
              ?.resetHotkeys()
              .then((next) => {
                setBindings(next);
                notify({ text: t("settings.shortcuts.resetDone") });
              })
              .catch((error: unknown) =>
                notify({
                  kind: "error",
                  text: errorMessage(error, t("settings.shortcuts.failed")),
                }),
              )
          }
        >
          {t("settings.shortcuts.reset")}
        </button>
        <span className="text-xs text-secondary">{t("settings.shortcuts.privacy")}</span>
      </div>
    </>
  );
}
