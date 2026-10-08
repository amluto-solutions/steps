import {
  linkStatusSchema,
  recorderPreferencesSchema,
  type RecorderPreferences,
} from "@amluto-steps/core";
import { siteName } from "@amluto-steps/core";
import {
  noHotkeys,
  readChoices,
  readExcludedSites,
  type AppWindows,
  type Brands,
  type Capabilities,
  type ExportFiles,
  type ExtensionLink,
  type Fonts,
  type Host,
  type LinkStatus,
  type RecorderBridge,
  type RecorderSnapshot,
  type Recording,
  type RecordingJournal,
  type SettingsFiles,
  type Support,
  type TextReader,
  type Updates,
} from "@amluto-steps/ui";

import { ALL_SITES, firefox } from "../browser";
import { download, type FileAccess } from "../files";
import { checkFont, installedFonts, localFontFamily, localFontsState } from "../fonts";
import { errors } from "../library/ids";
import type { PublishTarget } from "../library/store";
import { managedPolicy } from "../policy";
import { setDisplayName } from "../preferences";
import type { EngineEvent } from "./engine";
import type { Journal } from "./journal";
import type { TextStore } from "./text-store";

/**
 * The recorder bridge as the shared UI reaches it in Steps for Chrome (the desktop's is
 * `apps/desktop/src/recorder-bridge.ts`), one part per small interface. Recording itself runs in
 * the background worker and is reached by messages; the journal and drafts are in IndexedDB and
 * read here directly. What only a desktop has (monitors, the recording bar window, shortcuts,
 * updates, support files) answers as having nothing, as the capabilities say.
 */

export interface BridgeOptions {
  journal: Journal;
  text: TextStore;
  /** Where Save publishes: the default library, or `libraryId` for Save as. */
  target: (libraryId?: string) => Promise<PublishTarget>;
  files: FileAccess;
  /** Whether this browser can open folders as libraries (Chrome and Edge can; Firefox can't). */
  folders: boolean;
}

/**
 * What Steps for Chrome has: pages recorded in a tab, "My guides" in the browser's own storage,
 * and folders as libraries where the browser can open them. What only a desktop has (starting with
 * the computer, shortcuts, updates and support files, an export folder, terminals) isn't here.
 */
export const browserCapabilities = (folders: boolean): Capabilities => ({
  records: "pages",
  programNames: "exe",
  autoStart: null,
  defaultLibrary: "browser",
  libraryFolders: folders,
  hotkeys: false,
  updates: false,
  support: false,
  exportFolder: false,
  openExports: false,
  commandOutput: false,
  hideBar: false,
  inputSources: false,
  screenWords: "page",
  // The background worker keeps the link's choice; the page only reads and changes it.
  savesLinkChoice: false,
});

const PREFERENCES = "preferences";
const BRANDS = "brands";
const BROWSER_LIBRARY = "browser";
/** Stands for Chrome's downloads, where exports go unless Steps is set to ask. */
const DOWNLOADS = "downloads";

async function send<T>(command: Record<string, unknown>): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(command)) as
    { ok: true; result: T } | { ok: false; error: string } | undefined;
  if (!answer) throw new Error("The recorder didn't answer. Reload the extension and try again.");
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}

/** Listens for one kind of the recorder's events; returns how to stop listening. */
function on<T>(
  type: EngineEvent["type"],
  pick: (event: EngineEvent) => T,
  handler: (value: T) => void,
) {
  // Only the recorder's own events: a content script (in any page) can message here too.
  const listener = (message: EngineEvent, sender: chrome.runtime.MessageSender) => {
    if (sender.tab) return;
    if (message?.type === type) handler(pick(message));
  };
  chrome.runtime.onMessage.addListener(listener);
  return Promise.resolve(() => chrome.runtime.onMessage.removeListener(listener));
}

const nothing = () => Promise.resolve(() => undefined);
const done = () => Promise.resolve();
const notHere = () => Promise.reject(errors.notInBrowser());
const state = () => send<RecorderSnapshot>({ type: "recorder:getState" });

/** The person's name and the library folder, in the extension's storage. */
function host(): Host {
  return {
    async getPreferences() {
      const stored = (await chrome.storage.local.get(PREFERENCES))[PREFERENCES] as unknown;
      const parsed = recorderPreferencesSchema.safeParse(stored);
      const preferences: RecorderPreferences = parsed.success
        ? parsed.data
        : { displayName: "", libraryFolder: BROWSER_LIBRARY };
      setDisplayName(preferences.displayName);
      return preferences;
    },
    async setPreferences(preferences) {
      const checked = recorderPreferencesSchema.parse({
        ...preferences,
        libraryFolder: BROWSER_LIBRARY,
      });
      await chrome.storage.local.set({ [PREFERENCES]: checked });
      setDisplayName(checked.displayName);
      return checked;
    },
    // Policy comes from Chrome's managed storage.
    async getPolicy() {
      return managedPolicy(await chrome.storage.managed.get(null).catch(() => ({})));
    },
    isAutoStartEnabled: () => Promise.resolve(false),
    setAutoStartEnabled: done,
    // The browser can't tell its PC or login, so a guide's saves and lock name this Steps instead.
    identityNames: () => Promise.resolve([]),
    machineIdentity: () => Promise.resolve({ pc: "Steps for Chrome", login: "" }),
  };
}

/** Recording in the background worker, reached by messages. */
function recording(getPolicy: Host["getPolicy"]): Recording {
  // The side panel has to open straight from the click, so the window is known in advance.
  let windowId: number | undefined;
  chrome.windows.getCurrent().then(
    (current) => {
      windowId = current.id;
    },
    () => undefined,
  );
  return {
    openRecorder() {
      // Called straight from a click, as both browsers require.
      const fox = firefox();
      if (fox) void fox.sidebarAction.open();
      else if (windowId !== undefined) void chrome.sidePanel.open({ windowId });
    },
    getState: state,
    onState: (handler) =>
      on(
        "recorder:state",
        (event) => (event.type === "recorder:state" ? event.snapshot : null),
        (value) => value && handler(value),
      ),
    onFact: (handler) =>
      on(
        "recorder:fact",
        (event) => (event.type === "recorder:fact" ? event.fact : null),
        (value) => value && handler(value),
      ),
    onFinished: (handler) =>
      on(
        "recorder:finished",
        (event) => (event.type === "recorder:finished" ? event.finished : null),
        (value) => value && handler(value),
      ),
    onError: nothing,
    onStepAdded: nothing,
    onRestarted: nothing,
    onStartRequested: nothing,
    onHeartbeatRequest: nothing,

    // The recorder applies the organisation's rules itself, whatever the page asked for.
    async start(title, options) {
      // Firefox lets people take back an extension's access to sites. Asked for again here,
      // before anything is awaited, while this is still the click on Start recording.
      const access = firefox() ? chrome.permissions.request(ALL_SITES) : Promise.resolve(true);
      if (!(await access.catch(() => false))) throw errors.noSiteAccess();
      const policy = await getPolicy();
      const excluded = [...readExcludedSites(), ...policy.excludedApps]
        .map(siteName)
        .filter((site) => site !== null);
      return send({
        type: "recorder:start",
        title,
        choices: {
          settings: options.settings,
          keys: options.keys && !policy.disableKeystrokeRecording,
          excluded: [...new Set(excluded)],
          sensitive: policy.sensitiveFieldPatterns,
          original:
            (options.quality ?? readChoices().screenshotQuality) === "original" &&
            !policy.locked.includes("ScreenshotQuality"),
        },
      });
    },
    pause: () => send({ type: "recorder:pause" }),
    resume: () => send({ type: "recorder:resume" }),
    stop: () => send({ type: "recorder:stop" }),
    discard: () => send({ type: "recorder:discard" }),
    startAgain: state,
    undoStartAgain: state,

    // In Chrome, "apps" are sites (host names).
    excludeApp: (site) => send({ type: "recorder:exclude", site }),
    includeApp: state,
    // Desktop recording controls: nothing to set in a browser.
    setInputSource: state,
    setCaptureMode: done,
    setBarHidden: done,
    getMonitors: () => Promise.resolve([]),
    setTargetMonitor: done,
    heartbeat: done,
    closeShortcutPopup: done,
    captureNow: done,
    addShortcut: done,
  };
}

/** The journal and drafts, in IndexedDB. */
function recordingJournal(
  journal: Journal,
  target: BridgeOptions["target"],
  getPreferences: Host["getPreferences"],
): RecordingJournal {
  return {
    appendStep: (sessionId, step) => journal.appendStep(sessionId, step),
    copyMedia: (sessionId, into, media) => journal.copyMedia(sessionId, into, media, target),
    async finalize(sessionId, guide, libraryId) {
      // First, while the Save click still counts: a shared folder may ask for permission again.
      const library = await target(libraryId);
      const name = (await getPreferences()).displayName;
      await journal.finalize(sessionId, guide, library, name);
      await send({ type: "recorder:forget", sessionId });
    },
    async getRecoveries() {
      const current = await state();
      const recording = current.state !== "idle" ? current.sessionId : null;
      return (await journal.recoveries()).filter((item) => item.sessionId !== recording);
    },
    async recoverSession(sessionId) {
      const found = await journal.session(sessionId);
      return {
        state: "idle",
        reason: null,
        sessionId: found.sessionId,
        stepCount: (await journal.facts(sessionId)).length,
        missedCount: 0,
        inputSource: "rawInput",
        keysRecorded: false,
      };
    },
    getRecoveryRecords: (sessionId) => journal.facts(sessionId),
    getSessionSteps: (sessionId) => journal.steps(sessionId),
    getRestartPoint: async (sessionId) =>
      (await journal.session(sessionId).catch(() => null))?.restartAfter ?? null,
    getRecordingSettings: async (sessionId) =>
      (await journal.session(sessionId).catch(() => null))?.settings ?? null,
    loadImage: (sessionId, name) => journal.loadImage(sessionId, name),
    retakeDraftImage: notHere,
    saveDraft: (sessionId, guide, steps) => journal.saveDraft(sessionId, guide, steps),
    saveDraftGuide: (sessionId, guide) => journal.saveDraftGuide(sessionId, guide),
    saveDraftStep: (sessionId, step) => journal.saveDraftStep(sessionId, step),
    deleteDraftStep: (sessionId, stepId) => journal.deleteDraftStep(sessionId, stepId),
    loadDraft: (sessionId) => journal.loadDraft(sessionId),
  };
}

/** One page and no bar window: nothing to move or bring forward. */
const windows: AppWindows = {
  minimizeMain: done,
  showMain: done,
  onAlreadyOpen: nothing,
  resizeBar: done,
  moveBar: done,
};

/** The Chrome Web Store updates the extension itself. */
const updates: Updates = {
  updatesChannel: () => Promise.resolve("store"),
  checkForUpdate: () => Promise.resolve(null),
  downloadUpdate: notHere,
  pendingUpdate: () => Promise.resolve(null),
  installUpdate: notHere,
};

/** Brand profiles in the extension's storage; `.amlbrand` files chosen through the browser. */
function brands(files: BridgeOptions["files"]): Brands {
  const stored = async () =>
    ((await chrome.storage.local.get(BRANDS))[BRANDS] ?? {}) as Record<string, unknown>;
  return {
    listBrands: async () => Object.values(await stored()),
    async saveBrand(profile) {
      const id = (profile as { id?: unknown }).id;
      if (typeof id !== "string") throw errors.invalid("The brand has no id.");
      await chrome.storage.local.set({ [BRANDS]: { ...(await stored()), [id]: profile } });
    },
    // The organisation's brands come with the desktop's start-up sync only.
    saveManagedBrand: notHere,
    managedBrandIds: () => Promise.resolve([]),
    async deleteBrand(id) {
      const kept = Object.entries(await stored()).filter(([key]) => key !== id);
      await chrome.storage.local.set({ [BRANDS]: Object.fromEntries(kept) });
    },
    readBrandFile: async (path) => new TextDecoder().decode(await files.read(path)),
    writeBrandFile: async (path, contents) => {
      await files.write(path, new TextEncoder().encode(contents), "application/json");
    },
  };
}

/** Installed fonts through Local Font Access, once allowed; uploaded ones read here (src/fonts.ts). */
const fonts: Fonts = {
  getFontFamily: async (family) => localFontFamily(await installedFonts(), family),
  checkFont: (bytes) => Promise.resolve().then(() => checkFont(bytes)),
  localFonts: {
    state: localFontsState,
    async allow() {
      await installedFonts().catch(() => []);
      return (await localFontsState()) === "granted";
    },
  },
};

/** No support files or logs folder here; Amluto's pages open in a tab. */
const support: Support = {
  createSupportBundle: notHere,
  showSupportBundle: done,
  openSupportEmail: done,
  openLogsFolder: done,
  async openWebPage(page, name) {
    const address =
      page === "amluto"
        ? "https://amluto.com/"
        : page === "steps"
          ? "https://steps.amluto.com/"
          : page === "source"
            ? "https://github.com/amluto-solutions/steps"
            : page === "crate"
              ? `https://crates.io/crates/${encodeURIComponent(name ?? "")}`
              : `https://www.npmjs.com/package/${encodeURIComponent(name ?? "")}`;
    await chrome.tabs.create({ url: address });
  },
};

/** Steps for Windows on this PC (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together). */
const link: ExtensionLink = {
  getLink: () => send<LinkStatus>({ type: "link:get" }),
  async setLink(on) {
    if (on === null) return send<LinkStatus>({ type: "link:get" });
    if (on) {
      // Asked for here, before anything is awaited, while this is still the click.
      const granted = await chrome.permissions
        .request({ permissions: ["nativeMessaging"] })
        .catch(() => false);
      if (!granted) return send<LinkStatus>({ type: "link:get" });
    }
    const status = await send<LinkStatus>({ type: "link:set", on });
    // Switched off, the permission is given back.
    if (!on)
      await chrome.permissions.remove({ permissions: ["nativeMessaging"] }).catch(() => false);
    return status;
  },
  onLink: (handler) => {
    const listener = (
      message: { type?: string; status?: unknown },
      sender: chrome.runtime.MessageSender,
    ) => {
      if (sender.tab || message?.type !== "link:state") return;
      const parsed = linkStatusSchema.safeParse(message.status);
      if (parsed.success) handler(parsed.data);
    };
    chrome.runtime.onMessage.addListener(listener);
    return Promise.resolve(() => chrome.runtime.onMessage.removeListener(listener));
  },
};

/** Settings and backup files, chosen and saved through the browser. */
function settingsFiles(files: BridgeOptions["files"]): SettingsFiles {
  const read = async (path: string) => new TextDecoder().decode(await files.read(path));
  const write = async (path: string, contents: string) => {
    await files.write(path, new TextEncoder().encode(contents), "application/json");
  };
  return {
    readSettingsFile: read,
    writeSettingsFile: write,
    readBackupFile: read,
    writeBackupFile: write,
  };
}

/** A screenshot's words come from the page as it was taken, not from recognition. */
export function pageTextReader(text: TextStore): TextReader {
  return {
    readText: (image, blurred) => text.read(image, blurred),
    clearTextCache: () => text.clear(),
  };
}

/**
 * An export Steps isn't set to ask about goes to Chrome's downloads. The answer is the file's
 * name: a browser has no path to show, copy or open.
 */
function exportFiles(files: BridgeOptions["files"]): ExportFiles {
  return {
    writeExport: (token, bytes) => files.write(token, bytes, "application/octet-stream"),
    writeExportTo: (_folder, name, bytes) =>
      Promise.resolve(download(name, bytes, "application/octet-stream")),
    defaultExportFolder: () => Promise.resolve(DOWNLOADS),
    showExport: done,
    async previewWalkthrough(html) {
      const url = URL.createObjectURL(new Blob([html.slice()], { type: "text/html" }));
      await chrome.tabs.create({ url });
    },
  };
}

export function chromeRecorder({
  journal,
  text,
  target,
  files,
  folders,
}: BridgeOptions): RecorderBridge {
  const settings = host();
  return {
    capabilities: browserCapabilities(folders),
    ...settings,
    ...recording(settings.getPolicy),
    ...recordingJournal(journal, target, settings.getPreferences),
    ...windows,
    ...noHotkeys(),
    ...updates,
    ...brands(files),
    ...fonts,
    ...support,
    ...link,
    ...settingsFiles(files),
    ...pageTextReader(text),
    ...exportFiles(files),
  };
}
