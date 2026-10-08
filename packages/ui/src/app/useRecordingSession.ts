import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordingToDraft, type RecordingData } from "../recorder/recording-to-draft";
import { screenWords } from "../screen-words";
import { useLatest } from "../useLatest";
import { useTranslation } from "react-i18next";
import type { RecordedStep, RecordingFact, RecordingSettings } from "@amluto-steps/core";

import type { ToastMessage } from "../components/Toast";
import type { MediaDestination } from "../bridge/recording-journal";
import type { EditorDoc } from "../editor/document";
import { withNewIds, type RecordAt, type StepInserter } from "../editor/record-here";
import { newId } from "../editor/step-menus";
import { errorMessage } from "../errors";
import { readRecordingInto, writeRecordingInto } from "../recorder/recording-into";
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

/**
 * A recording going into the guide open in the editor (Record steps here,
 * docs/spec/04-editor.md#record-steps-here) rather than becoming a draft of its own.
 */
export interface RecordInto extends RecordAt {
  /** The guide's title, for the start dialog and the recording bar. */
  title: string;
  /** The guide: where its screenshots go, and whose editor takes the steps. */
  guide: MediaDestination;
}

/** What the session needs from the rest of the app; read at the moment it's used. */
export interface RecordingSessionContext {
  /** The editor open on `guide`, while it's open; null once it has closed. */
  inserterFor: (guide: MediaDestination) => StepInserter | null;
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

  // ----- Record steps here (docs/spec/04-editor.md#record-steps-here) -----

  /**
   * The guide the next recording goes into (`sessionId` null) or the running one does. Shared
   * with the recording bar and the side panel through local storage, under `token`.
   */
  const intoRef = useRef<{ into: RecordInto; token: string; sessionId: string | null } | null>(
    null,
  );
  /** The guide's title while the start dialog asks about a recording into it. */
  const [startInto, setStartInto] = useState<string | null>(null);

  /** The next recording goes into `into`, or (undefined) is one of its own. */
  const askInto = (into: RecordInto | undefined) => {
    // A recording already going into a guide keeps it.
    if (intoRef.current?.sessionId) return;
    const token = newId("into");
    intoRef.current = into ? { into, token, sessionId: null } : null;
    writeRecordingInto(into ? { token, title: into.title, sessionId: null } : null);
    setStartInto(into?.title ?? null);
  };

  /**
   * Forgets the guide a recording was to go into (it went in, or never will), the one this window
   * knows or the one asked for under `token`.
   */
  const forgetInto = (token = intoRef.current?.token) => {
    if (intoRef.current?.token === token) intoRef.current = null;
    setStartInto(null);
    if (token && readRecordingInto()?.token === token) writeRecordingInto(null);
  };

  /**
   * A recording started: the one asked for goes into the guide, unless the side panel's "Record
   * a new guide instead" took it back, or the guide's editor has closed since.
   */
  const bindInto = (sessionId: string) => {
    const waiting = intoRef.current;
    if (!waiting || waiting.sessionId !== null) return;
    if (
      readRecordingInto()?.token !== waiting.token ||
      !latest.current.inserterFor(waiting.into.guide)
    ) {
      forgetInto();
      return;
    }
    intoRef.current = { ...waiting, sessionId };
    writeRecordingInto({ token: waiting.token, title: waiting.into.title, sessionId });
  };
  const bindIntoRef = useLatest(bindInto);
  const forgetIntoRef = useLatest(forgetInto);

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

  /**
   * A stopped recording leaves the journal once its steps are in a guide: it was never a guide
   * of its own.
   */
  const forgetRecording = async (sessionId: string) => {
    if (!recorder || currentSessionId.current !== sessionId) return;
    setSnapshot(await recorder.discard());
    forgetLive();
    currentSessionId.current = null;
    await refreshRecoveries();
  };

  /**
   * Record steps here, when the recording stops: its steps, made as a draft's are, go into the
   * open guide after the chosen step as one undo step, with their screenshots copied into the
   * guide's own storage first. If the guide's editor has closed or lost its edit lock, nothing
   * is lost: the recording opens as a draft of its own, and says why. Its journal goes only once
   * the guide has the steps on disk, so a crash before then leaves it as an unsaved recording.
   */
  const insertRecording = async (sessionId: string, title: string, into: RecordInto) => {
    if (!recorder) return;
    const ready = () => {
      const inserter = latest.current.inserterFor(into.guide);
      return inserter?.canInsert() ? inserter : null;
    };
    const ownDraft = async () => {
      await openDraft(sessionId, title);
      notify({ text: t("recorder.intoFallback", { title: into.title }) });
    };
    if (!ready()) return ownDraft();
    setBusy(true);
    try {
      const recording = await loadRecording(recorder, sessionId);
      const live = sessionId === currentSessionId.current ? liveRef.current : null;
      const { steps, skipped } = await recordingToDraft({
        ...recording,
        facts: live ? withFacts(recording.facts, live.facts, sessionId) : recording.facts,
        live: live ? live.added : [],
        words: screenWords(recorder, (mediaId) =>
          recorder.loadImage(sessionId, imageFileOf(mediaId)),
        ),
      });
      if (skipped > 0) notify({ text: t("recorder.stepsSkipped", { count: skipped }) });
      await writeQueue.current;
      if (steps.length === 0) {
        await forgetRecording(sessionId);
        notify({ text: t("recorder.intoNothing", { title: into.title }) });
        return;
      }
      const fresh = withNewIds(steps, newId);
      try {
        await recorder.copyMedia(sessionId, into.guide, fresh.media);
      } catch {
        return await ownDraft();
      }
      const inserter = ready();
      if (!inserter?.insert(fresh.steps, into)) return await ownDraft();
      try {
        await inserter.flush();
      } catch {
        // Not on disk yet (the editor says so and keeps trying): the recording stays until it is.
        return;
      }
      await forgetRecording(sessionId);
    } finally {
      setBusy(false);
    }
  };
  const insertRecordingRef = useLatest(insertRecording);

  // ----- The recorder's events, and start-up -----

  useEffect(() => {
    if (!recorder) return;
    // Left by a window that has gone (reloaded mid-recording, say): no editor here asked for it,
    // so its recording opens as a draft of its own, and the bar shouldn't say otherwise.
    if (!intoRef.current) writeRecordingInto(null);
    let cancelled = false;
    let unlisten: Array<() => void> = [];
    void (async () => {
      let connected = false;
      // The WebView can ask for recorder state while native setup is still finishing. Only the
      // recorder's own set-up is retried here; the rest of start-up follows once it answers.
      for (let attempt = 0; attempt < 4 && !cancelled && !connected; attempt += 1) {
        try {
          const registrations = await Promise.allSettled([
            recorder.onState((next) => {
              setSnapshot(next);
              // In the browser the side panel starts it: this is how this window hears of it.
              if (next.state !== "idle" && next.sessionId) bindIntoRef.current(next.sessionId);
              // Discarded while it ran: it has gone, and nothing will go into the guide.
              const bound = intoRef.current?.sessionId;
              if (next.state === "idle" && bound && next.sessionId !== bound)
                forgetIntoRef.current();
            }),
            recorder.onFact((fact) => addFactRef.current(fact)),
            recorder.onFinished((finished) => {
              setSnapshot(finished.snapshot);
              // Clicks on a screen left out made no steps: an empty draft said nothing of why.
              const otherScreens = finished.snapshot.otherScreenClicks ?? 0;
              if (otherScreens > 0 && !discardRequested.current)
                notify({ text: t("recorder.otherScreens", { count: otherScreens }) });
              currentSessionId.current = finished.snapshot.sessionId;
              void recorder.showMain().catch(() => undefined);
              const into = intoRef.current;
              const intoThis = into && into.sessionId === finished.sessionId ? into : null;
              // Discarded from the bar, it finishes with no session left: nothing goes in.
              // Otherwise the bar and side panel keep saying where its steps are going until
              // they're there.
              if (intoThis) {
                intoRef.current = null;
                if (!finished.snapshot.sessionId || discardRequested.current)
                  forgetIntoRef.current(intoThis.token);
              }
              if (discardRequested.current) {
                discardRequested.current = false;
                forgetLive();
                void refreshRecoveries();
                return;
              }
              if (intoThis && finished.snapshot.sessionId) {
                void insertRecordingRef
                  .current(finished.snapshot.sessionId, finished.title, intoThis.into)
                  .catch(() => notify({ kind: "error", text: t("recorder.saveFailed") }))
                  .finally(() => forgetIntoRef.current(intoThis.token));
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
    const into = intoRef.current?.sessionId === null ? intoRef.current.into : null;
    try {
      // An unsaved recording can't be written while another records: its editor's last edits
      // are written now.
      if (into)
        await latest.current
          .inserterFor(into.guide)
          ?.flush()
          .catch(() => undefined);
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
      if (next.sessionId) bindInto(next.sessionId);
      setSnapshot(next);
      // Recording into the guide open, its editor stays (minimised) with the guide's edit lock.
      if (!intoRef.current?.sessionId) latest.current.showGuides();
      void recorder.minimizeMain().catch(() => undefined);
    } catch (problem) {
      forgetInto();
      notify({ kind: "error", text: errorMessage(problem, t("recorder.errorTitle")) });
    } finally {
      starting.current = false;
      setBusy(false);
    }
  };

  /**
   * New recording, or with `into`, Record steps here: the recording's steps go into the guide
   * open in the editor when it stops.
   */
  const askToRecord = (into?: RecordInto) => {
    // In the browser, recording starts from the side panel, beside the page to record.
    if (recorder?.openRecorder) {
      if (!recording) askInto(into);
      recorder.openRecorder();
      return;
    }
    // A draft waiting to be saved doesn't stop a new recording (07/10/2026): it stays with the
    // others.
    if (!recorder || recording || fatal) {
      return;
    }
    askInto(into);
    // Each recording asks (its boxes start as Settings or IT say), unless IT has switched keys off.
    if (policy().disableKeystrokeRecording) {
      void startRecording({ keys: false, output: false });
      return;
    }
    void recorder.showMain().catch(() => undefined);
    setStartOpen(true);
  };
  /** New recording: one of its own. */
  const requestRecording = () => askToRecord();
  /** Record steps here: the recording's steps go into the guide open when it stops. */
  const recordHere = (into: RecordInto) => askToRecord(into);
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
      if (intoRef.current?.sessionId === item.sessionId) forgetInto();
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
    pending,
    fatal,
    refreshRecoveries,
    requestRecording,
    recordHere,
    startRecording,
    reviewPending,
    saveDraft,
    startOpen,
    closeStart: () => {
      setStartOpen(false);
      forgetInto();
    },
    startInto,
    discardTarget,
    setDiscardTarget,
    discard,
  };
}
