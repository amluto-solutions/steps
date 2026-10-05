import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nameFromScreen } from "../recorder/screen-names";
import { dataUrlBytes } from "../editor/suggestions";
import { useLatest } from "../useLatest";
import { useTranslation } from "react-i18next";
import {
  parseStep,
  type GuideStep,
  type RecordedStep,
  type RecordingFact,
} from "@amluto-steps/core";

import type { ToastMessage } from "../components/Toast";
import type { EditorDoc } from "../editor/document";
import { sortSteps } from "../editor/document";
import { errorMessage } from "../errors";
import { formatDate } from "../library/dates";
import type { PendingRecording } from "../library/LibraryHome";
import {
  applyDrags,
  dropReplacedValues,
  dropTrailingOpens,
  borrowScreenshots,
  factToStep,
  imageFileOf,
  orderRecordedSteps,
} from "../recorded-step";
import { EMPTY_SNAPSHOT } from "../recorder/RecorderBar";
import { useStepWording } from "../recorder/ShortcutPopup";
import type {
  CaptureMonitor,
  RecorderBridge,
  RecorderSnapshot,
  RecoverySession,
} from "../recorder-bridge";
import { policy } from "../settings/policy";
import { monitorKey } from "../settings/preferences";
import type { StartChoices } from "./dialogs";
import { afterRestart, mergeRecordedSteps, newGuide, toDoc } from "./documents";
import type { Settings } from "./useSettings";

/** What the session needs from the rest of the app; read at the moment it's used. */
export interface RecordingSessionContext {
  recorder: RecorderBridge | undefined;
  notify: (message: Omit<ToastMessage, "id">) => void;
  settings: Settings;
  setBusy: (busy: boolean) => void;
  /** A stopped recording is ready to edit as a draft. */
  showDraft: (sessionId: string, doc: EditorDoc) => void;
  /** Back to the guides (a recording started, or one was discarded). */
  showGuides: () => void;
  /** A recording became a guide in the library: show it. */
  /** Opens a guide just saved, in `libraryId` (else the default library). */
  openSaved: (guideId: string, libraryId?: string) => Promise<void>;
  /** The rest of start-up, once the recorder is set up (libraries, brands). */
  onConnected: () => Promise<void>;
}

/**
 * The recording session (docs/spec/02-capture.md): the recorder's events, starting a recording,
 * facts becoming draft steps as they arrive (journalled in order), the draft opening when it
 * stops, and the unsaved recordings with Review and save, Save guide and Discard.
 *
 * The recorder's events are registered once for the life of the window, so they reach the latest
 * state through refs rather than the values of the render they were registered in.
 */
export function useRecordingSession(context: RecordingSessionContext) {
  const { t } = useTranslation();
  const wording = useStepWording();
  const wordingRef = useLatest(wording);
  const { recorder, notify, setBusy } = context;
  const latest = useLatest(context);

  const [snapshot, setSnapshot] = useState<RecorderSnapshot>(EMPTY_SNAPSHOT);
  const [monitors, setMonitors] = useState<CaptureMonitor[]>([]);
  const [recoveries, setRecoveries] = useState<RecoverySession[]>([]);
  const [startOpen, setStartOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<PendingRecording | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const stepsRef = useRef<RecordedStep[]>([]);
  const restartRef = useRef<number | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const discardRequested = useRef(false);
  const currentSessionId = useRef<string | null>(null);
  const startRef = useRef<() => void>(() => undefined);
  const openDraftRef = useRef<(sessionId: string, title: string) => Promise<void>>(
    async () => undefined,
  );

  const refreshRecoveries = useCallback(async () => {
    if (!recorder) return;
    setRecoveries(await recorder.getRecoveries());
  }, [recorder]);

  // ----- Facts become draft steps as they arrive -----

  /** A recording's steps from its journal, with the facts they came from. */
  const loadRecording = useCallback(
    async (sessionId: string): Promise<{ steps: RecordedStep[]; facts: RecordingFact[] }> => {
      if (!recorder) return { steps: [], facts: [] };
      const [facts, persisted, restart] = await Promise.all([
        recorder.getRecoveryRecords(sessionId),
        recorder.getSessionSteps(sessionId),
        recorder.getRestartPoint(sessionId),
      ]);
      restartRef.current = restart;
      const fromFacts = facts
        .map((fact) => factToStep(fact, wordingRef.current()))
        .filter((step): step is RecordedStep => step !== null);
      // Persisted steps carry popup-only shortcuts and the recording author.
      return { steps: afterRestart(mergeRecordedSteps(fromFacts, persisted), restart), facts };
    },
    [recorder, wordingRef],
  );
  const restoreSteps = useCallback(
    async (sessionId: string) => (await loadRecording(sessionId)).steps,
    [loadRecording],
  );

  const addFact = (fact: RecordingFact) => {
    if (fact.record.kind === "manual" && fact.record.purpose === "shortcut") return;
    if (restartRef.current !== null && fact.sequence <= restartRef.current) return;
    const step = factToStep(fact, wording());
    if (!step || stepsRef.current.some((current) => current.id === step.id)) return;
    stepsRef.current = [...stepsRef.current, step];
    writeQueue.current = writeQueue.current
      .then(() => recorder?.appendStep(fact.sessionId, step))
      .then(() => undefined)
      .catch(() => notify({ kind: "error", text: t("recorder.saveFailed") }));
  };
  const addFactRef = useLatest(addFact);

  /** Opens a stopped recording in the editor as a draft, saving the draft on first open. */
  const openDraft = async (sessionId: string, title: string) => {
    if (!recorder) return;
    const saved = await recorder.loadDraft(sessionId);
    let doc: EditorDoc;
    if (saved) {
      doc = toDoc(saved);
    } else {
      const restored = await loadRecording(sessionId);
      const live =
        sessionId === currentSessionId.current
          ? afterRestart(stepsRef.current, restartRef.current)
          : [];
      // A step that doesn't fit the format (say, from before a limit existed) is left out and
      // reported, rather than stopping the whole recording from opening.
      const steps: GuideStep[] = [];
      let skipped = 0;
      const merged = applyDrags(
        dropReplacedValues(mergeRecordedSteps(restored.steps, live), restored.facts),
        restored.facts,
      );
      const ordered = borrowScreenshots(
        dropTrailingOpens(orderRecordedSteps(merged, restored.facts)),
      );
      for (const step of ordered) {
        try {
          steps.push(parseStep(step));
        } catch {
          skipped += 1;
        }
      }
      if (skipped > 0) notify({ text: t("recorder.stepsSkipped", { count: skipped }) });
      const author = latest.current.settings.author;
      // Clicks the app didn't name are named from their screenshots' words (F016).
      const named = await nameFromScreen(
        steps,
        async (mediaId) =>
          recorder.readText(
            dataUrlBytes(await recorder.loadImage(sessionId, imageFileOf(mediaId))),
          ),
        wordingRef.current(),
      );
      doc = {
        guide: newGuide(sessionId, title, author, wordingRef.current()),
        steps: sortSteps(named),
      };
      await writeQueue.current;
      await recorder.saveDraft(sessionId, doc.guide, doc.steps);
    }
    currentSessionId.current = sessionId;
    latest.current.showDraft(sessionId, doc);
  };
  useEffect(() => {
    openDraftRef.current = openDraft;
  });

  // ----- The recorder's events, and start-up -----

  useEffect(() => {
    if (!recorder) return;
    let cancelled = false;
    let unlisten: Array<() => void> = [];
    void (async () => {
      let connected = false;
      // The WebView can ask for recorder state while native setup is still finishing. Only the
      // recorder's own set-up is retried here; the rest of start-up follows once it answers.
      for (let attempt = 0; attempt < 4 && !cancelled && !connected; attempt += 1) {
        try {
          const registrations = await Promise.allSettled([
            recorder.onState((next) => setSnapshot(next)),
            recorder.onFact((fact) => addFactRef.current(fact)),
            recorder.onFinished((finished) => {
              setSnapshot(finished.snapshot);
              // Clicks on a screen left out made no steps: an empty draft said nothing of why.
              const otherScreens = finished.snapshot.otherScreenClicks ?? 0;
              if (otherScreens > 0 && !discardRequested.current)
                notify({ text: t("recorder.otherScreens", { count: otherScreens }) });
              currentSessionId.current = finished.snapshot.sessionId;
              void recorder.showMain().catch(() => undefined);
              if (discardRequested.current) {
                discardRequested.current = false;
                stepsRef.current = [];
                void refreshRecoveries();
                return;
              }
              if (finished.snapshot.sessionId) {
                void openDraftRef
                  .current(finished.snapshot.sessionId, finished.title)
                  .catch(() => notify({ kind: "error", text: t("recorder.saveFailed") }));
              }
            }),
            recorder.onError((problem) =>
              notify({ kind: "error", text: errorMessage(problem, t("recorder.commandFailed")) }),
            ),
            recorder.onStepAdded(({ sessionId, step }) => {
              if (sessionId !== currentSessionId.current) return;
              if (stepsRef.current.some((current) => current.id === step.id)) return;
              stepsRef.current = [...stepsRef.current, step];
            }),
            recorder.onRestarted(({ sessionId, afterSequence }) => {
              if (sessionId !== currentSessionId.current) return;
              restartRef.current = afterSequence;
              if (afterSequence === null) {
                void restoreSteps(sessionId).then((steps) => {
                  stepsRef.current = mergeRecordedSteps(steps, stepsRef.current);
                });
              } else {
                stepsRef.current = afterRestart(stepsRef.current, afterSequence);
              }
            }),
            recorder.onStartRequested(() => startRef.current()),
          ]);
          const listeners = registrations.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          );
          const failed = registrations.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failed || cancelled) {
            listeners.forEach((stop) => stop());
            if (cancelled) return;
            throw failed?.reason;
          }
          unlisten = listeners;
          const current = await recorder.getState();
          setSnapshot(current);
          if (current.sessionId) {
            currentSessionId.current = current.sessionId;
            const sessions = await recorder.getRecoveries();
            if (cancelled) return;
            const session = sessions.find((item) => item.sessionId === current.sessionId);
            if (!session?.savedGuideId) {
              const restored = await restoreSteps(current.sessionId);
              if (cancelled) return;
              stepsRef.current = mergeRecordedSteps(restored, stepsRef.current);
            }
          }
          // The recorder's own settings: native set-up may still be finishing, so these are
          // retried with the rest.
          const { settings } = latest.current;
          settings.setPreferences(await recorder.getPreferences());
          // Retake captures the way recordings do, so the saved choice is set from the start,
          // not only when a recording begins. Refused (and fine) if one is already running.
          await recorder.setCaptureMode(settings.choices.captureMode).catch(() => undefined);
          await recorder.setBarHidden(settings.choices.hideRecorderBar).catch(() => undefined);
          try {
            // IT policy can switch Start with Windows on or off for everyone.
            const managedAutoStart = policy().autoStart;
            if (managedAutoStart !== null) {
              await recorder.setAutoStartEnabled(managedAutoStart).catch(() => undefined);
            }
            settings.setAutoStart(await recorder.isAutoStartEnabled());
          } catch {
            settings.setAutoStart(false);
          }
          connected = true;
        } catch {
          unlisten.forEach((stop) => stop());
          unlisten = [];
          if (cancelled) return;
          if (attempt === 3) setFatal(t("recorder.initializationFailed"));
          else await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!connected || cancelled) return;
      try {
        setMonitors(await recorder.getMonitors());
      } catch {
        setMonitors([]);
      }
      // A library or brand that can't be read is reported; it never undoes the recorder's set-up.
      await Promise.all([refreshRecoveries(), latest.current.onConnected()]).catch(
        (problem: unknown) =>
          notify({ kind: "error", text: errorMessage(problem, t("library.loadFailed")) }),
      );
    })();
    return () => {
      cancelled = true;
      unlisten.forEach((stop) => stop());
    };
    // The bridges are stable for the life of the desktop window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder]);

  // ----- Starting a recording -----

  const hasPending = snapshot.sessionId !== null;
  const recording = snapshot.state !== "idle";

  // The start shortcut fires once per press, so a double press would start twice: the second
  // gets "already recording", shows a stray message and clears Busy while the first still runs.
  const starting = useRef(false);
  const startRecording = async (start: StartChoices) => {
    if (!recorder || starting.current) return;
    starting.current = true;
    const { choices } = latest.current.settings;
    setBusy(true);
    setStartOpen(false);
    stepsRef.current = [];
    restartRef.current = null;
    writeQueue.current = Promise.resolve();
    try {
      await recorder.setCaptureMode(choices.captureMode);
      // Not worth refusing a recording over: the bar would just show in screenshots.
      await recorder.setBarHidden(choices.hideRecorderBar).catch(() => undefined);
      const target = monitors.find(
        (monitor) => monitorKey(monitor.bounds) === choices.targetMonitor,
      );
      await recorder.setTargetMonitor(target?.bounds ?? null);
      await Promise.all(choices.excludedApps.map((exeName) => recorder.excludeApp(exeName)));
      const next = await recorder.start(
        t("recorder.defaultTitle", { date: formatDate(new Date()) }),
        {
          ...start,
          settleMs: choices.outputSettleMs,
          appSwitchSteps: choices.appSwitchSteps,
          quality: choices.screenshotQuality,
        },
      );
      currentSessionId.current = next.sessionId;
      setSnapshot(next);
      latest.current.showGuides();
      void recorder.minimizeMain().catch(() => undefined);
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("recorder.errorTitle")) });
    } finally {
      starting.current = false;
      setBusy(false);
    }
  };

  const requestRecording = () => {
    // In the browser, recording starts from the side panel, beside the page to record.
    if (recorder?.openRecorder) {
      recorder.openRecorder();
      return;
    }
    if (!recorder || recording || hasPending || fatal) {
      if (hasPending && !recording) notify({ text: t("nav.saveFirst") });
      return;
    }
    // Each recording asks (its boxes start as Settings or IT say), unless IT has switched keys off.
    if (policy().disableKeystrokeRecording) {
      void startRecording({ keys: false, output: false });
      return;
    }
    void recorder.showMain().catch(() => undefined);
    setStartOpen(true);
  };
  useEffect(() => {
    startRef.current = requestRecording;
  });

  // ----- Unsaved recordings: review, save, discard -----

  const pending: PendingRecording[] = useMemo(
    () =>
      recoveries
        .filter((session) => !(recording && session.sessionId === snapshot.sessionId))
        .map((session) => ({
          sessionId: session.sessionId,
          title: session.title,
          stepCount: session.sessionId === snapshot.sessionId ? snapshot.stepCount : null,
          savedGuideId: session.savedGuideId,
        })),
    [recoveries, recording, snapshot.sessionId, snapshot.stepCount],
  );

  const reviewPending = async (item: PendingRecording) => {
    if (!recorder) return;
    setBusy(true);
    try {
      if (item.savedGuideId) {
        // Publication finished before an interruption; only the journal cleanup remains.
        await recorder.finalize(item.sessionId, { id: item.savedGuideId });
        await refreshRecoveries();
        await latest.current.openSaved(item.savedGuideId);
        return;
      }
      if (snapshot.sessionId !== item.sessionId) {
        setSnapshot(await recorder.recoverSession(item.sessionId));
        currentSessionId.current = item.sessionId;
        stepsRef.current = [];
      }
      await openDraft(item.sessionId, item.title);
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("recorder.saveFailed")) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Save guide: the draft (with the editor's pending edits) becomes a guide in the library. `quiet`
   * leaves the "saved" message to the caller (an export says so in its own). True once saved.
   */
  /**
   * Save: the recording becomes a guide in the default library, or in `libraryId` when Save as
   * chose another, `target` (a one-off; the default stays).
   */
  const saveDraft = async (
    sessionId: string,
    flush: () => Promise<void>,
    doc: EditorDoc,
    quiet = false,
    target?: { id: string; name: string },
  ): Promise<boolean> => {
    if (!recorder) return false;
    setBusy(true);
    try {
      await flush();
      await writeQueue.current;
      const guide = { ...doc.guide, updatedAt: new Date().toISOString() };
      await recorder.finalize(sessionId, guide, target?.id);
      currentSessionId.current = null;
      stepsRef.current = [];
      setSnapshot((current) => ({ ...current, sessionId: null, stepCount: 0, missedCount: 0 }));
      await refreshRecoveries();
      await latest.current.openSaved(sessionId, target?.id);
      if (!quiet)
        notify({
          text: target ? t("editor.savedTo", { name: target.name }) : t("editor.savedToLibrary"),
        });
      return true;
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("recorder.saveFailed")) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const discard = async (item: PendingRecording) => {
    if (!recorder) return;
    setDiscardTarget(null);
    setBusy(true);
    try {
      if (snapshot.sessionId !== item.sessionId && snapshot.state === "idle") {
        await recorder.recoverSession(item.sessionId);
      }
      discardRequested.current = snapshot.state !== "idle";
      const next = await recorder.discard();
      setSnapshot(next);
      if (next.state === "idle") {
        stepsRef.current = [];
        currentSessionId.current = null;
        await refreshRecoveries();
        latest.current.showGuides();
      }
    } catch (problem) {
      discardRequested.current = false;
      notify({ kind: "error", text: errorMessage(problem, t("recorder.errorTitle")) });
    } finally {
      setBusy(false);
    }
  };

  return {
    snapshot,
    setSnapshot,
    monitors,
    recording,
    hasPending,
    pending,
    fatal,
    refreshRecoveries,
    requestRecording,
    startRecording,
    reviewPending,
    saveDraft,
    startOpen,
    closeStart: () => setStartOpen(false),
    discardTarget,
    setDiscardTarget,
    discard,
  };
}
