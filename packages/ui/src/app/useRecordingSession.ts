import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordingToDraft, type RecordingData } from "../recorder/recording-to-draft";
import { screenWords } from "../screen-words";
import { useLatest } from "../useLatest";
import { useTranslation } from "react-i18next";
import type { RecordedStep, RecordingFact, RecordingSettings } from "@amluto-steps/core";

import type { ToastMessage } from "../components/Toast";
import type { EditorDoc } from "../editor/document";
import { errorMessage } from "../errors";
import { formatDate } from "../library/dates";
import type { PendingRecording } from "../library/LibraryHome";
import { factToStep, imageFileOf } from "../recorded-step";
import { EMPTY_SNAPSHOT } from "../recorder/RecorderBar";
import { useStepWording } from "../recorder/ShortcutPopup";
import type {
  CaptureMonitor,
  RecorderBridge,
  RecorderSnapshot,
  RecoverySession,
} from "../recorder-bridge";
import { policy } from "../settings/policy";
import { monitorKey, readRecordingSettings } from "../settings/preferences";
import type { StartChoices } from "./dialogs";
import { newGuide, toDoc } from "./documents";
import type { Settings } from "./useSettings";

/** A recording's facts from its journal, with any more of them a window saw, in order. */
const withFacts = (
  journal: readonly RecordingFact[],
  seen: readonly RecordingFact[],
  sessionId: string,
): RecordingFact[] => {
  const known = new Set(journal.map((fact) => fact.sequence));
  const more = seen.filter((fact) => fact.sessionId === sessionId && !known.has(fact.sequence));
  return more.length === 0
    ? [...journal]
    : [...journal, ...more].sort((left, right) => left.sequence - right.sequence);
};

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
  const { t, i18n } = useTranslation();
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
  /**
   * The live recording as this window has it: its facts as they arrived, and the steps that came
   * another way (the shortcut popup's). Its steps are made from these by `recordingToDraft`, as
   * Steps for Chrome's side panel makes the ones it shows, so live and draft can't disagree.
   */
  const liveRef = useRef<{ facts: RecordingFact[]; added: RecordedStep[] }>({
    facts: [],
    added: [],
  });
  /** Steps written to the journal from this window, so none is written twice. */
  const journalledRef = useRef(new Set<string>());
  const forgetLive = () => {
    liveRef.current = { facts: [], added: [] };
    journalledRef.current = new Set();
  };
  const restartRef = useRef<number | null>(null);
  /**
   * The current recording's settings, saved with it when it started; a setting changed during it
   * applies from the next one (docs/spec/02-capture.md#recording-settings).
   */
  const settingsRef = useRef<{ sessionId: string | null; settings: RecordingSettings } | null>(
    null,
  );
  /**
   * A recording's own settings when they're known here; else today's, read once for that
   * recording and kept, so a setting changed during it can't change its later steps, and storage
   * isn't read at every step.
   */
  const settingsOf = (sessionId: string) => {
    const known = settingsRef.current;
    if (known && (known.sessionId === sessionId || known.sessionId === null)) return known.settings;
    const settings = readRecordingSettings();
    settingsRef.current = { sessionId, settings };
    return settings;
  };
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

  /**
   * A recording as its journal holds it, with the settings and wording it was recorded with
   * (`recordingToDraft` makes its steps). The journalled steps carry the popup's shortcuts and the
   * recording's author.
   */
  const loadRecording = async (
    recorder: RecorderBridge,
    sessionId: string,
  ): Promise<Omit<RecordingData, "live" | "words">> => {
    const [facts, journalled, restart, saved] = await Promise.all([
      recorder.getRecoveryRecords(sessionId),
      recorder.getSessionSteps(sessionId),
      recorder.getRestartPoint(sessionId),
      recorder.getRecordingSettings(sessionId),
    ]);
    restartRef.current = restart;
    // A recording made before its settings were saved with it takes today's, read once.
    const settings = saved ?? readRecordingSettings();
    if (settings.wording) wordingRef.current.keep(sessionId, settings.wording);
    if (sessionId === currentSessionId.current) settingsRef.current = { sessionId, settings };
    const wording = wordingRef.current(sessionId);
    return { facts, saved: journalled, restart, wording, settings };
  };

  const addFact = (fact: RecordingFact) => {
    if (fact.record.kind === "manual" && fact.record.purpose === "shortcut") return;
    const live = liveRef.current;
    if (
      !live.facts.some(
        (seen) => seen.sequence === fact.sequence && seen.sessionId === fact.sessionId,
      )
    )
      live.facts = [...live.facts, fact];
    if (restartRef.current !== null && fact.sequence <= restartRef.current) return;
    // Until a reopened recording's own settings have loaded, today's stand in.
    const step = factToStep(fact, wording(fact.sessionId), settingsOf(fact.sessionId));
    // Its own step goes in the journal, which recovery and saving without a draft read.
    if (!step || journalledRef.current.has(step.id)) return;
    journalledRef.current.add(step.id);
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
      const recording = await loadRecording(recorder, sessionId);
      const live = sessionId === currentSessionId.current ? liveRef.current : null;
      const { steps, skipped } = await recordingToDraft({
        ...recording,
        // Every fact this window saw, as well as the journal's (it may have been read before the
        // last ones reached it), so the draft is made as the live steps are.
        facts: live ? withFacts(recording.facts, live.facts, sessionId) : recording.facts,
        live: live ? live.added : [],
        words: screenWords(recorder, (mediaId) =>
          recorder.loadImage(sessionId, imageFileOf(mediaId)),
        ),
      });
      if (skipped > 0) notify({ text: t("recorder.stepsSkipped", { count: skipped }) });
      const author = latest.current.settings.author;
      doc = { guide: newGuide(sessionId, title, author, recording.wording), steps };
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
                forgetLive();
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
              if (journalledRef.current.has(step.id)) return;
              journalledRef.current.add(step.id);
              liveRef.current.added = [...liveRef.current.added, step];
            }),
            // The live steps are kept whole: the draft leaves out what came before the restart
            // point the recorder holds when it opens, so an undone Start again loses nothing.
            recorder.onRestarted(({ sessionId, afterSequence }) => {
              if (sessionId !== currentSessionId.current) return;
              restartRef.current = afterSequence;
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
              // What was journalled before this window (re)loaded, so no step is written twice.
              const [journalled, restart, own] = await Promise.all([
                recorder.getSessionSteps(current.sessionId),
                recorder.getRestartPoint(current.sessionId),
                recorder.getRecordingSettings(current.sessionId).catch(() => null),
              ]);
              if (cancelled) return;
              restartRef.current = restart;
              // The running recording's own settings, saved when it started, for its next steps.
              if (own) {
                settingsRef.current = { sessionId: current.sessionId, settings: own };
                if (own.wording) wordingRef.current.keep(current.sessionId, own.wording);
              }
              for (const step of journalled) journalledRef.current.add(step.id);
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
    // Read once, here, and saved with the recording: its steps are built with these throughout.
    const settings = readRecordingSettings(i18n.language);
    setBusy(true);
    setStartOpen(false);
    forgetLive();
    restartRef.current = null;
    // Its session id is known once the recorder answers; its first facts can arrive before that.
    settingsRef.current = { sessionId: null, settings };
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
          settings,
        },
      );
      currentSessionId.current = next.sessionId;
      settingsRef.current = { sessionId: next.sessionId, settings };
      if (next.sessionId && settings.wording) wording.keep(next.sessionId, settings.wording);
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
    // A draft waiting to be saved doesn't stop a new recording (07/10/2026): it stays with the
    // others.
    if (!recorder || recording || fatal) {
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
        forgetLive();
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
      forgetLive();
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
        forgetLive();
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
