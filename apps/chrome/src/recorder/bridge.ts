import {
  linkStatusSchema,
  recorderPreferencesSchema,
  type RecorderPreferences,
} from "@amluto-steps/core";
import { siteName } from "@amluto-steps/core";
import {
  readChoices,
  readExcludedSites,
  type LinkStatus,
  type RecorderBridge,
  type RecorderSnapshot,
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
 * The recorder as the shared UI reaches it in Steps for Chrome (the desktop's is
 * `apps/desktop/src/recorder-bridge.ts`). Recording itself runs in the background worker and is
 * reached by messages; the journal and drafts are in IndexedDB and read here directly. What only
 * a desktop has (monitors, the recording bar window, Windows shortcuts, updates, text recognition)
 * answers as having nothing, so the screens that use it show nothing.
 */

export interface BridgeOptions {
  journal: Journal;
  text: TextStore;
  /** Where a finished recording goes: the default library. */
  /** Where Save publishes: the default library, or `libraryId` for Save as. */
  target: (libraryId?: string) => Promise<PublishTarget>;
  files: FileAccess;
}

const PREFERENCES = "preferences";
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

export function chromeRecorder({ journal, text, target, files }: BridgeOptions): RecorderBridge {
  const state = () => send<RecorderSnapshot>({ type: "recorder:getState" });
  const readFile = async (path: string) => new TextDecoder().decode(await files.read(path));
  const write = async (path: string, contents: string) => {
    await files.write(path, new TextEncoder().encode(contents), "application/json");
  };

  // The side panel has to open straight from the click, so the window is known in advance.
  let windowId: number | undefined;
  chrome.windows.getCurrent().then(
    (current) => {
      windowId = current.id;
    },
    () => undefined,
  );

  const bridge: RecorderBridge = {
    edition: "browser",
    openRecorder() {
      // Called straight from a click, as both browsers require.
      const fox = firefox();
      if (fox) void fox.sidebarAction.open();
      else if (windowId !== undefined) void chrome.sidePanel.open({ windowId });
    },
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
      const policy = await bridge.getPolicy();
      const excluded = [...readExcludedSites(), ...policy.excludedApps]
        .map(siteName)
        .filter((site) => site !== null);
      return send({
        type: "recorder:start",
        title,
        choices: {
          keys: options.keys && !policy.disableKeystrokeRecording,
          excluded: [...new Set(excluded)],
          sensitive: policy.sensitiveFieldPatterns,
          original:
            (options.quality ?? readChoices().screenshotQuality) === "original" &&
            !policy.locked.includes("ScreenshotQuality"),
        },
      });
    },
    // Steps for Windows on this PC (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
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

    pause: () => send({ type: "recorder:pause" }),
    resume: () => send({ type: "recorder:resume" }),
    stop: () => send({ type: "recorder:stop" }),
    discard: () => send({ type: "recorder:discard" }),
    startAgain: state,
    undoStartAgain: state,

    // Desktop recording controls: nothing to set in a browser.
    // In Chrome, "apps" are sites (host names).
    excludeApp: (site) => send({ type: "recorder:exclude", site }),
    includeApp: state,
    setInputSource: state,
    setCaptureMode: done,
    setBarHidden: done,
    moveBar: done,
    isAutoStartEnabled: () => Promise.resolve(false),
    setAutoStartEnabled: done,
    getMonitors: () => Promise.resolve([]),
    setTargetMonitor: done,
    resizeBar: done,
    minimizeMain: done,
    showMain: done,
    heartbeat: done,
    closeShortcutPopup: done,
    captureNow: done,
    addShortcut: done,
    getHotkeys: () => Promise.resolve([]),
    setHotkey: () => Promise.resolve([]),
    resetHotkeys: () => Promise.resolve([]),
    suspendHotkeys: () => Promise.resolve([]),

    // The journal and drafts.
    appendStep: (sessionId, step) => journal.appendStep(sessionId, step),
    async finalize(sessionId, guide, libraryId) {
      // First, while the Save click still counts: a shared folder may ask for permission again.
      const library = await target(libraryId);
      const name = (await bridge.getPreferences()).displayName;
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
    loadImage: (sessionId, name) => journal.loadImage(sessionId, name),
    retakeDraftImage: notHere,
    saveDraft: (sessionId, guide, steps) => journal.saveDraft(sessionId, guide, steps),
    saveDraftGuide: (sessionId, guide) => journal.saveDraftGuide(sessionId, guide),
    saveDraftStep: (sessionId, step) => journal.saveDraftStep(sessionId, step),
    deleteDraftStep: (sessionId, stepId) => journal.deleteDraftStep(sessionId, stepId),
    loadDraft: (sessionId) => journal.loadDraft(sessionId),

    // Files, chosen and saved through the browser.
    readSettingsFile: readFile,
    readBackupFile: readFile,
    readBrandFile: readFile,
    writeSettingsFile: write,
    writeBackupFile: write,
    writeBrandFile: write,
    // An export Steps isn't set to ask about goes to Chrome's downloads. The answer is the
    // file's name: a browser has no path to show or copy.
    writeExport: (token, bytes) => files.write(token, bytes, "application/octet-stream"),
    writeExportTo: (_folder, name, bytes) =>
      Promise.resolve(download(name, bytes, "application/octet-stream")),
    defaultExportFolder: () => Promise.resolve(DOWNLOADS),
    showExport: done,
    async previewWalkthrough(html) {
      const url = URL.createObjectURL(new Blob([html.slice()], { type: "text/html" }));
      await chrome.tabs.create({ url });
    },

    // Installed fonts through Local Font Access, once allowed; uploaded ones read here
    // (src/fonts.ts). Policy comes from Chrome's managed storage.
    getFontFamily: async (family) => localFontFamily(await installedFonts(), family),
    checkFont: (bytes) => Promise.resolve().then(() => checkFont(bytes)),
    localFonts: {
      state: localFontsState,
      async allow() {
        await installedFonts().catch(() => []);
        return (await localFontsState()) === "granted";
      },
    },
    async getPolicy() {
      return managedPolicy(await chrome.storage.managed.get(null).catch(() => ({})));
    },

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

    // The Chrome Web Store updates the extension itself.
    updatesChannel: () => Promise.resolve("store"),
    checkForUpdate: () => Promise.resolve(null),
    downloadUpdate: notHere,
    pendingUpdate: () => Promise.resolve(null),
    installUpdate: notHere,

    // A screenshot's words come from the page as it was taken, not from recognition.
    readText: (image, blurred) => text.read(image, blurred),
    clearTextCache: () => text.clear(),

    async listBrands() {
      return Object.values(
        ((await chrome.storage.local.get("brands")).brands ?? {}) as Record<string, unknown>,
      );
    },
    async saveBrand(profile) {
      const brands = ((await chrome.storage.local.get("brands")).brands ?? {}) as Record<
        string,
        unknown
      >;
      const id = (profile as { id?: unknown }).id;
      if (typeof id !== "string") throw errors.invalid("The brand has no id.");
      await chrome.storage.local.set({ brands: { ...brands, [id]: profile } });
    },
    saveManagedBrand: notHere,
    async deleteBrand(id) {
      const brands = ((await chrome.storage.local.get("brands")).brands ?? {}) as Record<
        string,
        unknown
      >;
      await chrome.storage.local.set({
        brands: Object.fromEntries(Object.entries(brands).filter(([key]) => key !== id)),
      });
    },
  };
  return bridge;
}
