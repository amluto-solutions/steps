import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";
import { errorMessage } from "../errors";
import { isLinux, type RecorderBridge, type RecorderSnapshot } from "../recorder-bridge";
import { displayKeys, EXCLUDED_APPS_KEY, readExcludedApps } from "../settings/preferences";

export const EMPTY_SNAPSHOT: RecorderSnapshot = {
  state: "idle",
  reason: null,
  sessionId: null,
  stepCount: 0,
  missedCount: 0,
  inputSource: "rawInput",
  keysRecorded: false,
};

// Windows: the app and its WebView2; Linux: the app (its WebKitGTK views are in the same process).
const OWN_PROCESSES = /^(amluto-steps(\.exe)?|msedgewebview2\.exe|WebKitWebProcess)$/i;

/** Why recording paused by itself, in plain words (the Rust reason is `Uac`, `LockScreen`…). */
const pauseNote = (
  reason: string | null,
): "uac" | "lock" | "excluded" | "input" | "indicator" | null => {
  if (!reason) return null;
  if (reason.startsWith("Uac")) return "uac";
  if (reason.startsWith("LockScreen")) return "lock";
  if (reason.startsWith("ExcludedApp")) return "excluded";
  if (reason.startsWith("InputStopped")) return "input";
  if (reason.startsWith("IndicatorLost")) return "indicator";
  return null;
};

/**
 * The floating recording bar (design canvas, board 4): a small navy pill you drag by its dots or
 * its status, with Capture now, Pause/Resume and Stop on it and everything else under More. The
 * window grows to fit a menu or a note and shrinks back afterwards.
 */
export function RecorderBar({ recorder }: { recorder: RecorderBridge }) {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = useState<RecorderSnapshot>(EMPTY_SNAPSHOT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elevatedWindow, setElevatedWindow] = useState<string | null>(null);
  const [lastApp, setLastApp] = useState("");
  const [excludedApps, setExcludedApps] = useState<string[]>(readExcludedApps);
  const [menuOpen, setMenuOpen] = useState(false);
  // The keys set for "Show a keyboard shortcut", read when the menu opens (they can change in
  // Settings while recording).
  const [shortcutKeys, setShortcutKeys] = useState<string | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    void recorder
      .getHotkeys()
      .then((bindings) =>
        setShortcutKeys(bindings.find((binding) => binding.action === "addShortcut")?.keys ?? null),
      )
      .catch(() => setShortcutKeys(null));
  }, [menuOpen, recorder]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [restarted, setRestarted] = useState<number | null>(null);
  const root = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("bar-window");
    return () => document.documentElement.classList.remove("bar-window");
  }, []);

  // Tell the recorder this bar is still showing. If these stop (e.g. the web view crashed),
  // the recording pauses rather than carrying on with no visible indicator. The recorder asks
  // every second and the bar answers: incoming events still run when the bar is covered and
  // page timers are throttled. The timer is a backup.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const beat = () => {
      recorder.heartbeat().catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 1000);
    void recorder
      .onHeartbeatRequest(beat)
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [recorder]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === EXCLUDED_APPS_KEY) setExcludedApps(readExcludedApps());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: Array<() => void> = [];
    void Promise.all([
      recorder.onState(setSnapshot),
      recorder.onFact((fact) => {
        if (fact.record.kind === "state") {
          if (fact.record.state === "elevatedWindow") setElevatedWindow(fact.record.reason);
          if (fact.record.state === "elevatedWindowCleared") setElevatedWindow(null);
        }
        if (
          fact.record.kind === "click" ||
          fact.record.kind === "manual" ||
          fact.record.kind === "appSwitch"
        ) {
          const exe = fact.record.window.exe;
          // Steps' own windows (and their WebView) are never offered for "Never record".
          if (exe && !OWN_PROCESSES.test(exe)) setLastApp(exe);
        }
      }),
    ]).then((stops) => {
      if (cancelled) stops.forEach((stop) => stop());
      else unlisten = stops;
    });
    void recorder.getState().then((current) => {
      if (!cancelled) setSnapshot(current);
    });
    return () => {
      cancelled = true;
      unlisten.forEach((stop) => stop());
    };
  }, [recorder]);

  // Fit the window to what is showing: the pill, plus any open menu or note.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const fit = () => {
      const box = element.getBoundingClientRect();
      recorder.resizeBar(box.width, box.height).catch(() => undefined);
    };
    fit();
    // jsdom (tests) has no ResizeObserver; every desktop WebView does.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [recorder]);

  useEffect(() => {
    if (menuOpen) menu.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [menuOpen]);

  // While a command runs, buttons are marked busy (aria-disabled) and ignore presses, but stay
  // enabled: disabling the focused button would drop keyboard focus to the top of the page.
  const run = async (command: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await command();
      if (result && typeof result === "object" && "state" in result)
        setSnapshot(result as RecorderSnapshot);
    } catch (commandError) {
      setError(errorMessage(commandError, t("recorder.commandFailed")));
    } finally {
      setBusy(false);
    }
  };

  const closeMenu = () => {
    setMenuOpen(false);
    moreButton.current?.focus();
  };

  const alreadyExcluded = excludedApps.some((app) => app.toLowerCase() === lastApp.toLowerCase());
  const excludeLastApp = async () => {
    setSnapshot(await recorder.excludeApp(lastApp));
    if (!alreadyExcluded) {
      // Added to the list as stored now, in case Settings changed it since this bar opened.
      const stored = readExcludedApps();
      const next = stored.some((app) => app.toLowerCase() === lastApp.toLowerCase())
        ? stored
        : [...stored, lastApp];
      setExcludedApps(next);
      try {
        window.localStorage.setItem(EXCLUDED_APPS_KEY, JSON.stringify(next));
      } catch {
        // The running recording keeps the exclusion even when local storage is unavailable.
      }
    }
  };

  const paused = snapshot.state === "paused";
  const stopping = snapshot.state === "stopping";
  const note = paused ? pauseNote(snapshot.reason) : null;
  // The undo for "Start again" lasts until the next step is recorded.
  const showRestarted = restarted !== null && snapshot.stepCount === 0 && snapshot.state !== "idle";
  const stateText = t(`recorder.${snapshot.state}`);

  return (
    <main
      ref={root}
      className="inline-flex max-w-[600px] flex-col items-stretch gap-2 p-2 text-body"
    >
      <div
        role="toolbar"
        aria-label={t("recorder.controls")}
        className="flex h-12 items-center gap-0.5 self-start rounded-full bg-brand-navy pr-1.5 pl-0.5 text-white shadow-[0_6px_18px_var(--amluto-shadow)]"
      >
        <div
          data-tauri-drag-region
          title={t("recorder.dragToMove")}
          aria-hidden="true"
          className="flex h-10 w-[26px] cursor-grab items-center justify-center text-bar-grip"
        >
          <Icon name="grip" size={16} strokeWidth={3.2} className="pointer-events-none" />
        </div>
        <div
          data-tauri-drag-region
          aria-live="polite"
          className="flex min-w-[150px] cursor-grab items-center gap-2 pr-3 pl-1 whitespace-nowrap"
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none size-2.5 rounded-full ${paused || stopping ? "border-2 border-bar-paused" : "bg-bar-live shadow-[0_0_0_4px_var(--amluto-bar-live-halo)]"}`}
          />
          <span className="pointer-events-none text-sm font-bold">{stateText}</span>
          <span className="pointer-events-none text-[13px] text-bar-muted">
            {t("recorder.stepCount", { count: snapshot.stepCount })}
            {snapshot.missedCount > 0
              ? ` · ${t("recorder.missedShort", { count: snapshot.missedCount })}`
              : ""}
          </span>
        </div>
        {snapshot.keysRecorded && (
          // What's typed is being read: said on the bar the whole time (docs/spec/02-capture.md#keys).
          <span
            title={t("recorder.keysRecordedHelp")}
            className={`mr-1.5 inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold whitespace-nowrap ${paused || stopping ? "bg-white/10 text-bar-muted" : "bg-cyan/20 text-cyan"}`}
          >
            <Icon name="keyboard" size={16} />
            {t("recorder.keysRecorded")}
          </span>
        )}
        <span aria-hidden="true" className="mr-1 h-6 w-px bg-white/20" />
        <button
          type="button"
          title={t("recorder.captureNowHint")}
          aria-label={t("recorder.captureNow")}
          aria-disabled={busy || undefined}
          disabled={paused || stopping}
          onClick={() => void run(() => recorder.captureNow())}
          className="inline-flex size-[38px] items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-40"
        >
          <Icon name="camera" size={19} />
        </button>
        <button
          type="button"
          title={paused ? t("recorder.resumeHint") : t("recorder.pauseHint")}
          aria-label={paused ? t("recorder.resume") : t("recorder.pause")}
          aria-disabled={busy || undefined}
          disabled={stopping}
          onClick={() => void run(() => (paused ? recorder.resume() : recorder.pause()))}
          className={`inline-flex h-[34px] items-center justify-center rounded-full disabled:opacity-40 ${paused ? "mx-0.5 gap-1.5 bg-blue pr-3 pl-2.5 text-[13px] font-bold" : "w-[38px] hover:bg-white/10"}`}
        >
          <Icon
            name={paused ? "play" : "pause"}
            size={paused ? 14 : 18}
            strokeWidth={paused ? 1.9 : 3}
            fill={paused ? "currentColor" : "none"}
          />
          {paused && <span aria-hidden="true">{t("recorder.resume")}</span>}
        </button>
        <button
          type="button"
          title={t("recorder.stopHint")}
          aria-label={t("recorder.stop")}
          aria-disabled={busy || undefined}
          disabled={stopping}
          onClick={() => void run(() => recorder.stop())}
          className="inline-flex size-[38px] items-center justify-center rounded-full bg-highlight hover:bg-highlight/90 disabled:opacity-40"
        >
          <Icon name="stop" size={13} fill="currentColor" />
        </button>
        <button
          ref={moreButton}
          type="button"
          aria-label={t("recorder.more")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={stopping}
          onClick={() => {
            setConfirmDiscard(false);
            setMenuOpen((open) => !open);
          }}
          className={`inline-flex h-[38px] w-[34px] items-center justify-center rounded-full disabled:opacity-40 ${menuOpen ? "bg-white/15" : "hover:bg-white/10"}`}
        >
          <Icon name="more" size={18} strokeWidth={3.4} />
        </button>
      </div>

      {menuOpen && (
        <div
          ref={menu}
          role="menu"
          tabIndex={-1}
          aria-label={t("recorder.more")}
          onKeyDown={(event) => {
            const buttons = [
              ...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ??
                []),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape") closeMenu();
            if (event.key === "ArrowDown") buttons[(index + 1) % buttons.length]?.focus();
            if (event.key === "ArrowUp")
              buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
          }}
          className="flex w-[300px] flex-col self-end rounded-xl bg-background p-1.5 shadow-[0_10px_28px_var(--amluto-shadow)]"
        >
          {/* With keys recorded, shortcuts become steps by themselves. */}
          {!snapshot.keysRecorded && (
            <button
              type="button"
              role="menuitem"
              disabled={paused}
              onClick={() => {
                setMenuOpen(false);
                void run(() => recorder.addShortcut());
              }}
              className="flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-subtle disabled:opacity-50"
            >
              <Icon name="keyboard" />
              <span className="flex-1">{t("recorder.addShortcutStep")}</span>
              {shortcutKeys && (
                <span className="text-[11px] text-secondary">
                  {displayKeys(shortcutKeys, i18n.language).join("+")}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={!lastApp || alreadyExcluded}
            onClick={() => {
              setMenuOpen(false);
              void run(excludeLastApp);
            }}
            className="flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-subtle disabled:opacity-50"
          >
            <Icon name="ban" />
            <span className="flex-1">
              {!lastApp
                ? t("recorder.excludeAppEmpty")
                : alreadyExcluded
                  ? t("recorder.appExcluded", { app: lastApp })
                  : t("recorder.excludeApp", { app: lastApp })}
            </span>
          </button>
          <div role="separator" className="mx-1.5 my-1 h-px bg-panel" />
          {/* Moving without dragging (WCAG 2.5.7). Only along the top, where this menu has room
              to open below the bar. */}
          <div
            role="group"
            aria-labelledby="bar-move-label"
            className="flex flex-col gap-1 px-2.5 py-1"
          >
            <span id="bar-move-label" className="text-xs text-secondary">
              {t("recorder.moveBar")}
            </span>
            <div className="flex gap-1">
              {(["left", "centre", "right"] as const).map((place) => (
                <button
                  key={place}
                  type="button"
                  role="menuitem"
                  aria-label={t(`recorder.moveToLabel.${place}`)}
                  onClick={() => {
                    setMenuOpen(false);
                    void recorder
                      .moveBar(place)
                      .catch((problem: unknown) =>
                        setError(errorMessage(problem, t("errors.barMove"))),
                      );
                  }}
                  className="h-8 flex-1 rounded-lg border border-control-line px-2 text-[13px] hover:bg-subtle"
                >
                  {t(`recorder.moveTo.${place}`)}
                </button>
              ))}
            </div>
          </div>
          <div role="separator" className="mx-1.5 my-1 h-px bg-panel" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const before = snapshot.stepCount;
              setMenuOpen(false);
              void run(async () => {
                const next = await recorder.startAgain();
                setRestarted(before);
                return next;
              });
            }}
            className="flex min-h-12 items-center gap-2.5 rounded-lg px-2.5 py-1 text-left text-sm hover:bg-subtle"
          >
            <Icon name="restart" />
            <span className="flex flex-col">
              <span>{t("recorder.startAgain")}</span>
              <span className="text-xs text-secondary">
                {t("recorder.startAgainHelp", { count: snapshot.stepCount })}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setConfirmDiscard(true);
            }}
            className="flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-recording hover:bg-subtle"
          >
            <Icon name="trash" />
            {t("recorder.discard")}
          </button>
        </div>
      )}

      {confirmDiscard && (
        <div
          role="alertdialog"
          aria-labelledby="bar-discard-title"
          className="flex flex-col gap-2 rounded-xl bg-background p-3 shadow-[0_8px_24px_var(--amluto-shadow)]"
        >
          <strong id="bar-discard-title" className="text-sm text-navy">
            {t("recorder.discardConfirmTitle")}
          </strong>
          <span className="text-[13px] text-secondary">{t("recorder.discardConfirmBody")}</span>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              ref={(element) => element?.focus()}
              className="btn h-8"
              onClick={() => setConfirmDiscard(false)}
            >
              {t("recorder.keepRecording")}
            </button>
            <button
              type="button"
              className="btn btn-dark h-8"
              onClick={() => {
                setConfirmDiscard(false);
                void run(() => recorder.discard());
              }}
            >
              {t("recorder.discardConfirm")}
            </button>
          </div>
        </div>
      )}

      {showRestarted && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-xl bg-background py-2 pr-2 pl-3.5 shadow-[0_8px_24px_var(--amluto-shadow)]"
        >
          <span className="flex-1 text-sm">{t("recorder.startedAgain", { count: restarted })}</span>
          <button
            type="button"
            className="btn h-8 text-link"
            onClick={() =>
              void run(async () => {
                const next = await recorder.undoStartAgain();
                setRestarted(null);
                return next;
              })
            }
          >
            {t("common.undo")}
          </button>
        </div>
      )}

      {note && (
        <div
          role="status"
          className="flex gap-3 rounded-xl bg-background px-3.5 py-3 shadow-[0_8px_24px_var(--amluto-shadow)]"
        >
          <Icon name="shield" size={20} className="mt-px shrink-0 text-warning" />
          <div className="flex flex-col gap-0.5">
            <strong className="text-sm text-navy">{t(`recorder.pausedFor.${note}.title`)}</strong>
            <span className="text-[13px] leading-snug text-secondary">
              {t(`recorder.pausedFor.${note}.body`)}
            </span>
            {/* Linux has one way of detecting clicks: nothing to switch to. */}
            {note === "input" && !isLinux(recorder) && (
              <button
                type="button"
                className="mt-1 self-start text-[13px] text-link underline"
                onClick={() =>
                  void run(() =>
                    recorder.setInputSource(
                      snapshot.inputSource === "rawInput" ? "hook" : "rawInput",
                    ),
                  )
                }
              >
                {t("recorder.tryOtherInput")}
              </button>
            )}
          </div>
        </div>
      )}

      {elevatedWindow && (
        <p
          role="status"
          className="rounded-xl bg-background px-3.5 py-2.5 text-[13px] text-secondary shadow-[0_8px_24px_var(--amluto-shadow)]"
        >
          <strong className="block text-navy">
            {t("recorder.elevatedWindow", { title: elevatedWindow })}
          </strong>
          {t("recorder.elevatedWindowHelp")}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-background px-3.5 py-2.5 text-[13px] text-recording shadow-[0_8px_24px_var(--amluto-shadow)]"
        >
          {error}
        </p>
      )}
    </main>
  );
}
