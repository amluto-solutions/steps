import type {
  EditLock,
  Editing,
  LibraryBridge,
  LibraryGuideSummary,
  LibraryInfo,
  LockLost,
} from "@amluto-steps/ui";

import type { FileAccess } from "../files";
import { exportArchive, readArchive } from "../library/archive";
import type { LibraryDb } from "../library/db";
import { errors, isSafeId, LibraryError, newId } from "../library/ids";
import { dataUrl, type ImageCodec } from "../library/images";
import { BROWSER_LIBRARY_ID, browserTarget, type PublishTarget } from "../library/store";

import {
  asCopy,
  browserBundle,
  folderBundle,
  putBrowserBundle,
  putFolderBundle,
  type GuideBundle,
} from "./bundle";
import {
  addComment,
  deleteComment,
  listComments,
  setCommentResolved,
  type Commenter,
} from "./comments";
import type { Dir } from "./dir";
import { createJson, isObject, tryJson } from "./files";
import { applyRedactions, listVersions, loadVersion, restoreVersion, saveVersion } from "./history";
import { FolderLibrary } from "./library";
import type { FolderHandle, FolderRegistry, RegisteredFolder } from "./registry";
import {
  discardDraft,
  draftToCopy,
  forgetOwnDelete,
  heartbeat,
  listConflicts,
  listDrafts,
  mayWrite,
  noteDelete,
  openForEditing,
  readLock,
  releaseLock,
  resolveConflict,
  saveDraft,
  type LockHolder,
} from "./sharing";

/**
 * Every library Steps for Chrome and Edge knows, behind the one interface the UI uses
 * (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome): the library kept in
 * the browser, and shared folders read and written as the desktop does, with its edit locks. This
 * is the desktop's `src/library.rs` and `src/locks.rs`.
 */

/**
 * How long another person's lock counter must stand still before this page takes the lock as
 * stale. The desktop waits 10 minutes, and only while the lock file shows as in sync; a browser
 * can't see the sync state, so it waits twice as long, 20
 * (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome).
 */
export const STALE_AFTER_MS = 20 * 60_000;
/** How often this page raises the counters of the guides it's editing. */
export const HEARTBEAT_MS = 60_000;
const MAX_NAME = 120;

export interface RouterOptions {
  /** The library in the browser (`createBrowserLibrary`). */
  browser: LibraryBridge;
  /** Its database, for moving guides in and out, and for recordings. */
  db: LibraryDb;
  registry: FolderRegistry;
  codec: ImageCodec;
  files: FileAccess;
  appVersion: string;
  /** The name in Settings. */
  displayName: () => string;
  /** This browser, on locks and comments. */
  pc: string;
  /** This page's editing session; a new one each time the page opens. */
  session?: string;
  /** Whether a session is still open in another page of this browser. */
  alive?: (session: string) => Promise<boolean>;
  /** The folder picker; absent where the browser has none (Firefox). */
  pickFolder?: () => Promise<FolderHandle | null>;
  now?: () => number;
}

export interface LibraryRouter extends LibraryBridge {
  readonly session: string;
  /**
   * Where a finished recording goes: the default library. Called from the Save click, so a folder
   * that needs permission again can ask for it.
   */
  /** Where a recording is saved: the default library, or `libraryId` (Save as). */
  publishTarget(libraryId?: string): Promise<PublishTarget>;
  /** Raises the counters of the guides being edited here; tells the editor of any taken over. */
  beat(): Promise<void>;
}

const folderAccess = (name: string) =>
  new LibraryError(
    "folderAccess",
    // The folder's name, which the UI's words for this code put in.
    name,
  );

const lockLost = (lock: EditLock | null) =>
  new LibraryError(
    "lockLost",
    `${lock?.name ?? "Someone else"} is editing this guide now, so this change wasn't saved here.`,
  );

function validName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || [...trimmed].length > MAX_NAME)
    throw errors.invalid(`Enter a library name of 1 to ${MAX_NAME} characters.`);
  return trimmed;
}

/**
 * Makes a folder a library: `guides` and the `.amluto-library.json` marker, whose id is used. A
 * marker that's there is left alone (it belongs to everyone who uses the folder), even a damaged one.
 */
async function prepareFolder(root: Dir, name: string): Promise<string> {
  await root.makeFolder("guides");
  const marker = await tryJson(root, ".amluto-library.json");
  if (isObject(marker) && isSafeId(marker.id)) return marker.id;
  const id = newId();
  if (!(await root.stat(".amluto-library.json")))
    await createJson(root, ".amluto-library.json", { id, name, formatVersion: 1 });
  return id;
}

export function createLibraryRouter(options: RouterOptions): LibraryRouter {
  const { browser, db, registry, codec, files } = options;
  const session = options.session ?? newId();
  const now = options.now ?? Date.now;
  const alive = options.alive ?? (() => Promise.resolve(true));
  const me = () => options.displayName().trim() || "Someone";
  const holder = (): LockHolder => ({ name: me(), pc: options.pc, session });
  const who = (): Commenter => ({ name: me(), pc: options.pc });
  const isBrowser = (libraryId: string) => libraryId === BROWSER_LIBRARY_ID;

  /** Each folder's library, kept so its lists and search stay cached. */
  const opened = new Map<string, FolderLibrary>();
  /** Guides this page holds the lock of. */
  const held = new Map<string, { libraryId: string; guideId: string }>();
  /** Other people's counters, as this page last saw them change. */
  const watched = new Map<string, { session: string; counter: number; since: number }>();
  const lostHandlers = new Set<(lost: LockLost) => void>();
  /** Folders chosen with the picker, until they're added. */
  const picked = new Map<string, FolderHandle>();
  let picks = 0;
  let latestSearch = 0;
  const key = (libraryId: string, guideId: string) => `${libraryId}\n${guideId}`;

  const registered = async (libraryId: string): Promise<RegisteredFolder> => {
    const found = (await registry.list()).find((entry) => entry.id === libraryId);
    if (!found)
      throw new LibraryError("libraryNotFound", "That library isn't in your list of libraries.");
    return found;
  };

  /** A folder library, once the browser allows it (asking only when `ask`, from a click). */
  const folder = async (libraryId: string, ask = false): Promise<FolderLibrary> => {
    const entry = await registered(libraryId);
    if (!(await entry.folder.permitted(ask))) throw folderAccess(entry.folder.name);
    let library = opened.get(libraryId);
    if (!library) {
      library = new FolderLibrary(entry.folder.open(), codec);
      opened.set(libraryId, library);
    }
    return library;
  };

  /** A change to a guide, made only while this page may write it: it holds the lock, or nobody does. */
  const writing = async <T>(
    libraryId: string,
    guideId: string,
    action: (library: FolderLibrary) => Promise<T>,
  ): Promise<T> => {
    const library = await folder(libraryId);
    if (!(await mayWrite(library, guideId, session)))
      throw lockLost(await readLock(library, guideId).catch(() => null));
    return action(library);
  };

  const defaultId = async (): Promise<string> => {
    const chosen = await registry.defaultId();
    if (chosen && (await registry.list()).some((entry) => entry.id === chosen)) return chosen;
    return BROWSER_LIBRARY_ID;
  };

  const folderInfo = async (entry: RegisteredFolder, isDefault: boolean): Promise<LibraryInfo> => {
    const allowed = await entry.folder.permitted(false);
    return {
      id: entry.id,
      name: entry.name,
      path: entry.folder.name,
      isDefault,
      managed: false,
      // The browser can't tell whether OneDrive syncs it, so the notice that others can open the
      // unblurred originals is always shown.
      synced: true,
      guideCount: allowed ? await (await folder(entry.id)).guideCount() : 0,
      ...(allowed ? {} : { needsAccess: true }),
    };
  };

  const info = async (libraryId: string): Promise<LibraryInfo> => {
    const found = (await bridge.listLibraries()).find((item) => item.id === libraryId);
    if (!found)
      throw new LibraryError("libraryNotFound", "That library isn't in your list of libraries.");
    return found;
  };

  /** The saving-over steps of a copy or move between the browser and a folder, or two folders. */
  const transfer = async (
    fromLibraryId: string,
    guideId: string,
    toLibraryId: string,
    move: boolean,
  ): Promise<LibraryGuideSummary> => {
    if (fromLibraryId === toLibraryId && isBrowser(fromLibraryId))
      return move
        ? ((await browser.listGuides(fromLibraryId)).find((guide) => guide.id === guideId) ??
            Promise.reject(errors.guideNotFound()))
        : browser.copyGuide(fromLibraryId, guideId, toLibraryId);
    // A move takes the guide from under anyone editing it, so not while someone else is.
    if (move && !isBrowser(fromLibraryId)) await writing(fromLibraryId, guideId, async () => {});
    if (!isBrowser(fromLibraryId) && !isBrowser(toLibraryId)) {
      const from = await folder(fromLibraryId);
      const to = await folder(toLibraryId);
      return move ? from.moveGuideTo(guideId, to) : from.copyGuideTo(guideId, to);
    }
    const incomplete = (error: unknown) =>
      new LibraryError(
        "moveIncomplete",
        `The guide was copied, but the original could not be moved to the bin: ${error instanceof Error ? error.message : String(error)}`,
      );
    // A moved guide keeps its password lock and history (04/10/2026); copies leave them behind.
    const carry = async (id: string) => {
      if (!move) return;
      const meta = await bridge.guideMeta(fromLibraryId, guideId);
      if (meta.history) await bridge.writeGuideHistory(toLibraryId, id, meta.history);
      if (meta.lock) await bridge.writeGuideLock(toLibraryId, id, meta.lock);
    };
    if (isBrowser(fromLibraryId)) {
      const to = await folder(toLibraryId);
      const bundle = await browserBundle(db, guideId);
      if (!move) asCopy(bundle);
      const id = await to.chooseId(guideId);
      await putFolderBundle(to, bundle, id, options.pc);
      await carry(id);
      const summary = await to.summary(id);
      if (move)
        await browser.trashGuide(fromLibraryId, guideId).catch((error: unknown) => {
          throw incomplete(error);
        });
      return summary;
    }
    const from = await folder(fromLibraryId);
    const bundle = await folderBundle(from, guideId);
    if (!move) asCopy(bundle);
    const id = await putBrowserBundle(db, codec, bundle, guideId);
    await carry(id);
    const summary = (await browser.listGuides(toLibraryId)).find((guide) => guide.id === id);
    if (!summary) throw errors.guideNotFound();
    if (move)
      await from.trashGuide(guideId).catch((error: unknown) => {
        throw incomplete(error);
      });
    return summary;
  };

  const bridge: LibraryRouter = {
    session,

    async listLibraries() {
      const chosen = await defaultId();
      const own = (await browser.listLibraries()).map((item) => ({
        ...item,
        isDefault: chosen === item.id,
        builtIn: true,
      }));
      const folders = await Promise.all(
        (await registry.list()).map((entry) => folderInfo(entry, entry.id === chosen)),
      );
      return [...own, ...folders];
    },

    async allowAccess(libraryId) {
      if (isBrowser(libraryId)) return true;
      return (await registered(libraryId)).folder.permitted(true);
    },

    async addLibrary(name, path) {
      const chosen = picked.get(path);
      // A path from elsewhere (a backup made on the desktop, say) can't be opened in a browser.
      if (!chosen) throw errors.invalid("Choose the folder with “Add a library…” in this browser.");
      const cleaned = validName(name);
      const known = await registry.list();
      for (const entry of known)
        if (await entry.folder.same(chosen))
          throw new LibraryError("libraryExists", "That folder is already one of your libraries.");
      if (!(await chosen.permitted(true))) throw folderAccess(chosen.name);
      const folderId = await prepareFolder(chosen.open(), cleaned);
      // A copied library folder carries its original's id: the copy gets its own here.
      const taken = new Set([BROWSER_LIBRARY_ID, ...known.map((entry) => entry.id)]);
      const id = taken.has(folderId) ? newId() : folderId;
      await registry.put({ id, name: cleaned, folder: chosen });
      picked.delete(path);
      return info(id);
    },

    async renameLibrary(libraryId, name) {
      if (isBrowser(libraryId)) throw errors.notInBrowser();
      const entry = await registered(libraryId);
      await registry.put({ ...entry, name: validName(name) });
      return info(libraryId);
    },

    async removeLibrary(libraryId) {
      if (isBrowser(libraryId))
        throw errors.invalid("The library in this browser can't be taken off the list.");
      await registered(libraryId);
      if ((await defaultId()) === libraryId)
        throw new LibraryError(
          "defaultLibrary",
          "The default library can't be removed. Make another library the default first.",
        );
      await registry.remove(libraryId);
      opened.delete(libraryId);
    },

    async setDefaultLibrary(libraryId) {
      if (isBrowser(libraryId)) await registry.setDefaultId(null);
      else {
        const library = await folder(libraryId, true);
        await library.root.makeFolder("guides");
        await registry.setDefaultId(libraryId);
      }
      return info(libraryId);
    },

    listGuides: async (libraryId) =>
      isBrowser(libraryId) ? browser.listGuides(libraryId) : (await folder(libraryId)).listGuides(),

    async searchGuides(libraryId, query) {
      if (isBrowser(libraryId)) return browser.searchGuides(libraryId, query);
      // Each search replaces the one before, which stops reading as soon as a newer one starts.
      latestSearch += 1;
      const mine = latestSearch;
      return (await folder(libraryId)).search(query, () => latestSearch === mine);
    },

    loadGuide: async (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.loadGuide(libraryId, guideId)
        : (await folder(libraryId)).loadGuide(guideId),

    createGuide: async (libraryId, title) =>
      isBrowser(libraryId)
        ? browser.createGuide(libraryId, title)
        : (await folder(libraryId)).createGuide(title, me()),

    /**
     * Takes the lock when nobody holds it, or when the holder is this person in this browser in a
     * page that has closed, or when this page has watched the holder's counter stand still for
     * 20 minutes. Otherwise the guide is read-only.
     */
    async openForEditing(libraryId, guideId, takeOver): Promise<Editing> {
      if (isBrowser(libraryId)) return browser.openForEditing(libraryId, guideId, takeOver);
      const library = await folder(libraryId);
      const me = holder();
      let outcome = await openForEditing(library, guideId, me, takeOver);
      if (outcome.kind === "theirs") {
        const lock = outcome.lock;
        const closedHere =
          lock.name === me.name && lock.pc === me.pc && !(await alive(lock.session));
        const stale = observe(key(libraryId, guideId), lock);
        if (closedHere || stale) outcome = await openForEditing(library, guideId, me, true);
      }
      if (outcome.kind === "theirs") return { kind: "readOnly", lock: outcome.lock };
      held.set(key(libraryId, guideId), { libraryId, guideId });
      return { kind: "editing" };
    },

    async releaseLock(libraryId, guideId) {
      if (isBrowser(libraryId)) return browser.releaseLock(libraryId, guideId);
      held.delete(key(libraryId, guideId));
      await releaseLock(await folder(libraryId), guideId, session);
    },

    onLockLost(handler) {
      lostHandlers.add(handler);
      return Promise.resolve(() => {
        lostHandlers.delete(handler);
      });
    },

    fingerprint: async (libraryId) =>
      isBrowser(libraryId)
        ? browser.fingerprint(libraryId)
        : (await folder(libraryId)).fingerprint(),

    guideFingerprint: async (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.guideFingerprint(libraryId, guideId)
        : (await folder(libraryId)).guideFingerprint(guideId),

    listConflicts: async (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.listConflicts(libraryId, guideId)
        : listConflicts(await folder(libraryId), guideId),

    resolveConflict: (libraryId, guideId, conflict, choice) =>
      isBrowser(libraryId)
        ? browser.resolveConflict(libraryId, guideId, conflict, choice)
        : writing(libraryId, guideId, (library) =>
            resolveConflict(library, guideId, conflict, choice),
          ),

    // Not lock-checked: this is what an editor who lost the lock does with work it can't save.
    saveDraft: async (libraryId, guideId, draft) =>
      isBrowser(libraryId)
        ? browser.saveDraft(libraryId, guideId, draft)
        : saveDraft(await folder(libraryId), guideId, session, me(), draft),

    listDrafts: async (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.listDrafts(libraryId, guideId)
        : listDrafts(await folder(libraryId), guideId),

    discardDraft: async (libraryId, guideId, draftId) =>
      isBrowser(libraryId)
        ? browser.discardDraft(libraryId, guideId, draftId)
        : discardDraft(await folder(libraryId), guideId, draftId),

    draftToCopy: async (libraryId, guideId, draftId, title) =>
      isBrowser(libraryId)
        ? browser.draftToCopy(libraryId, guideId, draftId, title)
        : draftToCopy(await folder(libraryId), guideId, draftId, title),

    // A guide's password lock and history: files of their own, written without the edit lock
    // (locking a guide someone else has open is allowed; they can't save over it after).
    guideMeta: async (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.guideMeta(libraryId, guideId)
        : (await folder(libraryId)).guideMeta(guideId),

    writeGuideLock: async (libraryId, guideId, lock) =>
      isBrowser(libraryId)
        ? browser.writeGuideLock(libraryId, guideId, lock)
        : (await folder(libraryId)).writeGuideLock(guideId, lock),

    writeGuideHistory: async (libraryId, guideId, history) =>
      isBrowser(libraryId)
        ? browser.writeGuideHistory(libraryId, guideId, history)
        : (await folder(libraryId)).writeGuideHistory(guideId, history),

    guideStats: async (libraryId, guideId) =>
      isBrowser(libraryId)
        ? (browser.guideStats?.(libraryId, guideId) ?? Promise.reject(errors.notInBrowser()))
        : (await folder(libraryId)).guideStats(guideId),

    // Comments are files of their own and never change the guide: no lock needed.
    listComments: async (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.listComments(libraryId, guideId)
        : listComments(await folder(libraryId), guideId, who()),

    addComment: async (libraryId, guideId, stepId, replyTo, text) =>
      isBrowser(libraryId)
        ? browser.addComment(libraryId, guideId, stepId, replyTo, text)
        : addComment(await folder(libraryId), guideId, stepId, replyTo, text, who()),

    resolveComment: async (libraryId, guideId, thread, resolved) =>
      isBrowser(libraryId)
        ? browser.resolveComment(libraryId, guideId, thread, resolved)
        : setCommentResolved(await folder(libraryId), guideId, thread, resolved, who()),

    deleteComment: async (libraryId, guideId, comment) =>
      isBrowser(libraryId)
        ? browser.deleteComment(libraryId, guideId, comment)
        : deleteComment(await folder(libraryId), guideId, comment, who()),

    saveGuide: (libraryId, guideId, guide) =>
      isBrowser(libraryId)
        ? browser.saveGuide(libraryId, guideId, guide)
        : writing(libraryId, guideId, (library) => library.saveGuide(guideId, guide)),

    saveStep: (libraryId, guideId, step) =>
      isBrowser(libraryId)
        ? browser.saveStep(libraryId, guideId, step)
        : writing(libraryId, guideId, async (library) => {
            await library.saveStep(guideId, step);
            // Saving a step this page deleted (Undo) isn't someone bringing it back.
            const id = (step as { id?: unknown } | null)?.id;
            if (typeof id === "string") await forgetOwnDelete(library, guideId, id, session);
          }),

    deleteStep: (libraryId, guideId, stepId) =>
      isBrowser(libraryId)
        ? browser.deleteStep(libraryId, guideId, stepId)
        : writing(libraryId, guideId, async (library) => {
            await library.deleteStep(guideId, stepId);
            // So an edit someone else made meanwhile comes back flagged, not silently.
            await noteDelete(library, guideId, stepId, me(), session);
          }),

    importImage: async (libraryId, guideId, bytes) =>
      isBrowser(libraryId)
        ? browser.importImage(libraryId, guideId, bytes)
        : (await folder(libraryId)).importImage(guideId, bytes),

    retakeImage: (libraryId, guideId, delayMs, excluded, quality) =>
      browser.retakeImage(libraryId, guideId, delayMs, excluded, quality),

    loadImage: async (libraryId, guideId, mediaId, thumbnail) =>
      isBrowser(libraryId)
        ? browser.loadImage(libraryId, guideId, mediaId, thumbnail)
        : dataUrl(await (await folder(libraryId)).loadImage(guideId, mediaId, thumbnail)),

    trashGuide: (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.trashGuide(libraryId, guideId)
        : writing(libraryId, guideId, async (library) => {
            held.delete(key(libraryId, guideId));
            return library.trashGuide(guideId);
          }),

    listTrash: async (libraryId) =>
      isBrowser(libraryId) ? browser.listTrash(libraryId) : (await folder(libraryId)).listTrash(),

    restoreGuide: async (libraryId, trashId) =>
      isBrowser(libraryId)
        ? browser.restoreGuide(libraryId, trashId)
        : (await folder(libraryId)).restoreGuide(trashId),

    deleteTrashed: async (libraryId, trashId) =>
      isBrowser(libraryId)
        ? browser.deleteTrashed(libraryId, trashId)
        : (await folder(libraryId)).deleteTrashed(trashId),

    emptyTrash: async (libraryId) =>
      isBrowser(libraryId) ? browser.emptyTrash(libraryId) : (await folder(libraryId)).emptyTrash(),

    duplicateGuide: async (libraryId, guideId, title) =>
      isBrowser(libraryId)
        ? browser.duplicateGuide(libraryId, guideId, title)
        : (await folder(libraryId)).duplicateGuide(guideId, title),

    /**
     * Merge guides: the screenshots are read from each guide they come from (the browser's
     * library or a folder) and written with the new guide, as one bundle.
     */
    async createFromParts(libraryId, guide, steps, media) {
      const sources = new Map<string, Promise<GuideBundle>>();
      const sourceOf = (fromLibraryId: string, fromGuideId: string) => {
        const sourceKey = key(fromLibraryId, fromGuideId);
        let bundle = sources.get(sourceKey);
        if (!bundle) {
          bundle = isBrowser(fromLibraryId)
            ? browserBundle(db, fromGuideId)
            : folder(fromLibraryId).then((library) => folderBundle(library, fromGuideId));
          sources.set(sourceKey, bundle);
        }
        return bundle;
      };
      const pictures: GuideBundle["media"] = [];
      for (const item of media) {
        const source = await sourceOf(item.fromLibraryId, item.fromGuideId);
        const found = source.media.find((picture) => picture.id === item.mediaId);
        if (!found) throw errors.imageNotFound();
        pictures.push({ id: item.newMediaId, image: found.image, thumbnail: found.thumbnail });
      }
      const made = isObject(guide) ? { ...guide } : {};
      const bundle: GuideBundle = {
        guide: made,
        steps: steps.filter(isObject),
        media: pictures,
        versions: [],
        comments: [],
        burned: {},
      };
      const guideId = typeof made.id === "string" ? made.id : "";
      if (isBrowser(libraryId)) {
        const id = await putBrowserBundle(db, codec, bundle, guideId);
        const summary = (await browser.listGuides(libraryId)).find((item) => item.id === id);
        if (!summary) throw errors.guideNotFound();
        return summary;
      }
      const target = await folder(libraryId);
      if ((await target.chooseId(guideId)) !== guideId) throw errors.guideExists();
      await putFolderBundle(target, bundle, guideId, options.pc);
      return target.summary(guideId);
    },

    copyGuide: (from, guideId, to) => transfer(from, guideId, to, false),
    moveGuide: (from, guideId, to) => transfer(from, guideId, to, true),

    saveVersion: async (libraryId, guideId, note) =>
      isBrowser(libraryId)
        ? browser.saveVersion(libraryId, guideId, note)
        : saveVersion(await folder(libraryId), guideId, note, me()),

    applyRedactions: (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.applyRedactions(libraryId, guideId)
        : writing(libraryId, guideId, (library) => applyRedactions(library, guideId)),

    listVersions: async (libraryId, guideId) =>
      isBrowser(libraryId)
        ? browser.listVersions(libraryId, guideId)
        : listVersions(await folder(libraryId), guideId),

    loadVersion: async (libraryId, guideId, versionId) =>
      isBrowser(libraryId)
        ? browser.loadVersion(libraryId, guideId, versionId)
        : loadVersion(await folder(libraryId), guideId, versionId),

    restoreVersion: (libraryId, guideId, versionId) =>
      isBrowser(libraryId)
        ? browser.restoreVersion(libraryId, guideId, versionId)
        : writing(libraryId, guideId, (library) =>
            restoreVersion(library, guideId, versionId, me()),
          ),

    async exportAmlsteps(libraryId, guideId, destination, includeOriginals) {
      if (isBrowser(libraryId))
        return browser.exportAmlsteps(libraryId, guideId, destination, includeOriginals);
      const library = await folder(libraryId);
      const { guide, steps } = await library.loadGuide(guideId);
      const bytes = await exportArchive(
        {
          guide,
          steps,
          image: (mediaId) => library.loadImage(guideId, mediaId, false).catch(() => null),
        },
        codec,
        includeOriginals,
        options.appVersion,
      );
      await files.write(destination, bytes, "application/zip");
    },

    async importAmlsteps(libraryId, source) {
      if (isBrowser(libraryId)) return browser.importAmlsteps(libraryId, source);
      const library = await folder(libraryId);
      const imported = await readArchive(codec, await files.read(source));
      const id = await library.chooseId(isSafeId(imported.guide.id) ? imported.guide.id : "");
      await library.publish(id, imported.guide, imported.steps, imported.media);
      return library.summary(id);
    },

    storageUse: (libraryId) =>
      isBrowser(libraryId) && browser.storageUse
        ? browser.storageUse(libraryId)
        : // A folder takes no browser storage.
          Promise.reject(errors.notInBrowser()),

    pickExportFolder: (title) => browser.pickExportFolder?.(title) ?? Promise.resolve(null),

    exportAndRemove: (libraryId, guideId, folderToken) =>
      isBrowser(libraryId) && browser.exportAndRemove
        ? browser.exportAndRemove(libraryId, guideId, folderToken)
        : Promise.reject(errors.notInBrowser()),

    async pickFolder() {
      const chosen = await options.pickFolder?.();
      if (!chosen) return null;
      // The UI names a new library after the last part of this, as it does a desktop path.
      picks += 1;
      const token = `picked/${picks}/${chosen.name}`;
      picked.set(token, chosen);
      return token;
    },
    pickFile: (title, filters) => browser.pickFile(title, filters),
    pickSaveLocation: (title, name, filters) => browser.pickSaveLocation(title, name, filters),

    async publishTarget(libraryId) {
      const id = libraryId ?? (await defaultId());
      if (isBrowser(id)) return browserTarget(db);
      const library = await folder(id, true);
      return {
        recordingOf: (guideId) => library.recordingOf(guideId),
        publish: (guideId, guide, steps, media) => library.publish(guideId, guide, steps, media),
        // Into a guide open for editing: only while this page holds its edit lock.
        addMedia: (guideId, media) =>
          writing(id, guideId, (folder) => folder.addMedia(guideId, media)),
      };
    },

    async beat() {
      for (const [heldKey, { libraryId, guideId }] of [...held]) {
        try {
          const result = await heartbeat(await folder(libraryId), guideId, holder());
          if (result.kind !== "displaced") continue;
          held.delete(heldKey);
          for (const handler of lostHandlers) handler({ libraryId, guideId, lock: result.lock });
        } catch {
          // A guide that has gone, or a folder that's away: tried again next time.
        }
      }
    },
  };

  /** Notes another person's lock as seen now, and says whether it has gone stale. */
  function observe(watchKey: string, lock: EditLock): boolean {
    const seen = watched.get(watchKey);
    if (!seen || seen.session !== lock.session || seen.counter !== lock.counter) {
      watched.set(watchKey, { session: lock.session, counter: lock.counter, since: now() });
      return false;
    }
    return now() - seen.since >= STALE_AFTER_MS;
  }

  return bridge;
}
