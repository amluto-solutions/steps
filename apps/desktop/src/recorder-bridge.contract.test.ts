// @vitest-environment jsdom
import { emit } from "@tauri-apps/api/event";
import { NO_POLICY, type RecorderBridge } from "@amluto-steps/ui";
import {
  appWindowsContract,
  brandsContract,
  exportFilesContract,
  extensionLinkContract,
  fontsContract,
  hostContract,
  hotkeysContract,
  recordingContract,
  recordingJournalContract,
  SCREEN_WORDS,
  settingsFilesContract,
  supportContract,
  textReaderContract,
  updatesContract,
  type Subject,
} from "@amluto-steps/ui/contracts";
import { DEFAULT_HOTKEYS } from "@amluto-steps/ui/fakes";

import { desktopRecorder } from "./recorder-bridge";
import { rustBackend, type Handler } from "./test/rust-backend";

/**
 * The recorder bridge's contracts, run against the desktop adapter over a stand-in for the Rust
 * side. The stand-in keeps what the Rust commands keep, simply; what it checks is that every
 * command the adapter sends exists there with the arguments its function takes.
 */

type Args = Record<string, unknown>;
const args = (given: Args | Uint8Array) => given as Args;

function hotkeys(): Record<string, Handler> {
  let current = DEFAULT_HOTKEYS.map((binding) => ({ ...binding }));
  const bindings = () => current.map((binding) => ({ ...binding }));
  return {
    hotkeys_get: bindings,
    hotkeys_set: (given) => {
      const { action, keys } = args(given);
      current = current.map((binding) =>
        binding.action === action ? { ...binding, keys: keys as string | null } : binding,
      );
      return bindings();
    },
    hotkeys_reset: () => {
      current = DEFAULT_HOTKEYS.map((binding) => ({ ...binding }));
      return bindings();
    },
    hotkeys_suspend: bindings,
  };
}

/** The setup .exe's copy, with 1.0.1 out. */
function updates(): Record<string, Handler> {
  let found: string | null = null;
  let pending: string | null = null;
  return {
    updates_channel: () => "checks",
    updates_check: () => {
      found = "1.0.1";
      return { version: found, notes: "Fixes.", published: 1_790_000_000 };
    },
    updates_download: () => {
      if (!found) throw new Error("Check for updates first.");
      pending = found;
      return pending;
    },
    updates_pending: () => pending,
    updates_install: () => undefined,
  };
}

/** Brand folders in app data; the organisation deploys none here. */
function brands(): Record<string, Handler> {
  const saved = new Map<string, unknown>();
  const files = new Map<string, string>();
  return {
    brands_list: () => [...saved.values()],
    brands_save: (given) => {
      const { profile } = args(given);
      saved.set(String((profile as { id: string }).id), profile);
    },
    brands_managed_ids: () => [],
    brands_save_managed: () => {
      throw {
        code: "invalidBrand",
        message: "Only a brand your organisation deploys is saved this way.",
      };
    },
    brands_delete: (given) => {
      saved.delete(String(args(given).id));
    },
    brands_read_file: (given) => files.get(String(args(given).path)),
    brands_write_file: (given) => {
      files.set(String(args(given).path), String(args(given).contents));
    },
  };
}

/** Settings, backup and brand files, by path. */
function files(): Record<string, Handler> {
  const kept = new Map<string, string>();
  const read = (given: Args | Uint8Array) => {
    const contents = kept.get(String(args(given).path));
    if (contents === undefined) throw { code: "notFound", message: "No such file." };
    return contents;
  };
  const write = (given: Args | Uint8Array) => {
    kept.set(String(args(given).path), String(args(given).contents));
  };
  return {
    settings_read_file: read,
    settings_write_file: write,
    backup_read_file: read,
    backup_write_file: write,
  };
}

/** No fonts installed; nothing uploaded is a font. */
function fonts(): Record<string, Handler> {
  return {
    fonts_family: () => ({ regular: null, bold: null, italic: null, boldItalic: null }),
    fonts_check: () => {
      throw { code: "notFont", message: "That isn't a TrueType font file (.ttf)." };
    },
  };
}

function support(): Record<string, Handler> {
  return {
    support_create_bundle: () => ({ path: "C:\\Steps\\support.zip", files: ["settings.json"] }),
    support_show_bundle: () => undefined,
    support_open_email: () => undefined,
    support_open_logs: () => undefined,
    open_web_page: () => undefined,
  };
}

/** The link's pipe, on and with Chrome connected; each change is an event, as Rust sends it. */
function link(): Record<string, Handler> {
  let status = { available: true, enabled: true, connected: ["chrome"], problem: null };
  return {
    browser_link_get: () => status,
    browser_link_set: async (given) => {
      const enabled = (args(given).on as boolean | null) ?? true;
      status = { ...status, enabled, connected: enabled ? ["chrome"] : [] };
      await emit("browser-link:state", status);
      return status;
    },
  };
}

/**
 * The recorder's preferences, policy and this PC. Outside the Store package (`startup_task_*`
 * answer null) Start with Windows is the autostart plugin's.
 */
function host(): { commands: Record<string, Handler>; plugins: Record<string, Handler> } {
  let preferences = { displayName: "", libraryFolder: "C:\\Guides" };
  let autoStart = false;
  return {
    commands: {
      recorder_get_preferences: () => preferences,
      recorder_set_preferences: (given) => {
        preferences = args(given).preferences as typeof preferences;
        return preferences;
      },
      policy_get: () => NO_POLICY,
      startup_task_state: () => null,
      startup_task_set: () => null,
      identity_names: () => ["Robin Example"],
      identity_machine: () => ({ pc: "EXAMPLE-PC", login: "robin" }),
    },
    plugins: {
      "plugin:autostart|is_enabled": () => autoStart,
      "plugin:autostart|enable": () => {
        autoStart = true;
      },
      "plugin:autostart|disable": () => {
        autoStart = false;
      },
    },
  };
}

/** The main window and the recording bar. */
function windows(): { commands: Record<string, Handler>; plugins: Record<string, Handler> } {
  const nothing = () => undefined;
  return {
    commands: { recorder_move_bar: nothing },
    plugins: Object.fromEntries(
      ["minimize", "unminimize", "show", "set_focus", "set_size"].map((name) => [
        `plugin:window|${name}`,
        nothing,
      ]),
    ),
  };
}

/** Header values travel as base64 of their UTF-8 (`recorder-bridge.ts`). */
const fromHeader = (value: string | undefined) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(value ?? ""), (character) => character.charCodeAt(0)),
  );

/** Exports written to disk; one in a folder never replaces a file, as `export_files.rs` does. */
function exportFiles(): Record<string, Handler> {
  const written = new Set<string>();
  return {
    export_write_file: (_body, headers) => {
      if (headers["x-path"]) {
        const path = fromHeader(headers["x-path"]);
        written.add(path);
        return path;
      }
      const folder = fromHeader(headers["x-folder"]);
      const name = fromHeader(headers["x-name"]);
      const dot = name.lastIndexOf(".");
      let path = `${folder}\\${name}`;
      for (let copy = 2; written.has(path); copy += 1)
        path = `${folder}\\${name.slice(0, dot)} (${copy})${name.slice(dot)}`;
      written.add(path);
      return path;
    },
    export_default_folder: () => "C:\\Users\\Robin\\Downloads",
    export_show: () => undefined,
    export_preview: () => undefined,
  };
}

/**
 * Text recognition: a screenshot whose bytes are "readable" shows the contract's words, and any
 * other fails, as Windows OCR does without a language. Words under the blur sent are left out.
 */
function recognition(): Record<string, Handler> {
  return {
    privacy_ocr: (body, headers) => {
      if (new TextDecoder().decode(body as Uint8Array) !== "readable")
        throw { code: "ocrUnavailable", message: "No text recognition language." };
      const areas = JSON.parse(headers["x-areas"] ?? "[]") as {
        x: number;
        y: number;
        w: number;
        h: number;
      }[];
      const hidden = (word: { x: number; y: number; w: number; h: number }) =>
        areas.some(
          (area) =>
            word.x + word.w / 2 >= area.x &&
            word.x + word.w / 2 <= area.x + area.w &&
            word.y + word.h / 2 >= area.y &&
            word.y + word.h / 2 <= area.y + area.h,
        );
      return SCREEN_WORDS.map((line) => ({
        words: line.words.filter((word) => !hidden(word)),
      })).filter((line) => line.words.length > 0);
    },
    privacy_clear_ocr_cache: () => undefined,
  };
}

const IDLE = {
  state: "idle",
  reason: null,
  sessionId: null,
  stepCount: 0,
  missedCount: 0,
  inputSource: "rawInput",
  keysRecorded: false,
};

/**
 * The recorder service and its journal on disk (`recorder/commands.rs`): each change of state is
 * an event, and stopping finishes the recording with one more.
 */
function recorder(): Record<string, Handler> {
  let snapshot: Record<string, unknown> = { ...IDLE };
  let next = 0;
  const sessions = new Map<
    string,
    { title: string; stopped: boolean; settings: unknown; steps: unknown[]; draft: Draft | null }
  >();
  type Draft = { guide: unknown; steps: Map<string, unknown> };
  const become = async (change: Record<string, unknown>) => {
    snapshot = { ...snapshot, ...change };
    await emit("recorder:state", snapshot);
    return snapshot;
  };
  const session = (given: Args | Uint8Array) => {
    const found = sessions.get(String(args(given).sessionId));
    if (!found) throw { code: "sessionNotFound", message: "That recording is no longer here." };
    return found;
  };
  const answer = () => snapshot;
  return {
    recorder_get_state: answer,
    recorder_start: (given) => {
      const { title, options } = args(given) as { title: string; options: { settings: unknown } };
      next += 1;
      const sessionId = `session-${next}`;
      sessions.set(sessionId, {
        title,
        stopped: false,
        settings: options.settings,
        steps: [],
        draft: null,
      });
      return become({ ...IDLE, state: "recording", sessionId });
    },
    recorder_pause: () => become({ state: "paused", reason: "User" }),
    recorder_resume: () => become({ state: "recording", reason: null }),
    recorder_stop: async () => {
      const sessionId = String(snapshot.sessionId);
      const found = sessions.get(sessionId);
      const done = await become({ ...IDLE });
      if (found) {
        found.stopped = true;
        await emit("recorder:finished", {
          sessionId,
          title: found.title,
          snapshot: { ...done, sessionId },
        });
      }
      return done;
    },
    recorder_discard: () => {
      sessions.delete(String(snapshot.sessionId));
      return become({ ...IDLE });
    },
    recorder_exclude_app: answer,
    recorder_include_app: answer,
    recorder_get_recoveries: () =>
      [...sessions]
        .filter(([sessionId]) => sessionId !== snapshot.sessionId)
        .map(([sessionId, found]) => ({
          sessionId,
          title: found.title,
          eventCount: 0,
          stopped: found.stopped,
          savedGuideId: null,
        })),
    recorder_get_recovery_records: (given) => (session(given), []),
    recorder_get_session_steps: (given) => session(given).steps,
    recorder_append_step: (given) => {
      session(given).steps.push(args(given).step);
    },
    recorder_get_restart_point: (given) => (session(given), null),
    recorder_get_recording_settings: (given) => session(given).settings,
    recorder_save_draft: (given) => {
      const steps = args(given).steps as { id: string }[];
      session(given).draft = {
        guide: args(given).guide,
        steps: new Map(steps.map((step) => [step.id, step])),
      };
    },
    recorder_save_draft_guide: (given) => {
      const found = session(given);
      found.draft = { guide: args(given).guide, steps: found.draft?.steps ?? new Map() };
    },
    recorder_save_draft_step: (given) => {
      const step = args(given).step as { id: string };
      session(given).draft?.steps.set(step.id, step);
    },
    recorder_delete_draft_step: (given) => {
      session(given).draft?.steps.delete(String(args(given).stepId));
    },
    recorder_load_draft: (given) => {
      const draft = session(given).draft;
      return draft ? { guide: draft.guide, steps: [...draft.steps.values()] } : null;
    },
    // Recordings here take no screenshots, so any one asked for isn't there.
    recorder_copy_media: (given) => {
      session(given);
      const { into, media } = args(given) as {
        into: { kind: string; sessionId?: string };
        media: unknown[];
      };
      if (into.kind === "draft") session({ sessionId: into.sessionId });
      if (media.length > 0)
        throw { code: "imageNotFound", message: "The screenshot was not found." };
    },
  };
}

function desktop(): Subject<RecorderBridge> {
  const settings = host();
  const window = windows();
  rustBackend(
    {
      ...recorder(),
      ...exportFiles(),
      ...recognition(),
      ...hotkeys(),
      ...updates(),
      ...brands(),
      ...files(),
      ...fonts(),
      ...support(),
      ...link(),
      ...settings.commands,
      ...window.commands,
    },
    { ...settings.plugins, ...window.plugins },
  );
  return { part: desktopRecorder, capabilities: desktopRecorder.capabilities };
}

recordingContract("Steps for Windows", desktop);
recordingJournalContract("Steps for Windows", desktop);
hotkeysContract("Steps for Windows", desktop);
updatesContract("Steps for Windows", desktop);
brandsContract("Steps for Windows", desktop);
fontsContract("Steps for Windows", desktop);
supportContract("Steps for Windows", desktop);
extensionLinkContract("Steps for Windows", desktop);
settingsFilesContract("Steps for Windows", desktop);
hostContract("Steps for Windows", desktop);
appWindowsContract("Steps for Windows", desktop);
exportFilesContract("Steps for Windows", desktop);
textReaderContract("Steps for Windows", () => ({
  ...desktop(),
  readable: new TextEncoder().encode("readable"),
  unreadable: new TextEncoder().encode("a screenshot in another script"),
}));
