import type { RecordedStep, RecordingFact, RecordingSettings } from "@amluto-steps/core";

export interface RecorderSnapshot {
  state: "idle" | "recording" | "paused" | "degraded" | "stopping";
  reason: string | null;
  sessionId: string | null;
  stepCount: number;
  missedCount: number;
  /** Clicks on a screen Settings > Recording > Monitors leaves out (desktop only). */
  otherScreenClicks?: number;
  inputSource: "rawInput" | "hook";
  /** The recording reads the keyboard ("Record what's typed"). */
  keysRecorded: boolean;
}

export interface CaptureMonitor {
  bounds: { left: number; top: number; right: number; bottom: number };
  /** The main screen. Listed first, as "Screen 1, main". */
  primary: boolean;
  /** The monitor's own name ("DELL U2720Q"), when it gives one. */
  name: string | null;
}

export interface RecorderError {
  code: string;
  message: string;
}

export interface RecorderFinished {
  sessionId: string;
  title: string;
  snapshot: RecorderSnapshot;
}

export interface RecorderStepAdded {
  sessionId: string;
  step: RecordedStep;
}

export interface RecorderRestarted {
  sessionId: string;
  /** Steps from facts up to this sequence were dropped by "Start again"; null after an undo. */
  afterSequence: number | null;
}

/**
 * "Record what's typed", "Include command output", how long output must settle, whether
 * switching apps is a step (the desktop; on when left out), the screenshots' quality (Balanced
 * when left out), and the settings its steps are built with, which the recorder saves with it.
 */
export interface StartOptions {
  keys: boolean;
  output: boolean;
  settleMs: number;
  appSwitchSteps?: boolean;
  quality?: "balanced" | "original";
  settings: RecordingSettings;
}

/**
 * The recording itself, part of the recorder bridge: starting, pausing and stopping it, what it
 * records, and what it reports as it goes. Every change answers the recorder's state as it now
 * is. What a recording leaves behind (its facts, steps, screenshots and draft) is the
 * `RecordingJournal`.
 */
export interface Recording {
  /**
   * Opens the browser edition's recorder beside the page, called straight from a click; null
   * where recording starts from the app itself.
   */
  readonly openRecorder: (() => void) | null;
  getState(): Promise<RecorderSnapshot>;
  onState(handler: (snapshot: RecorderSnapshot) => void): Promise<() => void>;
  onFact(handler: (fact: RecordingFact) => void): Promise<() => void>;
  onFinished(handler: (finished: RecorderFinished) => void): Promise<() => void>;
  onError(handler: (error: RecorderError) => void): Promise<() => void>;
  onStepAdded(handler: (item: RecorderStepAdded) => void): Promise<() => void>;
  onRestarted(handler: (restarted: RecorderRestarted) => void): Promise<() => void>;
  /** The start-recording shortcut was pressed; the main window starts the recording. */
  onStartRequested(handler: () => void): Promise<() => void>;
  /** The recorder asks the bar to answer with a heartbeat (not throttled like page timers). */
  onHeartbeatRequest(handler: () => void): Promise<() => void>;
  /** Starts a recording with the start dialog's choices (docs/spec/02-capture.md#keys). */
  start(title: string, options: StartOptions): Promise<RecorderSnapshot>;
  pause(): Promise<RecorderSnapshot>;
  resume(): Promise<RecorderSnapshot>;
  stop(): Promise<RecorderSnapshot>;
  discard(): Promise<RecorderSnapshot>;
  /** "Start again" on the bar, and its undo (only before anything new is recorded). */
  startAgain(): Promise<RecorderSnapshot>;
  undoStartAgain(): Promise<RecorderSnapshot>;
  setInputSource(source: "rawInput" | "hook"): Promise<RecorderSnapshot>;
  /** Leaves an app (in a browser, a site) out of this and later recordings, or lets it back in. */
  excludeApp(exeName: string): Promise<RecorderSnapshot>;
  includeApp(exeName: string): Promise<RecorderSnapshot>;
  setCaptureMode(mode: "window" | "monitor"): Promise<void>;
  getMonitors(): Promise<CaptureMonitor[]>;
  setTargetMonitor(bounds: CaptureMonitor["bounds"] | null): Promise<void>;
  /** Leaves the recording bar out of screenshots (and all screen capture), or puts it back. */
  setBarHidden(hidden: boolean): Promise<void>;
  captureNow(): Promise<unknown>;
  /** Opens the Add shortcut popup, and closes it. */
  addShortcut(): Promise<unknown>;
  closeShortcutPopup(): Promise<unknown>;
  /** The recorder bar says it is still showing; recording pauses if it goes quiet. */
  heartbeat(): Promise<unknown>;
}
