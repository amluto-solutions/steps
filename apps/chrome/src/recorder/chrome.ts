import { canvasCodec, prepareImage } from "../library/images";
import { openJournal, journal, type Journal } from "./journal";
import { createEngine, type EngineEvent } from "./engine";
import { openTextStore, textStore } from "./text-store";

/** The engine wired to Chrome: storage, screenshots, the capture script and messages. */

const SCRIPT_ID = "steps-capture";
const SCRIPT_FILE = "content-scripts/capture.js";

/**
 * Who needs the capture script in pages: this extension's own recording, and a recording in
 * Steps for Windows (`desktop/link.ts`). It comes out only when neither does. Kept in session
 * storage, as Chrome can stop the worker during the extension's own recording.
 */
export type CaptureOwner = "recorder" | "desktop";
const OWNERS_KEY = "captureOwners";
let owning: Promise<unknown> = Promise.resolve();

export function captureFor(owner: CaptureOwner, on: boolean): Promise<void> {
  const change = async () => {
    const stored = (await chrome.storage.session.get(OWNERS_KEY))[OWNERS_KEY] as
      CaptureOwner[] | undefined;
    const before = stored ?? [];
    const after = on ? [...new Set([...before, owner])] : before.filter((each) => each !== owner);
    await chrome.storage.session.set({ [OWNERS_KEY]: after });
    if (on) await capturing(true);
    // Taken out whenever no one needs it, even if the list was lost with the browser's session.
    else if (after.length === 0) await capturing(false);
  };
  // One change at a time: both owners can change at once.
  const next = owning.then(change, change);
  owning = next.catch(() => undefined);
  return next;
}

async function capturing(on: boolean) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (on) {
    if (registered.length === 0) {
      const script: chrome.scripting.RegisteredContentScript = {
        id: SCRIPT_ID,
        matches: ["<all_urls>"],
        js: [SCRIPT_FILE],
        runAt: "document_start",
        // Every frame, including the blank and `srcdoc` ones editors write themselves into.
        allFrames: true,
        matchOriginAsFallback: true,
      };
      // A browser that doesn't know `matchOriginAsFallback` refuses the whole registration:
      // without it, blank frames are still reached through the pages that contain them.
      await chrome.scripting.registerContentScripts([script]).catch(async () => {
        const plain = { ...script };
        delete plain.matchOriginAsFallback;
        await chrome.scripting.registerContentScripts([plain]);
      });
    }
    // Pages already open get it now; new ones as they load.
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id === undefined || !/^https?:/.test(tab.url ?? "")) continue;
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files: [SCRIPT_FILE] })
        .catch(() => undefined);
    }
  } else {
    if (registered.length > 0)
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    // Every frame of each tab hears it.
    for (const tab of await chrome.tabs.query({}))
      if (tab.id !== undefined)
        chrome.tabs.sendMessage(tab.id, { type: "capture:off" }).catch(() => undefined);
  }
}

/** The tab in front of a window, which is what captureVisibleTab takes. */
async function front(windowId: number) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab?.id;
}

async function screenshot(windowId: number, tabId: number, original: boolean) {
  // Only while the clicked tab is in front, before and after: a quick switch to another tab (an
  // excluded site, say) would otherwise be what the screenshot shows.
  if ((await front(windowId)) !== tabId) return null;
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  if ((await front(windowId)) !== tabId) return null;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const prepared = await prepareImage(canvasCodec, bytes, original ? "original" : "balanced");
  return { image: prepared.blob, width: prepared.width, height: prepared.height };
}

let displayName = "";
chrome.storage.local.get("preferences").then(
  (stored) => {
    displayName = (stored.preferences as { displayName?: string } | undefined)?.displayName ?? "";
  },
  () => undefined,
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.preferences)
    displayName =
      (changes.preferences.newValue as { displayName?: string } | undefined)?.displayName ?? "";
});

/** The journal, opened on first use: a background worker can't wait for it before starting. */
const opened = openJournal().then(journal);
const lazyJournal = new Proxy({} as Journal, {
  get:
    (_target, key: keyof Journal) =>
    async (...args: unknown[]) =>
      ((await opened)[key] as (...values: unknown[]) => unknown)(...args),
});

/** The screenshots' words; entries unused for 30 days are cleared as the worker starts. */
const texts = openTextStore().then((db) => textStore(db));
texts.then((store) => store.prune()).catch(() => undefined);

export const engine = createEngine({
  journal: lazyJournal,
  load: async () => (await chrome.storage.session.get("recorder")).recorder as never,
  save: (value) => chrome.storage.session.set({ recorder: value }),
  screenshot,
  capturing: (on) => captureFor("recorder", on),
  keepText: async (image, lines) => (await texts).keep(image, lines),
  broadcast: (event: EngineEvent) => {
    chrome.runtime.sendMessage(event).catch(() => undefined);
  },
  author: () => displayName,
  now: () => Date.now(),
});
