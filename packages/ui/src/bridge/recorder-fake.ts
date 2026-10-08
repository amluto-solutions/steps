import type { RecordedStep, RecordingFact, RecordingSettings } from "@amluto-steps/core";

import type {
  RecorderError,
  RecorderFinished,
  RecorderRestarted,
  RecorderSnapshot,
  RecorderStepAdded,
  Recording,
} from "./recording";
import type {
  MediaDestination,
  MediaRename,
  RecordingJournal,
  RecoverySession,
} from "./recording-journal";

export const IDLE: RecorderSnapshot = {
  state: "idle",
  reason: null,
  sessionId: null,
  stepCount: 0,
  missedCount: 0,
  inputSource: "rawInput",
  keysRecorded: false,
};

interface Session {
  title: string;
  stopped: boolean;
  facts: RecordingFact[];
  steps: RecordedStep[];
  settings: RecordingSettings | null;
  restartAfter: number | null;
  draft: { guide: unknown; steps: Map<string, unknown> } | null;
  /** Its screenshots, by media id. */
  media: Set<string>;
}

/** The recorder's events, which a test fires as the native side or the background would. */
export interface RecorderEvents {
  state(snapshot: RecorderSnapshot): void;
  fact(fact: RecordingFact): void;
  finished(finished: RecorderFinished): void;
  error(error: RecorderError): void;
  stepAdded(added: RecorderStepAdded): void;
  restarted(restarted: RecorderRestarted): void;
  startRequested(): void;
  heartbeatRequest(): void;
}

export interface FakeRecorder extends Recording, RecordingJournal {
  /** Fires the recorder's events to whoever is listening. */
  readonly fire: RecorderEvents;
  /** A recording left unsaved (for recovery), with its facts and steps. */
  addSession(
    sessionId: string,
    session?: Partial<Pick<Session, "title" | "stopped" | "facts" | "steps" | "settings">> & {
      media?: string[];
    },
  ): void;
  /** Screenshots a recording took (a started one has none until the test says so). */
  addMedia(sessionId: string, mediaIds: string[]): void;
  /** What `copyMedia` copied, in order (a draft's copies are also among its screenshots). */
  readonly copied: { sessionId: string; into: MediaDestination; media: MediaRename[] }[];
}

/**
 * Recording and its journal for tests and the preview, kept in memory. Starting makes a session
 * (`session-1`, `session-2`… unless `sessionIds` names them), whose facts and steps are what the
 * test adds; stopping tells the finished listeners, as both editions do. Screenshots load as
 * `image` (a blank picture unless given). `openRecorder` stands for the browser's side panel; the
 * desktop has none.
 */
export function fakeRecorder(
  options: {
    state?: RecorderSnapshot;
    sessionIds?: string[];
    image?: string;
    openRecorder?: () => void;
  } = {},
): FakeRecorder {
  let snapshot: RecorderSnapshot = { ...(options.state ?? IDLE) };
  let next = 0;
  const sessions = new Map<string, Session>();
  const listeners = {
    state: new Set<(value: RecorderSnapshot) => void>(),
    fact: new Set<(value: RecordingFact) => void>(),
    finished: new Set<(value: RecorderFinished) => void>(),
    error: new Set<(value: RecorderError) => void>(),
    stepAdded: new Set<(value: RecorderStepAdded) => void>(),
    restarted: new Set<(value: RecorderRestarted) => void>(),
    startRequested: new Set<() => void>(),
    heartbeatRequest: new Set<() => void>(),
  };
  const listen =
    <T>(set: Set<T>) =>
    (handler: T) => {
      set.add(handler);
      return Promise.resolve(() => {
        set.delete(handler);
      });
    };
  const fire: RecorderEvents = {
    state: (value) => listeners.state.forEach((handler) => handler(value)),
    fact: (value) => listeners.fact.forEach((handler) => handler(value)),
    finished: (value) => listeners.finished.forEach((handler) => handler(value)),
    error: (value) => listeners.error.forEach((handler) => handler(value)),
    stepAdded: (value) => listeners.stepAdded.forEach((handler) => handler(value)),
    restarted: (value) => listeners.restarted.forEach((handler) => handler(value)),
    startRequested: () => listeners.startRequested.forEach((handler) => handler()),
    heartbeatRequest: () => listeners.heartbeatRequest.forEach((handler) => handler()),
  };
  const become = (change: Partial<RecorderSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    fire.state({ ...snapshot });
    return Promise.resolve({ ...snapshot });
  };
  const answer = () => Promise.resolve({ ...snapshot });
  const session = (sessionId: string) => {
    const found = sessions.get(sessionId);
    return found
      ? Promise.resolve(found)
      : Promise.reject(new Error("That recording is no longer here."));
  };
  const addSession: FakeRecorder["addSession"] = (sessionId, given = {}) => {
    sessions.set(sessionId, {
      title: given.title ?? "Recording",
      stopped: given.stopped ?? true,
      facts: given.facts ?? [],
      steps: given.steps ?? [],
      settings: given.settings ?? null,
      restartAfter: null,
      draft: null,
      media: new Set(given.media ?? []),
    });
  };
  const copied: FakeRecorder["copied"] = [];
  const draftOf = async (sessionId: string) => {
    const found = await session(sessionId);
    if (!found.draft) throw new Error("Open the recording again, then try once more.");
    return found.draft;
  };

  return {
    fire,
    addSession,
    addMedia(sessionId, mediaIds) {
      for (const id of mediaIds) sessions.get(sessionId)?.media.add(id);
    },
    copied,
    openRecorder: options.openRecorder ?? null,
    getState: answer,
    onState: listen(listeners.state),
    onFact: listen(listeners.fact),
    onFinished: listen(listeners.finished),
    onError: listen(listeners.error),
    onStepAdded: listen(listeners.stepAdded),
    onRestarted: listen(listeners.restarted),
    onStartRequested: listen(listeners.startRequested),
    onHeartbeatRequest: listen(listeners.heartbeatRequest),
    start(title, start) {
      next += 1;
      const sessionId = options.sessionIds?.[next - 1] ?? `session-${next}`;
      addSession(sessionId, { title, stopped: false, settings: start.settings });
      return become({
        ...IDLE,
        state: "recording",
        sessionId,
        keysRecorded: start.keys,
      });
    },
    pause: () => become({ state: "paused", reason: "User" }),
    resume: () => become({ state: "recording", reason: null }),
    async stop() {
      const sessionId = snapshot.sessionId;
      const found = sessionId ? sessions.get(sessionId) : undefined;
      const done = await become({ ...IDLE });
      if (sessionId && found) {
        found.stopped = true;
        fire.finished({ sessionId, title: found.title, snapshot: { ...done, sessionId } });
      }
      return done;
    },
    discard() {
      if (snapshot.sessionId) sessions.delete(snapshot.sessionId);
      return become({ ...IDLE });
    },
    startAgain: answer,
    undoStartAgain: answer,
    setInputSource: (source) => become({ inputSource: source }),
    excludeApp: answer,
    includeApp: answer,
    setCaptureMode: () => Promise.resolve(),
    getMonitors: () => Promise.resolve([]),
    setTargetMonitor: () => Promise.resolve(),
    setBarHidden: () => Promise.resolve(),
    captureNow: () => Promise.resolve(),
    addShortcut: () => Promise.resolve(),
    closeShortcutPopup: () => Promise.resolve(),
    heartbeat: () => Promise.resolve(),

    getRecoveries: () =>
      Promise.resolve(
        [...sessions]
          .filter(([sessionId]) => sessionId !== snapshot.sessionId)
          .map(([sessionId, found]): RecoverySession => ({
            sessionId,
            title: found.title,
            eventCount: found.facts.length,
            stopped: found.stopped,
            savedGuideId: null,
          })),
      ),
    async recoverSession(sessionId) {
      const found = await session(sessionId);
      return { ...IDLE, sessionId, stepCount: found.facts.length };
    },
    getRecoveryRecords: async (sessionId) => [...(await session(sessionId)).facts],
    getSessionSteps: async (sessionId) => [...(await session(sessionId)).steps],
    async appendStep(sessionId, step) {
      (await session(sessionId)).steps.push(step);
    },
    getRestartPoint: async (sessionId) => (await session(sessionId)).restartAfter,
    getRecordingSettings: async (sessionId) => (await session(sessionId)).settings,
    loadImage: () => Promise.resolve(options.image ?? "data:image/webp;base64,"),
    retakeDraftImage: () => Promise.resolve({ id: "retake", width: 1280, height: 800 }),
    async copyMedia(sessionId, into, media) {
      const found = await session(sessionId);
      if (media.some((item) => !found.media.has(item.mediaId)))
        throw new Error("The screenshot was not found.");
      if (into.kind === "draft") {
        const target = await session(into.sessionId);
        for (const item of media) target.media.add(item.newMediaId);
      }
      copied.push({ sessionId, into, media: [...media] });
    },
    async finalize(sessionId) {
      await session(sessionId);
      sessions.delete(sessionId);
    },
    async saveDraft(sessionId, guide, steps) {
      (await session(sessionId)).draft = {
        guide,
        steps: new Map(steps.map((step) => [String((step as { id?: unknown }).id), step])),
      };
    },
    async saveDraftGuide(sessionId, guide) {
      const found = await session(sessionId);
      found.draft = { guide, steps: found.draft?.steps ?? new Map() };
    },
    async saveDraftStep(sessionId, step) {
      (await draftOf(sessionId)).steps.set(String((step as { id?: unknown }).id), step);
    },
    async deleteDraftStep(sessionId, stepId) {
      (await session(sessionId)).draft?.steps.delete(stepId);
    },
    async loadDraft(sessionId) {
      const draft = (await session(sessionId)).draft;
      return draft ? { guide: draft.guide, steps: [...draft.steps.values()] } : null;
    },
  };
}
