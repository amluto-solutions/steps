import type {
  CommentThread,
  LibraryBridge,
  LibraryGuideSummary,
  LibraryInfo,
  MediaInfo,
  RawGuideDocument,
  ReviewComment,
  StorageUse,
} from "@amluto-steps/ui";

import type { FileAccess } from "../files";
import { lastEdited } from "../folder/files";
import { browserSource, exportArchive, importArchive } from "./archive";
import { burnRedactions, type Rect } from "./blur";
import {
  GUIDE_STORES,
  type Json,
  type LibraryDb,
  type StoredComment,
  type StoredMedia,
  type StoredStep,
  type StoredTrash,
  type StoredVersion,
  type TrashEntry,
  type VersionInfo,
} from "./db";
import {
  byString,
  checkFormatVersion,
  checkId,
  cleanTitle,
  errors,
  isSafeId,
  newId,
  nowIso,
  sortSteps,
  text,
  UNTITLED,
} from "./ids";
import {
  dataUrl,
  fit,
  prepareImage,
  THUMBNAIL_EDGE,
  THUMBNAIL_QUALITY,
  WEBP_QUALITY,
  type ImageCodec,
} from "./images";
import { queryWords, searchGuide, type SearchHit } from "./search";

/**
 * The library for Steps for Chrome: one library of guides in this browser profile's IndexedDB,
 * behaving as the desktop's `library` crate does for everything a single person's library needs.
 * What only a shared folder has (edit locks, sync conflicts, drafts, other libraries) is a no-op.
 */

export const BROWSER_LIBRARY_ID = "browser";

/** A picture for a guide being published. */
export interface NewMedia {
  id: string;
  image: Blob;
  width: number;
  height: number;
}

/**
 * Where a finished recording is published: the default library, which is the browser's own or a
 * shared folder (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome).
 */
export interface PublishTarget {
  /** The recording a guide with this id came from: "" when none, null when there's no such guide. */
  recordingOf(guideId: string): Promise<string | null>;
  /** Writes the whole guide, or nothing. */
  publish(guideId: string, guide: Json, steps: Json[], media: NewMedia[]): Promise<void>;
  /**
   * Adds pictures to a guide that's already there: a recording made into it while it's open
   * (docs/spec/04-editor.md#record-steps-here). Never over one it has; all of them, or none.
   */
  addMedia(guideId: string, media: NewMedia[]): Promise<void>;
}

/** The browser's own library, as a place to publish into. */
export const browserTarget = (db: LibraryDb): PublishTarget => ({
  async recordingOf(guideId) {
    const existing = await db.get("guides", guideId);
    return existing ? text(existing.guide, "recordingSessionId") : null;
  },
  async publish(guideId, guide, steps, media) {
    const tx = db.transaction(["guides", "steps", "media"], "readwrite");
    await tx.objectStore("guides").put({ id: guideId, guide: { ...guide, id: guideId } });
    for (const step of steps)
      await tx.objectStore("steps").put({ guideId, id: text(step, "id"), step });
    for (const item of media)
      await tx.objectStore("media").put({ ...item, guideId, thumbnail: null });
    await tx.done;
  },
  async addMedia(guideId, media) {
    const tx = db.transaction(["guides", "media"], "readwrite");
    try {
      if (!(await tx.objectStore("guides").get(guideId))) throw errors.guideNotFound();
      for (const item of media) {
        const id = checkId(item.id, "image");
        // `add` refuses a key that's there, which aborts the whole transaction.
        await tx.objectStore("media").add({ ...item, id, guideId, thumbnail: null });
      }
    } catch (error) {
      // A refused `add` has aborted it already; nothing is left half-written either way.
      await tx.done.catch(() => undefined);
      throw error;
    }
    await tx.done;
  },
});
const TRASH_DAYS = 30;
const MAX_NOTE = 1000;
const MAX_COMMENT = 5000;

export interface BrowserLibraryOptions {
  db: LibraryDb;
  codec: ImageCodec;
  /** The name in Settings, for new guides, versions and comments. */
  displayName: () => string;
  /** The library's name in the list. */
  name?: string;
  /** Choosing and saving files (`browserFiles()`), for `.amlsteps` files. */
  files: FileAccess;
  /** Written into `.amlsteps` files, as the desktop writes its version. */
  appVersion: string;
}

const pad = (value: number) => String(value).padStart(2, "0");
/** "29/09/2026 10:32", local time, for the version kept before a restore. */
const localStamp = (date: Date) =>
  `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

const obj = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

const stepMediaId = (step: Json): string | null => {
  const id = obj(step.media).id;
  return isSafeId(id) ? id : null;
};

/** Who locked a guide and when, from its lock as stored. */
function lockedOf(lock: Json | null): { by: string; at: string } | null {
  const locked = lock?.locked;
  if (!locked || typeof locked !== "object") return null;
  const who = locked as Json;
  return typeof who.by === "string"
    ? { by: who.by, at: typeof who.at === "string" ? who.at : "" }
    : null;
}

function summaryOf(guide: Json, steps: Json[], openComments: number): LibraryGuideSummary {
  const sorted = sortSteps(steps);
  const thumbnail = sorted.map(stepMediaId).find((id) => id !== null) ?? null;
  return {
    id: text(guide, "id"),
    title: text(guide, "title", UNTITLED),
    updatedAt: lastEdited(text(guide, "updatedAt"), steps),
    stepCount: steps.filter((step) => obj(step).kind !== "block").length,
    tags: Array.isArray(guide.tags)
      ? guide.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    owner: text(guide, "owner"),
    reviewBy: typeof guide.reviewBy === "string" ? guide.reviewBy : null,
    thumbnailMediaId: thumbnail,
    openComments,
  };
}

const encoder = new TextEncoder();
/** What a JSON value takes in storage, near enough (IndexedDB keeps structured clones). */
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value) ?? "").length;
const mediaBytes = (media: StoredMedia) => media.image.size + (media.thumbnail?.size ?? 0);

/** "Payroll", made safe as a file name: characters Windows refuses become spaces. */
const fileStem = (title: string) =>
  [...title]
    .map((character) =>
      character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? " " : character,
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || UNTITLED;

/** Comment threads from their entries, oldest first, as the desktop builds them. */
function threads(entries: StoredComment[], me: string): CommentThread[] {
  const sorted = [...entries].sort((a, b) => byString(a.at, b.at) || byString(a.id, b.id));
  const asComment = (entry: StoredComment): ReviewComment => ({
    id: entry.id,
    text: entry.text,
    by: entry.by,
    at: entry.at,
    mine: entry.by === me,
  });
  const result: CommentThread[] = sorted
    .filter((entry) => entry.action === "comment" && entry.thread === null)
    .map((entry) => ({ ...asComment(entry), stepId: entry.stepId, replies: [], resolved: null }));
  for (const entry of sorted) {
    const found = result.find((thread) => thread.id === entry.thread);
    if (!found) continue;
    if (entry.action === "comment") found.replies.push(asComment(entry));
    else if (entry.action === "resolve") found.resolved = { by: entry.by, at: entry.at };
    else found.resolved = null;
  }
  return result;
}

export function createBrowserLibrary(options: BrowserLibraryOptions): LibraryBridge {
  const { db, codec } = options;
  const me = () => options.displayName().trim() || "Someone";

  const bump = async () => {
    const tx = db.transaction("meta", "readwrite");
    const stored = await tx.store.get("revision");
    const current = typeof stored === "number" ? stored : 0;
    await tx.store.put(current + 1, "revision");
    await tx.done;
  };

  const requireGuide = async (guideId: string) => {
    checkId(guideId, "guide");
    const stored = await db.get("guides", guideId);
    if (!stored || text(stored.guide, "id") !== guideId) throw errors.guideNotFound();
    return stored.guide;
  };

  const stepsOf = async (guideId: string) =>
    sortSteps((await db.getAllFromIndex("steps", "guide", guideId)).map((stored) => stored.step));

  const openComments = async (guideId: string) =>
    threads(await db.getAllFromIndex("comments", "guide", guideId), "").filter(
      (thread) => thread.resolved === null,
    ).length;

  const lockKey = (guideId: string) => `lock:${guideId}`;
  const historyKey = (guideId: string) => `history:${guideId}`;
  const stored = async (key: string) => {
    const value = await db.get("meta", key);
    return typeof value === "object" ? value : null;
  };

  const summary = async (guideId: string) => {
    const guide = await requireGuide(guideId);
    const found = summaryOf(guide, await stepsOf(guideId), await openComments(guideId));
    const locked = lockedOf(await stored(lockKey(guideId)));
    return locked ? { ...found, locked } : found;
  };

  const library = async (): Promise<LibraryInfo> => ({
    id: BROWSER_LIBRARY_ID,
    name: options.name ?? "My guides",
    path: "",
    isDefault: true,
    managed: false,
    synced: false,
    guideCount: await db.count("guides"),
  });

  const checkLibrary = (libraryId: string) => {
    if (libraryId !== BROWSER_LIBRARY_ID) throw errors.notInBrowser();
  };

  /** Every guide's data, read in one transaction, for trash, duplicate and restore. */
  const readAll = async (guideId: string) => {
    const tx = db.transaction(GUIDE_STORES, "readonly");
    const range = IDBKeyRange.only(guideId);
    const [guide, steps, media, versions, comments, burned] = await Promise.all([
      tx.objectStore("guides").get(guideId),
      tx.objectStore("steps").index("guide").getAll(range),
      tx.objectStore("media").index("guide").getAll(range),
      tx.objectStore("versions").index("guide").getAll(range),
      tx.objectStore("comments").index("guide").getAll(range),
      tx.objectStore("burned").get(guideId),
    ]);
    await tx.done;
    return { guide, steps, media, versions, comments, burned: burned ?? null };
  };

  const saveVersionNow = async (guideId: string, note: string): Promise<VersionInfo> => {
    const guide = await requireGuide(guideId);
    const steps = await stepsOf(guideId);
    const info: VersionInfo = {
      id: newId(),
      createdAt: nowIso(),
      note,
      createdBy: me(),
      stepCount: steps.filter((step) => obj(step).kind !== "block").length,
    };
    await db.put("versions", { guideId, id: info.id, info, guide, steps });
    return info;
  };

  /**
   * Each guide's bytes in storage: pictures and thumbnails, steps, versions and comments, read in
   * one pass (docs/spec/03-data-and-sharing.md#chrome-edition-storage).
   */
  const guideSizes = async (): Promise<Map<string, number>> => {
    const sizes = new Map<string, number>();
    const add = (guideId: string, bytes: number) =>
      sizes.set(guideId, (sizes.get(guideId) ?? 0) + bytes);
    const tx = db.transaction(GUIDE_STORES, "readonly");
    const [guides, steps, media, versions, comments] = await Promise.all([
      tx.objectStore("guides").getAll(),
      tx.objectStore("steps").getAll(),
      tx.objectStore("media").getAll(),
      tx.objectStore("versions").getAll(),
      tx.objectStore("comments").getAll(),
    ]);
    await tx.done;
    for (const stored of guides) add(stored.id, jsonBytes(stored.guide));
    for (const stored of steps) add(stored.guideId, jsonBytes(stored.step));
    for (const stored of media) add(stored.guideId, mediaBytes(stored));
    for (const stored of versions)
      add(stored.guideId, jsonBytes(stored.guide) + jsonBytes(stored.steps));
    for (const stored of comments) add(stored.guideId, jsonBytes(stored));
    return sizes;
  };

  /** What the Bin keeps: each guide in it with everything that went with it. */
  const trashBytes = async () =>
    (await db.getAll("trash")).reduce(
      (sum, record) =>
        sum +
        jsonBytes(record.guide.guide) +
        record.steps.reduce((part, step) => part + jsonBytes(step.step), 0) +
        record.media.reduce((part, media) => part + mediaBytes(media), 0) +
        record.versions.reduce(
          (part, version) => part + jsonBytes(version.guide) + jsonBytes(version.steps),
          0,
        ) +
        record.comments.reduce((part, comment) => part + jsonBytes(comment), 0),
      0,
    );

  const bridge: LibraryBridge = {
    listLibraries: async () => [await library()],
    addLibrary: () => Promise.reject(errors.notInBrowser()),
    renameLibrary: () => Promise.reject(errors.notInBrowser()),
    removeLibrary: () => Promise.reject(errors.notInBrowser()),
    setDefaultLibrary: async () => library(),

    async listGuides(libraryId) {
      checkLibrary(libraryId);
      const guides = await db.getAll("guides");
      const summaries = await Promise.all(
        guides
          .filter((stored) => text(stored.guide, "id") === stored.id)
          .map((stored) => summary(stored.id)),
      );
      const sizes = await guideSizes();
      return summaries
        .map((item) => ({ ...item, sizeBytes: sizes.get(item.id) ?? 0 }))
        .sort((a, b) => byString(b.updatedAt, a.updatedAt) || byString(a.id, b.id));
    },

    async searchGuides(libraryId, query) {
      checkLibrary(libraryId);
      const words = queryWords(query);
      const hits: SearchHit[] = [];
      for (const stored of await db.getAll("guides")) {
        if (text(stored.guide, "id") !== stored.id) continue;
        const hit = searchGuide(stored.id, stored.guide, await stepsOf(stored.id), words);
        if (hit) hits.push(hit);
      }
      return hits;
    },

    async loadGuide(libraryId, guideId) {
      checkLibrary(libraryId);
      return { guide: await requireGuide(guideId), steps: await stepsOf(guideId) };
    },

    async createGuide(libraryId, title) {
      checkLibrary(libraryId);
      const now = nowIso();
      const author = me();
      const guide: Json = {
        id: newId(),
        title: cleanTitle(title),
        description: "",
        intro: null,
        outro: null,
        brandProfileId: null,
        tags: [],
        owner: author,
        reviewBy: null,
        createdAt: now,
        createdBy: author,
        updatedAt: now,
        updatedBy: author,
        formatVersion: 1,
      };
      await db.put("guides", { id: guide.id as string, guide });
      await bump();
      return { guide, steps: [] };
    },

    // One person, one browser: always theirs to edit.
    openForEditing: () => Promise.resolve({ kind: "editing" }),
    releaseLock: () => Promise.resolve(),
    onLockLost: () => Promise.resolve(() => undefined),
    fingerprint: async () => String((await db.get("meta", "revision")) ?? 0),
    guideFingerprint: async () => String((await db.get("meta", "revision")) ?? 0),
    listConflicts: () => Promise.resolve([]),
    resolveConflict: () => Promise.resolve(),
    saveDraft: () => Promise.resolve(),
    listDrafts: () => Promise.resolve([]),
    discardDraft: () => Promise.resolve(),
    draftToCopy: () => Promise.reject(errors.notInBrowser()),

    async listComments(libraryId, guideId) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      return threads(await db.getAllFromIndex("comments", "guide", guideId), me());
    },

    async addComment(libraryId, guideId, stepId, replyTo, body) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const trimmed = body.trim();
      if (!trimmed || [...trimmed].length > MAX_COMMENT)
        throw errors.invalid(`a comment has 1 to ${MAX_COMMENT} characters`);
      if (stepId !== null) checkId(stepId, "step");
      if (replyTo !== null) {
        const existing = threads(await db.getAllFromIndex("comments", "guide", guideId), me());
        if (!existing.some((thread) => thread.id === replyTo))
          throw errors.invalid("that comment has been deleted");
      }
      const entry: StoredComment = {
        guideId,
        id: newId(),
        action: "comment",
        thread: replyTo,
        stepId: replyTo === null ? stepId : null,
        text: trimmed,
        by: me(),
        at: nowIso(),
      };
      await db.put("comments", entry);
      await bump();
      return entry.id;
    },

    async resolveComment(libraryId, guideId, thread, resolved) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const found = threads(await db.getAllFromIndex("comments", "guide", guideId), me()).find(
        (each) => each.id === thread,
      );
      if (!found) throw errors.invalid("that comment has been deleted");
      if ((found.resolved !== null) === resolved) return;
      await db.put("comments", {
        guideId,
        id: newId(),
        action: resolved ? "resolve" : "reopen",
        thread,
        stepId: null,
        text: "",
        by: me(),
        at: nowIso(),
      });
      await bump();
    },

    async deleteComment(libraryId, guideId, comment) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const entries = await db.getAllFromIndex("comments", "guide", guideId);
      const target = entries.find((entry) => entry.id === comment && entry.action === "comment");
      if (!target) throw errors.invalid("that comment has been deleted");
      if (target.by !== me())
        throw errors.invalid("only the person who wrote a comment can delete it");
      const remove = [target.id];
      if (target.thread === null) {
        const rest = entries.filter((entry) => entry.thread === comment);
        if (rest.some((entry) => entry.action === "comment"))
          throw errors.invalid("a comment with replies can't be deleted");
        remove.push(...rest.map((entry) => entry.id));
      }
      const tx = db.transaction("comments", "readwrite");
      await Promise.all(remove.map((id) => tx.store.delete([guideId, id])));
      await tx.done;
      await bump();
    },

    async saveGuide(libraryId, guideId, guide) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const value = obj(guide);
      if (text(value, "id") !== guideId)
        throw errors.invalid("The guide's id doesn't match the guide being saved.");
      checkFormatVersion(value, "guide");
      await db.put("guides", { id: guideId, guide: value });
      await bump();
    },

    async saveStep(libraryId, guideId, step) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const value = obj(step);
      const id = checkId(value.id ?? "", "step");
      checkFormatVersion(value, "step");
      await db.put("steps", { guideId, id, step: value });
      await bump();
    },

    async deleteStep(libraryId, guideId, stepId) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      await db.delete("steps", [guideId, checkId(stepId, "step")]);
      await bump();
    },

    async importImage(libraryId, guideId, bytes): Promise<MediaInfo> {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const prepared = await prepareImage(codec, bytes);
      const media: StoredMedia = {
        guideId,
        id: newId(),
        image: prepared.blob,
        thumbnail: null,
        width: prepared.width,
        height: prepared.height,
      };
      await db.put("media", media);
      return { id: media.id, width: media.width, height: media.height };
    },

    // A retake captures the screen, which the Chrome edition does through its recorder.
    retakeImage: () => Promise.reject(errors.notInBrowser()),

    async loadImage(libraryId, guideId, mediaId, thumbnail) {
      checkLibrary(libraryId);
      checkId(mediaId, "image");
      await requireGuide(guideId);
      const media = await db.get("media", [guideId, mediaId]);
      if (!media) throw errors.imageNotFound();
      if (!thumbnail) return dataUrl(media.image);
      if (media.thumbnail) return dataUrl(media.thumbnail);
      const size = fit(media.width, media.height, THUMBNAIL_EDGE);
      const small = await codec.render(media.image, size.width, size.height, THUMBNAIL_QUALITY);
      // Kept for next time; if that fails, the fresh one is still shown.
      await db.put("media", { ...media, thumbnail: small }).catch(() => undefined);
      return dataUrl(small);
    },

    async trashGuide(libraryId, guideId) {
      checkLibrary(libraryId);
      const guide = await requireGuide(guideId);
      const all = await readAll(guideId);
      let trashId = `${guideId}-${Date.now()}`;
      if (!isSafeId(trashId) || (await db.get("trash", trashId))) trashId = newId();
      const entry: TrashEntry = {
        trashId,
        guideId,
        title: text(guide, "title", UNTITLED),
        deletedAt: nowIso(),
      };
      const record: StoredTrash = {
        trashId,
        entry,
        guide: { id: guideId, guide },
        steps: all.steps,
        media: all.media,
        versions: all.versions,
        comments: all.comments,
        burned: all.burned,
      };
      const tx = db.transaction([...GUIDE_STORES, "trash"], "readwrite");
      await tx.objectStore("trash").put(record);
      await tx.objectStore("guides").delete(guideId);
      for (const step of all.steps) await tx.objectStore("steps").delete([guideId, step.id]);
      for (const media of all.media) await tx.objectStore("media").delete([guideId, media.id]);
      for (const version of all.versions)
        await tx.objectStore("versions").delete([guideId, version.id]);
      for (const comment of all.comments)
        await tx.objectStore("comments").delete([guideId, comment.id]);
      await tx.objectStore("burned").delete(guideId);
      await tx.done;
      // The Bin takes a password lock off (04/10/2026); the history stays for a restore.
      await db.delete("meta", lockKey(guideId));
      await bump();
      return entry;
    },

    async listTrash(libraryId) {
      checkLibrary(libraryId);
      const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
      const kept: TrashEntry[] = [];
      for (const record of await db.getAll("trash")) {
        const deleted = Date.parse(record.entry.deletedAt);
        if (Number.isFinite(deleted) && deleted < cutoff) {
          await db.delete("trash", record.trashId);
          continue;
        }
        kept.push(record.entry);
      }
      return kept.sort((a, b) => byString(b.deletedAt, a.deletedAt));
    },

    async restoreGuide(libraryId, trashId) {
      checkLibrary(libraryId);
      checkId(trashId, "bin entry");
      const record = await db.get("trash", trashId);
      if (!record) throw errors.trashNotFound();
      if (await db.get("guides", record.entry.guideId)) throw errors.guideExists();
      const tx = db.transaction([...GUIDE_STORES, "trash"], "readwrite");
      await tx.objectStore("guides").put(record.guide);
      for (const step of record.steps) await tx.objectStore("steps").put(step);
      for (const media of record.media) await tx.objectStore("media").put(media);
      for (const version of record.versions) await tx.objectStore("versions").put(version);
      for (const comment of record.comments) await tx.objectStore("comments").put(comment);
      if (record.burned) await tx.objectStore("burned").put(record.burned);
      await tx.objectStore("trash").delete(trashId);
      await tx.done;
      await bump();
      return summary(record.entry.guideId);
    },

    async deleteTrashed(libraryId, trashId) {
      checkLibrary(libraryId);
      checkId(trashId, "bin entry");
      if (!(await db.get("trash", trashId))) throw errors.trashNotFound();
      await db.delete("trash", trashId);
      await bump();
    },

    async emptyTrash(libraryId) {
      checkLibrary(libraryId);
      const count = await db.count("trash");
      await db.clear("trash");
      await bump();
      return count;
    },

    async duplicateGuide(libraryId, guideId, title) {
      checkLibrary(libraryId);
      const guide = await requireGuide(guideId);
      const cleaned = cleanTitle(title);
      checkFormatVersion(guide, "guide");
      const all = await readAll(guideId);
      const copyId = newId();
      const now = nowIso();
      const copy: Json = { ...guide, id: copyId, title: cleaned, createdAt: now, updatedAt: now };
      delete copy.recordingSessionId;
      const tx = db.transaction(GUIDE_STORES, "readwrite");
      await tx.objectStore("guides").put({ id: copyId, guide: copy });
      for (const step of all.steps) await tx.objectStore("steps").put({ ...step, guideId: copyId });
      for (const media of all.media)
        await tx.objectStore("media").put({ ...media, guideId: copyId });
      await tx.done;
      await bump();
      return summary(copyId);
    },

    // Between libraries: the router does these (folder/router.ts), with both ends to hand.
    createFromParts: () => Promise.reject(errors.notInBrowser()),
    copyGuide: () => Promise.reject(errors.notInBrowser()),
    moveGuide: () => Promise.reject(errors.notInBrowser()),

    async saveVersion(libraryId, guideId, note) {
      checkLibrary(libraryId);
      const trimmed = note.trim();
      if ([...trimmed].length > MAX_NOTE)
        throw errors.invalid(`Enter a note of up to ${MAX_NOTE} characters.`);
      const info = await saveVersionNow(guideId, trimmed);
      await bump();
      return info;
    },

    async listVersions(libraryId, guideId) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      return (await db.getAllFromIndex("versions", "guide", guideId))
        .filter((version) => version.info.id === version.id)
        .map((version) => version.info)
        .sort((a, b) => byString(b.createdAt, a.createdAt) || byString(b.id, a.id));
    },

    async loadVersion(libraryId, guideId, versionId) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const version = await db.get("versions", [guideId, checkId(versionId, "version")]);
      if (!version) throw errors.versionNotFound();
      return { guide: version.guide, steps: sortSteps(version.steps) };
    },

    async restoreVersion(libraryId, guideId, versionId): Promise<RawGuideDocument> {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const version = await db.get("versions", [guideId, checkId(versionId, "version")]);
      if (!version) throw errors.versionNotFound();
      checkFormatVersion(version.guide, "version");
      await saveVersionNow(guideId, `Before restoring ${localStamp(new Date())}`);
      const guide: Json = { ...version.guide, id: guideId, updatedAt: nowIso(), updatedBy: me() };
      const tx = db.transaction(["guides", "steps"], "readwrite");
      const steps = tx.objectStore("steps");
      for (const key of await steps.index("guide").getAllKeys(IDBKeyRange.only(guideId)))
        await steps.delete(key);
      for (const step of version.steps)
        await steps.put({ guideId, id: text(step, "id"), step } satisfies StoredStep);
      await tx.objectStore("guides").put({ id: guideId, guide });
      await tx.done;
      await bump();
      return { guide, steps: await stepsOf(guideId) };
    },

    async applyRedactions(libraryId, guideId) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const steps = await db.getAllFromIndex("steps", "guide", guideId);
      const versions = await db.getAllFromIndex("versions", "guide", guideId);
      const burned = (await db.get("burned", guideId))?.burned ?? {};

      // Every area to burn, per screenshot, from the guide and all its saved versions.
      const wanted = new Map<string, Rect[]>();
      const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
      const gather = (step: Json) => {
        const mediaId = stepMediaId(step);
        if (!mediaId || !Array.isArray(step.redactions)) return;
        for (const raw of step.redactions) {
          const rect = obj(raw);
          const [x, y, w, h] = [rect.x, rect.y, rect.w, rect.h];
          if (![x, y, w, h].every((value) => typeof value === "number")) continue;
          const area = { x, y, w, h } as Rect;
          const done = burned[mediaId] ?? [];
          const list = wanted.get(mediaId) ?? [];
          if (done.some((each) => same(each, area)) || list.some((each) => same(each, area)))
            continue;
          list.push(area);
          wanted.set(mediaId, list);
        }
      };
      steps.forEach((stored) => gather(stored.step));
      versions.forEach((version) => version.steps.forEach(gather));
      if (wanted.size === 0) return 0;

      // Burned copies first; nothing changes if any screenshot is missing.
      const copies = new Map<string, StoredMedia>();
      for (const [mediaId, rects] of wanted) {
        const original = await db.get("media", [guideId, mediaId]);
        if (!original) throw errors.imageNotFound();
        const pixels = await codec.pixels(original.image);
        burnRedactions(pixels.data, pixels.width, pixels.height, rects);
        copies.set(mediaId, {
          guideId,
          id: newId(),
          image: await codec.encode(pixels, WEBP_QUALITY),
          thumbnail: null,
          width: original.width,
          height: original.height,
        });
      }

      const repoint = (step: Json): Json => {
        const mediaId = stepMediaId(step);
        const copy = mediaId ? copies.get(mediaId) : undefined;
        return copy ? { ...step, media: { ...obj(step.media), id: copy.id } } : step;
      };
      // The copies take over their originals' record of what's burned in.
      const record: Record<string, Rect[]> = Object.fromEntries(
        Object.entries(burned).filter(([mediaId]) => !copies.has(mediaId)),
      );
      for (const [mediaId, copy] of copies)
        record[copy.id] = [...(burned[mediaId] ?? []), ...(wanted.get(mediaId) ?? [])];
      const tx = db.transaction(["steps", "versions", "media", "burned"], "readwrite");
      for (const copy of copies.values()) await tx.objectStore("media").put(copy);
      for (const stored of steps)
        await tx.objectStore("steps").put({ ...stored, step: repoint(stored.step) });
      for (const version of versions)
        await tx
          .objectStore("versions")
          .put({ ...version, steps: version.steps.map(repoint) } satisfies StoredVersion);
      for (const mediaId of copies.keys()) await tx.objectStore("media").delete([guideId, mediaId]);
      await tx.objectStore("burned").put({ guideId, burned: record });
      await tx.done;
      await bump();
      return copies.size;
    },

    async exportAmlsteps(libraryId, guideId, destination, includeOriginals) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      const bytes = await exportArchive(
        await browserSource(db, guideId),
        codec,
        includeOriginals,
        options.appVersion,
      );
      await options.files.write(destination, bytes, "application/zip");
    },

    async importAmlsteps(libraryId, source) {
      checkLibrary(libraryId);
      const guideId = await importArchive(db, codec, await options.files.read(source));
      await bump();
      return summary(guideId);
    },

    async storageUse(libraryId): Promise<StorageUse> {
      checkLibrary(libraryId);
      const sizes = await guideSizes();
      const libraryBytes = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
      const estimate = await navigator.storage?.estimate?.().catch(() => null);
      return {
        libraryBytes: libraryBytes + (await trashBytes()),
        usedBytes: estimate?.usage ?? null,
        quotaBytes: estimate?.quota ?? null,
      };
    },

    pickExportFolder: (title) => options.files.pickFolder?.(title) ?? Promise.resolve(null),

    async exportAndRemove(libraryId, guideId, folder) {
      checkLibrary(libraryId);
      const guide = await requireGuide(guideId);
      if (!options.files.saveInFolder) throw errors.notInBrowser();
      // With the original screenshots, so the blur can still be changed once it's imported
      // again: the file is the guide now, not a copy to share.
      const bytes = await exportArchive(
        await browserSource(db, guideId),
        codec,
        true,
        options.appVersion,
      );
      const saved = await options.files.saveInFolder(
        folder,
        `${fileStem(text(guide, "title", UNTITLED))}.amlsteps`,
        bytes,
        "application/zip",
      );
      // The file is checked byte for byte: only now does the guide leave the browser, for good
      // (the Bin would keep its bytes, which is what this is for freeing).
      const all = await readAll(guideId);
      const tx = db.transaction(GUIDE_STORES, "readwrite");
      await tx.objectStore("guides").delete(guideId);
      for (const step of all.steps) await tx.objectStore("steps").delete([guideId, step.id]);
      for (const media of all.media) await tx.objectStore("media").delete([guideId, media.id]);
      for (const version of all.versions)
        await tx.objectStore("versions").delete([guideId, version.id]);
      for (const comment of all.comments)
        await tx.objectStore("comments").delete([guideId, comment.id]);
      await tx.objectStore("burned").delete(guideId);
      await tx.done;
      await db.delete("meta", lockKey(guideId));
      await db.delete("meta", historyKey(guideId));
      await bump();
      return saved;
    },

    async guideMeta(libraryId, guideId) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      return { lock: await stored(lockKey(guideId)), history: await stored(historyKey(guideId)) };
    },

    async writeGuideLock(libraryId, guideId, lock) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      if (lock === null) await db.delete("meta", lockKey(guideId));
      else {
        const value = obj(lock);
        if (typeof value.password !== "string") throw errors.invalid("That isn't a guide lock.");
        await db.put("meta", value, lockKey(guideId));
      }
      await bump();
    },

    async writeGuideHistory(libraryId, guideId, history) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      await db.put("meta", obj(history), historyKey(guideId));
    },

    async guideStats(libraryId, guideId) {
      checkLibrary(libraryId);
      await requireGuide(guideId);
      return {
        pictures: await db.countFromIndex("media", "guide", guideId),
        bytes: (await guideSizes()).get(guideId) ?? 0,
      };
    },

    // One library, so there's no folder to choose.
    pickFolder: () => Promise.resolve(null),
    pickFile: (title, filters) => options.files.pickFile(title, filters),
    pickSaveLocation: (title, name, filters) =>
      options.files.pickSaveLocation(title, name, filters),
  };
  return bridge;
}
