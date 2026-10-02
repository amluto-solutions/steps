import { onExcludedSitesSaved, readExcludedSites } from "@amluto-steps/ui";

import { EXCLUDED_SITES_KEY } from "./desktop/link";
import { browserFiles } from "./files";
import {
  browserPcId,
  canPickFolders,
  handleFolder,
  holdSession,
  openFolderRegistry,
  pickLibraryFolder,
  sessionAlive,
} from "./folder/registry";
import { createLibraryRouter, HEARTBEAT_MS } from "./folder/router";
import { openLibraryDb } from "./library/db";
import { newId } from "./library/ids";
import { canvasCodec } from "./library/images";
import { createBrowserLibrary } from "./library/store";
import { displayName } from "./preferences";
import { chromeRecorder } from "./recorder/bridge";
import { journal, openJournal } from "./recorder/journal";
import { openTextStore, textStore } from "./recorder/text-store";

/** True only in the end-to-end tests' builds (wxt.config.ts). */
declare const __STEPS_E2E__: boolean;

/**
 * The end-to-end test's library folder. No test driver can answer the browser's folder picker, so
 * that build picks a folder in the browser's own private file system, which has the same API
 * (tools/chrome-e2e/shared-library.mjs).
 */
async function pickTestFolder() {
  const root = await navigator.storage.getDirectory();
  return handleFolder(await root.getDirectoryHandle("Shared guides", { create: true }));
}

/**
 * The library and recorder for a Steps page (the app tab or the side panel): the library in the
 * browser, and in Chrome and Edge the shared folders added as libraries
 * (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome).
 */
export async function openBridges() {
  const [libraryDb, journalDb, textDb, registry, pc] = await Promise.all([
    openLibraryDb(),
    openJournal(),
    openTextStore(),
    openFolderRegistry(),
    browserPcId(),
  ]);
  const files = browserFiles();
  const appVersion = chrome.runtime.getManifest().version;
  // The background worker's copy of the sites never recorded, for Steps for Windows' recordings.
  const keepSites = (sites: string[]) =>
    void chrome.storage.local.set({ [EXCLUDED_SITES_KEY]: sites }).catch(() => undefined);
  onExcludedSitesSaved(keepSites);
  keepSites(readExcludedSites());
  // Each page edits as its own session, held for as long as the page is open.
  const session = newId();
  holdSession(session);
  const library = createLibraryRouter({
    browser: createBrowserLibrary({
      db: libraryDb,
      codec: canvasCodec,
      displayName,
      files,
      appVersion,
    }),
    db: libraryDb,
    registry,
    codec: canvasCodec,
    files,
    appVersion,
    displayName,
    pc,
    session,
    alive: sessionAlive,
    ...(canPickFolders() ? { pickFolder: __STEPS_E2E__ ? pickTestFolder : pickLibraryFolder } : {}),
  });
  window.setInterval(() => void library.beat(), HEARTBEAT_MS);
  return {
    library,
    recorder: chromeRecorder({
      journal: journal(journalDb),
      text: textStore(textDb),
      target: (libraryId) => library.publishTarget(libraryId),
      files,
    }),
  };
}

/** Brings the Steps tab forward, or opens one. */
export async function openStepsTab() {
  const url = chrome.runtime.getURL("app.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined)
      await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}
