import "fake-indexeddb/auto";

import type { LinkStatus, RecorderBridge } from "@amluto-steps/ui";
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

import type { FileAccess } from "../files";
import { fakeChrome, type FakeChrome } from "../test/fake-chrome";
import { chromeRecorder } from "./bridge";
import { runCommands, type Command, type LinkCommands } from "./commands";
import { createEngine } from "./engine";
import { journal, openJournal } from "./journal";
import { openTextStore, textStore, type TextStore } from "./text-store";

/** Files the person "chose", kept in memory by token. */
function memoryFiles(): FileAccess {
  const kept = new Map<string, Uint8Array>();
  return {
    pickFile: () => Promise.resolve(null),
    pickSaveLocation: () => Promise.resolve(null),
    read: (token) => {
      const bytes = kept.get(token);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`no file ${token}`));
    },
    write: (token, bytes) => {
      kept.set(token, bytes);
      return Promise.resolve(token);
    },
  };
}

/**
 * The background worker's side of the link (`desktop/link.ts`), simply: on, with Steps for
 * Windows answering, and each change told to the open pages.
 */
function linkWorker(chrome: () => FakeChrome): LinkCommands {
  let status: LinkStatus = {
    available: true,
    enabled: true,
    connected: ["desktop"],
    problem: null,
  };
  return {
    status: () => status,
    set(on) {
      status = { ...status, enabled: on, connected: on ? ["desktop"] : [] };
      chrome().broadcast({ type: "link:state", status });
      return Promise.resolve(status);
    },
  };
}

let count = 0;

/**
 * Steps for Chrome's adapter over a fresh journal, text store and stand-in Chrome, with the
 * background worker's own recorder engine answering its commands (no tabs, so no clicks).
 */
async function chromeEdition(): Promise<Subject<RecorderBridge> & { text: TextStore }> {
  count += 1;
  const log = journal(await openJournal(`contract-journal-${count}`));
  const text = textStore(await openTextStore(`contract-text-${count}`));
  let kept: unknown;
  const engine = createEngine({
    journal: log,
    load: () => Promise.resolve(kept as never),
    save: (value) => {
      kept = structuredClone(value);
      return Promise.resolve();
    },
    screenshot: () => Promise.resolve(null),
    capturing: () => Promise.resolve(),
    keepText: (image, lines) => text.keep(image, lines),
    broadcast: (event) => chrome.broadcast(event),
    author: () => "Robin",
    now: () => Date.now(),
  });
  const run = runCommands(
    engine,
    linkWorker(() => chrome),
  );
  const chrome = fakeChrome((message) => run(message as Command));
  const bridge = chromeRecorder({
    journal: log,
    text,
    target: () => Promise.reject(new Error("no library")),
    files: memoryFiles(),
    folders: true,
  });
  return { part: bridge, capabilities: bridge.capabilities, text };
}

recordingContract("Steps for Chrome", chromeEdition);
recordingJournalContract("Steps for Chrome", chromeEdition);
hotkeysContract("Steps for Chrome", chromeEdition);
updatesContract("Steps for Chrome", chromeEdition);
brandsContract("Steps for Chrome", chromeEdition);
fontsContract("Steps for Chrome", chromeEdition);
supportContract("Steps for Chrome", chromeEdition);
extensionLinkContract("Steps for Chrome", chromeEdition);
settingsFilesContract("Steps for Chrome", chromeEdition);
hostContract("Steps for Chrome", chromeEdition);
appWindowsContract("Steps for Chrome", chromeEdition);
exportFilesContract("Steps for Chrome", chromeEdition);
textReaderContract("Steps for Chrome", async () => {
  const edition = await chromeEdition();
  // The page's words, kept as its screenshot was taken; none were kept for the other.
  const readable = new Uint8Array([1, 2, 3]);
  await edition.text.keep(new Blob([readable]), SCREEN_WORDS);
  return { ...edition, readable, unreadable: new Uint8Array([9, 9, 9]) };
});
