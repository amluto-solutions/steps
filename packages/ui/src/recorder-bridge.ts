import type { Policy } from "./settings/policy";
import type { MediaInfo } from "./library-bridge";
import type { OcrLine, RecordedStep, RecordingFact, RecorderPreferences } from "@amluto-steps/core";

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

export interface RecoverySession {
  sessionId: string;
  title: string;
  eventCount: number;
  stopped: boolean;
  savedGuideId: string | null;
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

export type HotkeyAction = "startRecording" | "togglePause" | "stop" | "captureNow" | "addShortcut";

export interface HotkeyBinding {
  action: HotkeyAction;
  /** `ctrl+alt+shift+k` style, or null when switched off. */
  keys: string | null;
  /** False when Windows refused it (another app already uses the combination). */
  registered: boolean; /** Not registered while another copy of Steps is running, which most likely holds it. */
  heldBySteps?: boolean;
}

export interface FaceSet {
  regular: string | null;
  bold: string | null;
  italic: string | null;
  boldItalic: string | null;
}

export interface RecorderRestarted {
  sessionId: string;
  /** Steps from facts up to this sequence were dropped by "Start again"; null after an undo. */
  afterSequence: number | null;
}

/**
 * Where this copy gets its updates (docs/spec/10-distribution.md#updates-for-the-exe): only the
 * setup .exe's copy checks; the Store and IT (.msi) update the others.
 */
export type UpdateChannel =
  | "checks"
  | "store"
  | "msi"
  | "policy"
  | "portable"
  /** The portable program in a folder it can't write to, so it can't replace itself. */
  | "readOnly"
  | "none";

/**
 * The link between Steps for Windows and Steps for Chrome and Edge on the same PC
 * (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together), as each side sees it.
 */
export interface LinkStatus {
  /** Whether this copy can link at all: not the Store edition, Linux or Firefox. */
  available: boolean;
  enabled: boolean;
  /**
   * Who's connected now: the browsers ("chrome", "edge") on the desktop; "desktop" in the
   * browser once Steps for Windows has answered.
   */
  connected: string[];
  /**
   * Why it isn't working, when it isn't. The desktop: "register" (Chrome and Edge couldn't be
   * told where Steps is), "pipeTaken" (another copy of Steps has the link) or "pipe". The
   * browser: "notInstalled", "notRunning", "protocol" (the two need the same version) or
   * "permission".
   */
  problem: string | null;
}

/** A newer version found at steps.amluto.com. The notes are plain text, never HTML. */
export interface UpdateInfo {
  version: string;
  notes: string | null;
  /** Seconds since 1970. */
  published: number | null;
}

/**
 * "Record what's typed", "Include command output", how long output must settle, whether
 * switching apps is a step (the desktop; on when left out), and the screenshots' quality
 * (Balanced when left out).
 */
export interface StartOptions {
  keys: boolean;
  output: boolean;
  settleMs: number;
  appSwitchSteps?: boolean;
  quality?: "balanced" | "original";
}

/** Whether this is Steps for Chrome, where desktop-only settings are hidden. */
export const isBrowserEdition = (recorder: RecorderBridge | undefined) =>
  recorder?.edition === "browser";

/** Whether this is the desktop app on Linux, where a few Windows-only settings are hidden. */
export const isLinux = (recorder: RecorderBridge | undefined) => recorder?.os === "linux";

export interface RecorderBridge {
  /**
   * "browser" in Steps for Chrome, where what only a desktop has (Start with Windows, library
   * folders, monitors, Windows shortcuts, updates, support files) isn't shown. Absent on the desktop.
   */
  readonly edition?: "browser";
  /**
   * "linux" for the desktop app on Linux (docs/spec/02-capture.md#linux-x11-phase-10): programs
   * are named without `.exe`, and what only Windows has (Start with Windows' own settings page,
   * a second way of detecting clicks, leaving the bar out of screenshots) isn't shown. Absent on
   * Windows.
   */
  readonly os?: "linux";
  /** Opens the browser edition's recorder beside the page. Called straight from a click. */
  openRecorder?: () => void;
  getPreferences(): Promise<RecorderPreferences>;
  setPreferences(preferences: RecorderPreferences): Promise<RecorderPreferences>;
  getState(): Promise<RecorderSnapshot>;
  onState(handler: (snapshot: RecorderSnapshot) => void): Promise<() => void>;
  onFact(handler: (fact: RecordingFact) => void): Promise<() => void>;
  onFinished(handler: (finished: RecorderFinished) => void): Promise<() => void>;
  onError(handler: (error: RecorderError) => void): Promise<() => void>;
  onStepAdded(handler: (item: RecorderStepAdded) => void): Promise<() => void>;
  /** Starts a recording with the start dialog's choices (docs/spec/02-capture.md#keys). */
  start(title: string, options: StartOptions): Promise<RecorderSnapshot>;
  pause(): Promise<RecorderSnapshot>;
  resume(): Promise<RecorderSnapshot>;
  stop(): Promise<RecorderSnapshot>;
  discard(): Promise<RecorderSnapshot>;
  setInputSource(source: "rawInput" | "hook"): Promise<RecorderSnapshot>;
  excludeApp(exeName: string): Promise<RecorderSnapshot>;
  includeApp(exeName: string): Promise<RecorderSnapshot>;
  setCaptureMode(mode: "window" | "monitor"): Promise<void>;
  /** Leaves the recording bar out of screenshots (and all screen capture), or puts it back. */
  setBarHidden(hidden: boolean): Promise<void>;
  /** Moves the recording bar along the top of its screen: a way to move it without dragging. */
  moveBar(place: "left" | "centre" | "right"): Promise<void>;
  isAutoStartEnabled(): Promise<boolean>;
  setAutoStartEnabled(enabled: boolean): Promise<void>;
  getMonitors(): Promise<CaptureMonitor[]>;
  setTargetMonitor(bounds: CaptureMonitor["bounds"] | null): Promise<void>;
  appendStep(sessionId: string, step: RecordedStep): Promise<unknown>;
  /** Publishes a stopped recording to the default library, or to `libraryId` (Save as). */
  finalize(sessionId: string, guide: Record<string, unknown>, libraryId?: string): Promise<unknown>;
  getRecoveries(): Promise<RecoverySession[]>;
  recoverSession(sessionId: string): Promise<RecorderSnapshot>;
  getRecoveryRecords(sessionId: string): Promise<RecordingFact[]>;
  getSessionSteps(sessionId: string): Promise<RecordedStep[]>;
  loadImage(sessionId: string, name: string): Promise<string>;
  /** Retake in an unsaved recording: after `delayMs`, the window in front becomes a new image. */
  /** Retake in an unsaved recording, kept in the quality Settings chose (Balanced when left out). */
  retakeDraftImage(
    sessionId: string,
    delayMs: number,
    excluded: string[],
    quality?: "balanced" | "original",
  ): Promise<MediaInfo>;
  closeShortcutPopup(): Promise<unknown>;
  captureNow(): Promise<unknown>;
  addShortcut(): Promise<unknown>;
  /** The recorder bar says it is still showing; recording pauses if it goes quiet. */
  heartbeat(): Promise<unknown>;
  /** The recorder asks the bar to answer with a heartbeat (not throttled like page timers). */
  onHeartbeatRequest(handler: () => void): Promise<() => void>;

  /** "Start again" on the bar, and its undo (only before anything new is recorded). */
  startAgain(): Promise<RecorderSnapshot>;
  undoStartAgain(): Promise<RecorderSnapshot>;
  getRestartPoint(sessionId: string): Promise<number | null>;
  onRestarted(handler: (restarted: RecorderRestarted) => void): Promise<() => void>;
  /** The start-recording shortcut was pressed; the main window starts the recording. */
  onStartRequested(handler: () => void): Promise<() => void>;
  /** Steps was started again while open; this copy has come forward (desktop only). */
  onAlreadyOpen?(handler: () => void): Promise<() => void>;

  /** A stopped recording’s draft, saved in its private journal until it is published. */
  saveDraft(sessionId: string, guide: unknown, steps: unknown[]): Promise<void>;
  saveDraftGuide(sessionId: string, guide: unknown): Promise<void>;
  saveDraftStep(sessionId: string, step: unknown): Promise<void>;
  deleteDraftStep(sessionId: string, stepId: string): Promise<void>;
  loadDraft(sessionId: string): Promise<{ guide: unknown; steps: unknown[] } | null>;

  getHotkeys(): Promise<HotkeyBinding[]>;
  setHotkey(action: HotkeyAction, keys: string | null): Promise<HotkeyBinding[]>;
  resetHotkeys(): Promise<HotkeyBinding[]>;
  /** Switches every shortcut off (true) while Settings reads new keys, and back on (false). */
  suspendHotkeys(suspended: boolean): Promise<HotkeyBinding[]>;

  /** Fits the recording bar window to its content (the bar grows for menus and notes). */
  resizeBar(width: number, height: number): Promise<void>;
  /** The main window gets out of the way while recording, and comes back after Stop. */
  minimizeMain(): Promise<void>;
  showMain(): Promise<void>;

  /** Reads and writes a `.amlsettings` file chosen with the file dialogs. */
  readSettingsFile(path: string): Promise<string>;
  /** "Back up all" and Restore: `.amlbackup` files only. */
  readBackupFile(path: string): Promise<string>;
  writeBackupFile(path: string, contents: string): Promise<void>;
  /** Reads a `.amlbrand` file the user chose (only `.amlbrand` files). */
  readBrandFile(path: string): Promise<string>;
  writeBrandFile(path: string, contents: string): Promise<void>;
  writeSettingsFile(path: string, contents: string): Promise<void>;

  /** Brand fonts found on this PC (base64 per face), when their licence allows embedding. */
  /** An installed font family's faces whose licence allows embedding them in a PDF. */
  getFontFamily(family: string): Promise<FaceSet>;
  /**
   * Steps for Chrome: whether fonts installed on the computer can be used (Chrome's Local Font
   * Access, asked for once), and asking for them from a click. Absent on the desktop.
   */
  localFonts?: {
    state(): Promise<"granted" | "prompt" | "denied" | "unsupported">;
    allow(): Promise<boolean>;
  };
  /** What an uploaded font file is, and whether its licence allows embedding it. */
  checkFont(bytes: Uint8Array): Promise<{ family: string; subfamily: string; embeddable: boolean }>;
  /** IT policy from the registry (read once; it doesn't change while the app runs). */
  getPolicy(): Promise<Policy>;
  /** The person's own account names, for blur suggestions (desktop only; they stay on the PC). */
  identityNames?(): Promise<string[]>;
  /** Saves an export where the user chose in the save dialog (PDF, Word or web page only). */
  writeExport(path: string, bytes: Uint8Array): Promise<string>;
  /** Saves an export in a folder under a new name (never replacing a file); returns the path. */
  writeExportTo(folder: string, name: string, bytes: Uint8Array): Promise<string>;
  /** The Downloads folder, where exports go unless Settings says otherwise. */
  defaultExportFolder(): Promise<string | null>;
  /** Opens an exported file, or shows it in its folder. */
  showExport(path: string, reveal: boolean): Promise<void>;
  /** Opens a walkthrough page in the default browser (saved in app data, replaced each time). */
  previewWalkthrough(html: Uint8Array): Promise<void>;
  /**
   * Get help: zips the logs, versions and these settings, with library names and paths, the
   * user's name and profile folder replaced. Saved in app data; nothing is sent.
   */
  createSupportBundle(
    settings: string,
    libraries: { name: string; path: string }[],
    displayName: string,
  ): Promise<{ path: string; files: string[] }>;
  /** Shows a support file in its folder. */
  showSupportBundle(path: string): Promise<void>;
  /** Opens a new email in the default mail app (fixed subject and text, no attachment). */
  /**
   * A new email to Amluto support with the support file attached where the mail app allows;
   * otherwise the email, with the file shown in its folder (unless `folderShown`).
   */
  openSupportEmail(path: string, folderShown: boolean): Promise<void>;
  openLogsFolder(): Promise<void>;
  /** amluto.com, or an open-source component's page on crates.io or npm (Settings > About). */
  openWebPage(page: "amluto" | "steps" | "source" | "crate" | "npm", name?: string): Promise<void>;
  /** Where this copy gets its updates. */
  updatesChannel(): Promise<UpdateChannel>;

  /**
   * The link with Steps for Chrome and Edge (the desktop) or with Steps for Windows (the
   * browser). Absent where an edition has none.
   */
  getLink?(): Promise<LinkStatus>;
  /**
   * Switches the link on or off. The desktop passes null at each start for its default (on,
   * except in the portable program); the browser asks for Chrome's permission first, so this is
   * called straight from the click.
   */
  setLink?(on: boolean | null): Promise<LinkStatus>;
  onLink?(handler: (status: LinkStatus) => void): Promise<() => void>;
  /** Asks steps.amluto.com for a newer version; null: this is the newest. */
  checkForUpdate(): Promise<UpdateInfo | null>;
  /** Downloads the version the last check found (signature checked) to install at the next start. */
  downloadUpdate(): Promise<string>;
  /** The downloaded version waiting for the next start, if any. */
  pendingUpdate(): Promise<string | null>;
  /**
   * Restart now: installs the downloaded version straight away (its signature checked again); the
   * app closes and the new version opens. Refused while recording.
   */
  installUpdate(): Promise<void>;

  /** The words in a screenshot, read by Windows OCR on this PC (cached in app data only). */
  /**
   * The words in a screenshot (Windows OCR, cached in app data). Words under `blurred` areas are
   * left out and removed from the cache (docs/spec/03-data-and-sharing.md#ocr-cache).
   */
  readText(
    image: Uint8Array,
    blurred?: { x: number; y: number; w: number; h: number }[],
  ): Promise<OcrLine[]>;
  clearTextCache(): Promise<void>;

  /** Client brand profiles kept on this PC (unvalidated JSON; the UI checks the schema). */
  listBrands(): Promise<unknown[]>;
  saveBrand(profile: unknown): Promise<void>;
  /** Saves a brand the organisation deploys (the start-up sync only; others are refused). */
  saveManagedBrand(profile: unknown): Promise<void>;
  deleteBrand(id: string): Promise<void>;
}
