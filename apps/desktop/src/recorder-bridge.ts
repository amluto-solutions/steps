import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  linkStatusSchema,
  recordingFactSchema,
  recordingSettingsSchema,
  recorderErrorSchema,
  recorderFinishedSchema,
  recorderPreferencesSchema,
  recorderRestartedSchema,
  recorderSnapshotSchema,
  recorderStepAddedSchema,
  recordedStepSchema,
  type RecordedStep,
  type RecordingFact,
} from "@amluto-steps/core";
import type {
  AppWindows,
  Brands,
  ExportFiles,
  ExtensionLink,
  FaceSet,
  Fonts,
  Host,
  HotkeyBinding,
  Hotkeys,
  LinkStatus,
  MediaInfo,
  Policy,
  RecorderBridge,
  RecorderError,
  RecorderFinished,
  RecorderRestarted,
  RecorderSnapshot,
  Recording,
  RecordingJournal,
  RecoverySession,
  SettingsFiles,
  Support,
  TextReader,
  UpdateChannel,
  UpdateInfo,
  Updates,
} from "@amluto-steps/ui";
import { desktopCapabilities } from "./edition";

/**
 * The recorder bridge in the desktop app, one part per small interface, each a thin layer over
 * the Rust commands (`src-tauri/src`). `recorder-bridge.contract.test.ts` runs the bridge's
 * contracts against it over a stand-in for the Rust side that checks every command and argument.
 */

/** The Store package's startup task, as `startup_task_state` reports it. */
type StartupTaskState =
  "enabled" | "disabled" | "disabledByUser" | "enabledByPolicy" | "disabledByPolicy";

/** Header values are ASCII, so paths and names travel as base64 of their UTF-8. */
const header = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const validSnapshot = (snapshot: unknown): RecorderSnapshot =>
  recorderSnapshotSchema.parse(snapshot);

/**
 * Listens to a recorder event, checking its payload against the schema first. A payload that
 * doesn't match is dropped and logged, never handed to the UI (docs/engineering.md, validation).
 */
function listenChecked<T>(
  name: string,
  schema: { safeParse: (value: unknown) => { success: true; data: unknown } | { success: false } },
  handler: (payload: T) => void,
) {
  return listen<unknown>(name, (event) => {
    const parsed = schema.safeParse(event.payload);
    if (parsed.success) handler(parsed.data as T);
    else console.error(`A ${name} event did not match its schema.`);
  });
}

const recording: Recording = {
  // Recording starts from the app itself; there's no recorder to open beside a page.
  openRecorder: null,
  getState: async () => validSnapshot(await invoke<unknown>("recorder_get_state")),
  onState: (handler) =>
    listenChecked<RecorderSnapshot>("recorder:state", recorderSnapshotSchema, handler),
  onFact: (handler) => listenChecked<RecordingFact>("recorder:fact", recordingFactSchema, handler),
  onFinished: (handler) =>
    listenChecked<RecorderFinished>("recorder:finished", recorderFinishedSchema, handler),
  onError: (handler) =>
    listenChecked<RecorderError>("recorder:error", recorderErrorSchema, handler),
  onStepAdded: (handler) =>
    listenChecked<{ sessionId: string; step: RecordedStep }>(
      "recorder:step-added",
      recorderStepAddedSchema,
      handler,
    ),
  onRestarted: (handler) =>
    listenChecked<RecorderRestarted>("recorder:restarted", recorderRestartedSchema, handler),
  onStartRequested: (handler) => listen("recorder:start-requested", () => handler()),
  onHeartbeatRequest: (handler) => listen("recorder:heartbeat-request", () => handler()),
  start: (title, options) => invoke<RecorderSnapshot>("recorder_start", { title, options }),
  pause: () => invoke<RecorderSnapshot>("recorder_pause"),
  resume: () => invoke<RecorderSnapshot>("recorder_resume"),
  stop: () => invoke<RecorderSnapshot>("recorder_stop"),
  discard: () => invoke<RecorderSnapshot>("recorder_discard"),
  startAgain: () => invoke<RecorderSnapshot>("recorder_start_again"),
  undoStartAgain: () => invoke<RecorderSnapshot>("recorder_undo_start_again"),
  setInputSource: (source) => invoke<RecorderSnapshot>("recorder_set_input_source", { source }),
  excludeApp: (exeName) => invoke<RecorderSnapshot>("recorder_exclude_app", { exeName }),
  includeApp: (exeName) => invoke<RecorderSnapshot>("recorder_include_app", { exeName }),
  setCaptureMode: async (mode) => {
    await invoke("recorder_set_capture_mode", { mode });
  },
  getMonitors: () => invoke("recorder_get_monitors"),
  setTargetMonitor: (bounds) => invoke("recorder_set_target_monitor", { bounds }),
  setBarHidden: async (hidden) => {
    await invoke("recorder_set_bar_hidden", { hidden });
  },
  captureNow: () => invoke("recorder_capture_now"),
  addShortcut: () => invoke("recorder_add_shortcut"),
  closeShortcutPopup: () => invoke("recorder_close_shortcut_popup"),
  heartbeat: () => invoke("recorder_bar_heartbeat"),
};

const journal: RecordingJournal = {
  getRecoveries: () => invoke<RecoverySession[]>("recorder_get_recoveries"),
  recoverSession: (sessionId) =>
    invoke<RecorderSnapshot>("recorder_recover_session", { sessionId }),
  getRecoveryRecords: async (sessionId) => {
    const records = await invoke<unknown[]>("recorder_get_recovery_records", { sessionId });
    // A fact this build can't read is left out (and logged), so one odd fact can't stop the
    // whole recording from opening.
    return records.flatMap((record) => {
      const parsed = recordingFactSchema.safeParse(record);
      if (!parsed.success) console.warn("A recorded fact couldn't be read and was left out.");
      return parsed.success ? [parsed.data] : [];
    });
  },
  getSessionSteps: async (sessionId) => {
    const steps = await invoke<unknown[]>("recorder_get_session_steps", { sessionId });
    return steps.map((step) => recordedStepSchema.parse(step));
  },
  appendStep: (sessionId, step) => invoke<unknown>("recorder_append_step", { sessionId, step }),
  getRestartPoint: (sessionId) =>
    invoke<number | null>("recorder_get_restart_point", { sessionId }),
  getRecordingSettings: async (sessionId) => {
    const saved = await invoke<unknown>("recorder_get_recording_settings", { sessionId });
    // Settings this build can't read count as none saved: the recording still opens.
    const parsed = recordingSettingsSchema.safeParse(saved);
    return parsed.success ? parsed.data : null;
  },
  loadImage: (sessionId, name) => invoke<string>("recorder_load_image", { sessionId, name }),
  retakeDraftImage: (sessionId, delayMs, excluded, quality) =>
    invoke<MediaInfo>("recorder_retake_draft_image", { sessionId, delayMs, excluded, quality }),
  finalize: (sessionId, guide, libraryId) =>
    invoke<unknown>("recorder_finalize", { sessionId, guide, libraryId: libraryId ?? null }),
  saveDraft: async (sessionId, guide, steps) => {
    await invoke("recorder_save_draft", { sessionId, guide, steps });
  },
  saveDraftGuide: async (sessionId, guide) => {
    await invoke("recorder_save_draft_guide", { sessionId, guide });
  },
  saveDraftStep: async (sessionId, step) => {
    await invoke("recorder_save_draft_step", { sessionId, step });
  },
  deleteDraftStep: async (sessionId, stepId) => {
    await invoke("recorder_delete_draft_step", { sessionId, stepId });
  },
  loadDraft: (sessionId) =>
    invoke<{ guide: unknown; steps: unknown[] } | null>("recorder_load_draft", { sessionId }),
};

const windows: AppWindows = {
  minimizeMain: async () => {
    await getCurrentWindow().minimize();
  },
  showMain: async () => {
    const main = getCurrentWindow();
    await main.unminimize();
    await main.show();
    await main.setFocus();
  },
  onAlreadyOpen: (handler) => listen("steps://already-open", () => handler()),
  resizeBar: async (width, height) => {
    await getCurrentWindow().setSize(new LogicalSize(Math.ceil(width), Math.ceil(height)));
  },
  moveBar: async (place) => {
    await invoke("recorder_move_bar", { place });
  },
};

const hotkeys: Hotkeys = {
  getHotkeys: () => invoke<HotkeyBinding[]>("hotkeys_get"),
  setHotkey: (action, keys) => invoke<HotkeyBinding[]>("hotkeys_set", { action, keys }),
  resetHotkeys: () => invoke<HotkeyBinding[]>("hotkeys_reset"),
  suspendHotkeys: (suspended) => invoke<HotkeyBinding[]>("hotkeys_suspend", { suspended }),
};

const updates: Updates = {
  updatesChannel: () => invoke<UpdateChannel>("updates_channel"),
  checkForUpdate: () => invoke<UpdateInfo | null>("updates_check"),
  downloadUpdate: () => invoke<string>("updates_download"),
  pendingUpdate: () => invoke<string | null>("updates_pending"),
  installUpdate: async () => {
    await invoke("updates_install");
  },
};

const brands: Brands = {
  listBrands: () => invoke<unknown[]>("brands_list"),
  saveBrand: async (profile) => {
    await invoke("brands_save", { profile });
  },
  saveManagedBrand: async (profile) => {
    await invoke("brands_save_managed", { profile });
  },
  managedBrandIds: () => invoke<string[]>("brands_managed_ids"),
  deleteBrand: async (id) => {
    await invoke("brands_delete", { id });
  },
  readBrandFile: (path) => invoke<string>("brands_read_file", { path }),
  writeBrandFile: async (path, contents) => {
    await invoke("brands_write_file", { path, contents });
  },
};

const fonts: Fonts = {
  getFontFamily: (family) => invoke<FaceSet>("fonts_family", { family }),
  checkFont: (bytes) => invoke("fonts_check", bytes),
  // The PC's fonts are read without asking.
  localFonts: null,
};

const support: Support = {
  createSupportBundle: (settings, libraries, displayName) =>
    invoke<{ path: string; files: string[] }>("support_create_bundle", {
      settings,
      libraries,
      displayName,
    }),
  showSupportBundle: async (path) => {
    await invoke("support_show_bundle", { path });
  },
  openSupportEmail: async (path, folderShown) => {
    await invoke("support_open_email", { path, folderShown });
  },
  openLogsFolder: async () => {
    await invoke("support_open_logs");
  },
  openWebPage: async (page, name) => {
    await invoke("open_web_page", { page, name: name ?? null });
  },
};

const link: ExtensionLink = {
  getLink: async () => linkStatusSchema.parse(await invoke<unknown>("browser_link_get")),
  setLink: async (on) => linkStatusSchema.parse(await invoke<unknown>("browser_link_set", { on })),
  onLink: (handler) => listenChecked<LinkStatus>("browser-link:state", linkStatusSchema, handler),
};

const settingsFiles: SettingsFiles = {
  readSettingsFile: (path) => invoke<string>("settings_read_file", { path }),
  writeSettingsFile: async (path, contents) => {
    await invoke("settings_write_file", { path, contents });
  },
  readBackupFile: (path) => invoke<string>("backup_read_file", { path }),
  writeBackupFile: async (path, contents) => {
    await invoke("backup_write_file", { path, contents });
  },
};

const host: Host = {
  getPreferences: async () =>
    recorderPreferencesSchema.parse(await invoke<unknown>("recorder_get_preferences")),
  setPreferences: async (preferences) =>
    recorderPreferencesSchema.parse(
      await invoke<unknown>("recorder_set_preferences", {
        preferences: recorderPreferencesSchema.parse(preferences),
      }),
    ),
  getPolicy: () => invoke<Policy>("policy_get"),
  // In the Store package Start with Windows is the manifest's startup task; the commands answer
  // null outside a package, where the Run key (the autostart plugin) is used instead.
  isAutoStartEnabled: async () => {
    const state = await invoke<StartupTaskState | null>("startup_task_state");
    return state === null ? isEnabled() : state === "enabled" || state === "enabledByPolicy";
  },
  setAutoStartEnabled: async (enabled) => {
    const state = await invoke<StartupTaskState | null>("startup_task_set", { enabled });
    if (state === null) {
      if (enabled) await enable();
      else await disable();
      return;
    }
    const on = state === "enabled" || state === "enabledByPolicy";
    if (on === enabled) return;
    // Windows keeps the last word: the user's own "off" in Startup apps, or a policy.
    throw state === "disabledByUser"
      ? { code: "startupOffInWindows", message: "Switched off in Windows' Startup apps." }
      : { code: "setByPolicy", message: "Start with Windows is set by the organisation." };
  },
  identityNames: () => invoke<string[]>("identity_names"),
  machineIdentity: () => invoke<{ pc: string; login: string }>("identity_machine"),
};

const textReader: TextReader = {
  readText: (image, blurred = [], at) =>
    invoke("privacy_ocr", image, {
      headers: {
        "x-areas": JSON.stringify(blurred.map(({ x, y, w, h }) => ({ x, y, w, h }))),
        // The click, read again closer up (src-tauri/src/ocr_cache.rs).
        ...(at ? { "x-focus": JSON.stringify({ x: at.x, y: at.y }) } : {}),
      },
    }),
  clearTextCache: async () => {
    await invoke("privacy_clear_ocr_cache");
  },
};

const exportFiles: ExportFiles = {
  writeExport: (path, bytes) =>
    // The raw bytes are the request body; the destination travels base64-encoded in headers.
    invoke<string>("export_write_file", bytes, { headers: { "x-path": header(path) } }),
  writeExportTo: (folder, name, bytes) =>
    invoke<string>("export_write_file", bytes, {
      headers: { "x-folder": header(folder), "x-name": header(name) },
    }),
  defaultExportFolder: () => invoke<string | null>("export_default_folder"),
  showExport: async (path, reveal) => {
    await invoke("export_show", { path, reveal });
  },
  previewWalkthrough: async (html) => {
    await invoke("export_preview", html);
  },
};

export const desktopRecorder: RecorderBridge = {
  capabilities: desktopCapabilities(navigator.userAgent),
  ...recording,
  ...journal,
  ...windows,
  ...hotkeys,
  ...updates,
  ...brands,
  ...fonts,
  ...support,
  ...link,
  ...settingsFiles,
  ...host,
  ...textReader,
  ...exportFiles,
};
