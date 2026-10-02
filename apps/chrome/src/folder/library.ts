import type {
  LibraryGuideSummary,
  MediaInfo,
  RawGuideDocument,
  TrashEntry,
} from "@amluto-steps/ui";

import {
  checkFormatVersion,
  cleanTitle,
  errors,
  isSafeId,
  LibraryError,
  newId,
  nowIso,
  sortSteps,
  text,
  UNTITLED,
} from "../library/ids";
import {
  fit,
  prepareImage,
  THUMBNAIL_EDGE,
  THUMBNAIL_QUALITY,
  type ImageCodec,
} from "../library/images";
import {
  matchText,
  queryWords,
  searchText,
  type SearchHit,
  type SearchText,
} from "../library/search";

import { openCommentCount } from "./comments";
import { withNewerFields } from "./newer-fields";
import type { Dir } from "./dir";
import {
  BUILDING,
  byName,
  checked,
  copyFiles,
  copyTree,
  createJson,
  isObject,
  isTemporary,
  obj,
  readJson,
  tryJson,
  writeJson,
  type Json,
  lastEdited,
  stepCount,
} from "./files";

/**
 * One shared library folder in Steps for Chrome and Edge, read and written exactly as the
 * desktop's `library` crate does (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome),
 * so both editions work on the same folder at once. This file is `guides.rs`, `media.rs`,
 * `watch.rs`, `search.rs` and `cache.rs`; comments, locks, conflicts, drafts, versions and blur
 * are beside it.
 *
 * The one difference is that the browser can't rename folders. Where the desktop builds a guide in
 * a staging folder and renames it into place, this builds it in place, marked as being built, and
 * writes the file that makes it a guide last; the desktop ignores a folder without that file.
 */

export const TRASH_DAYS = 30;
/** How old an interrupted write's leftovers must be before they're removed (another PC may still be writing). */
const LEFTOVER_MS = 24 * 60 * 60 * 1000;
/** Past this many guides a cache starts again rather than grow without end. */
const MAX_CACHED = 20_000;

/** The media id a step shows, if it has a usable one. */
export const stepMediaId = (step: Json): string | null => {
  const id = obj(step.media).id;
  return isSafeId(id) ? id : null;
};

/**
 * Every step file in `folder`, sorted by sort key then id. Temporary and unreadable files are
 * skipped, and so is a file whose name isn't its step's id: a sync client's conflict copy.
 */
export async function readSteps(folder: Dir | null): Promise<Json[]> {
  if (!folder) return [];
  const steps: Json[] = [];
  for (const entry of await folder.entries()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    const step = await tryJson(folder, entry.name);
    if (isObject(step) && `${String(step.id)}.json` === entry.name) steps.push(step);
  }
  return sortSteps(steps);
}

/**
 * What a guide's files look like from outside: `guide.json`, and each step and comment file's
 * name, size and time. A write through either app or a sync client changes it; null when
 * `guide.json` isn't there.
 */
async function stampOf(folder: Dir): Promise<string | null> {
  const guide = await folder.stat("guide.json");
  if (!guide) return null;
  const parts = [`${guide.size}:${guide.modified}`];
  for (const sub of ["steps", "comments"]) {
    const dir = await folder.folder(sub);
    parts.push(`/${sub}${dir ? "" : " none"}`);
    if (!dir) continue;
    const files: string[] = [];
    for (const entry of await dir.entries()) {
      const stat = entry.kind === "file" ? await dir.stat(entry.name) : null;
      files.push(`${entry.name}:${stat?.size ?? "-"}:${stat?.modified ?? "-"}`);
    }
    parts.push(...files.sort(byName));
  }
  return parts.join("\n");
}

/** A per-guide copy, used while the guide's files are unchanged (the desktop's `GuideCache`). */
class GuideCache<T> {
  private readonly entries = new Map<string, { stamp: string; value: T }>();

  async get(key: string, folder: Dir, read: () => Promise<T>): Promise<T> {
    // Taken before reading, so a write during the read makes the next call read again.
    const stamp = await stampOf(folder);
    if (stamp === null) return read();
    const found = this.entries.get(key);
    if (found?.stamp === stamp) return found.value;
    const value = await read();
    if (this.entries.size >= MAX_CACHED) this.entries.clear();
    this.entries.set(key, { stamp, value });
    return value;
  }

  forget(key: string) {
    this.entries.delete(key);
  }
}

/** FNV-1a (64-bit), for fingerprints: they only need to change when the folder does. */
function fnv(textToHash: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < textToHash.length; index += 1) {
    hash ^= BigInt(textToHash.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** A bin entry from its `trashed.json`, falling back to `guide.json` and the time in its name. */
async function readTrashEntry(folder: Dir, trashId: string): Promise<TrashEntry | null> {
  const note = obj(await tryJson(folder, "trashed.json"));
  const guide = await tryJson(folder, "guide.json");
  if (!isObject(guide) || !isSafeId(guide.id)) return null;
  let deletedAt = typeof note.deletedAt === "string" ? note.deletedAt : "";
  if (!Number.isFinite(Date.parse(deletedAt))) {
    const millis = Number(trashId.slice(trashId.lastIndexOf("-") + 1));
    const time = new Date(millis);
    deletedAt =
      trashId.includes("-") && Number.isInteger(millis) && Number.isFinite(time.getTime())
        ? time.toISOString()
        : "";
  }
  return {
    trashId,
    guideId: guide.id,
    title:
      typeof note.title === "string"
        ? note.title
        : typeof guide.title === "string"
          ? guide.title
          : UNTITLED,
    deletedAt,
  };
}

/**
 * Copies a guide's folder into `to`, leaving out temporary files, the marker and `leave`, and
 * `guide.json` until last (when `withGuide`): until it's there, no list shows the copy.
 */
async function copyGuideFolder(from: Dir, to: Dir, leave: string[], withGuide: boolean) {
  for (const entry of await from.entries()) {
    const name = entry.name;
    if (isTemporary(name) || name === BUILDING || name === "guide.json" || leave.includes(name))
      continue;
    if (entry.kind === "directory") {
      const child = await from.folder(name);
      if (child) await copyTree(child, await to.makeFolder(name));
    } else {
      const data = await from.read(name);
      if (data) await to.write(name, data);
    }
  }
  if (!withGuide) return;
  const guide = await from.read("guide.json");
  if (!guide) throw errors.guideNotFound();
  await to.write("guide.json", guide);
}

/** A new guide's contents, to publish into a library (a finished recording, or a copy). */
export interface NewMedia {
  id: string;
  image: Blob;
  width: number;
  height: number;
}

export class FolderLibrary {
  private readonly summaries = new GuideCache<LibraryGuideSummary>();
  private readonly texts = new GuideCache<SearchText | null>();
  private swept = false;

  constructor(
    readonly root: Dir,
    readonly codec: ImageCodec,
  ) {}

  /** The `guides` folder; a library without one can't be listed. */
  async guidesDir(): Promise<Dir> {
    const found = await this.root.folder("guides");
    if (!found)
      throw new LibraryError(
        "storageError",
        "Steps could not read or write the library: its guides folder is missing.",
      );
    return found;
  }

  /** An existing guide's folder: one with a `guide.json`. */
  async guideDir(guideId: string): Promise<Dir> {
    const id = checked(guideId, "guide");
    const folder = await (await this.root.folder("guides"))?.folder(id);
    if (!folder || !(await folder.stat("guide.json"))) throw errors.guideNotFound();
    return folder;
  }

  /** The folders directly in `guides` that may be guides. */
  private async guideFolders(): Promise<string[]> {
    return (await (await this.guidesDir()).entries())
      .filter((entry) => entry.kind === "directory" && isSafeId(entry.name))
      .map((entry) => entry.name)
      .sort(byName);
  }

  /** How many guides the library holds; 0 when it can't be read (a folder that's away). */
  async guideCount(): Promise<number> {
    try {
      let count = 0;
      const guides = await this.guidesDir();
      for (const name of await this.guideFolders()) {
        const guide = await tryJson(await guides.folder(name), "guide.json");
        if (isObject(guide) && guide.id === name) count += 1;
      }
      return count;
    } catch {
      return 0;
    }
  }

  // ---------- guides ----------

  /** Every readable guide, newest change first; folders being built or unreadable are skipped. */
  async listGuides(): Promise<LibraryGuideSummary[]> {
    await this.sweepOnce();
    const summaries = await Promise.all(
      (await this.guideFolders()).map((id) => this.summary(id).catch(() => null)),
    );
    return summaries
      .filter((item): item is LibraryGuideSummary => item !== null)
      .sort((a, b) => byName(b.updatedAt, a.updatedAt) || byName(a.id, b.id));
  }

  /** The list entry for one guide. */
  async summary(guideId: string): Promise<LibraryGuideSummary> {
    const folder = await this.guideDir(guideId);
    return this.summaries.get(guideId, folder, async () => {
      const guide = obj(await readJson(folder, "guide.json"));
      if (guide.id !== guideId) throw errors.guideNotFound();
      const steps = await readSteps(await folder.folder("steps"));
      return {
        id: guideId,
        title: text(guide, "title", UNTITLED),
        updatedAt: lastEdited(text(guide, "updatedAt"), steps),
        stepCount: stepCount(steps),
        tags: Array.isArray(guide.tags)
          ? guide.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
        owner: text(guide, "owner"),
        reviewBy: typeof guide.reviewBy === "string" ? guide.reviewBy : null,
        thumbnailMediaId: steps.map(stepMediaId).find((id) => id !== null) ?? null,
        openComments: await openCommentCount(folder),
      };
    });
  }

  async loadGuide(guideId: string): Promise<RawGuideDocument> {
    const folder = await this.guideDir(guideId);
    return {
      guide: await readJson(folder, "guide.json"),
      steps: await readSteps(await folder.folder("steps")),
    };
  }

  /**
   * Builds a new guide folder in place: marked as being built, then its contents, then
   * `guide.json` (created, never replacing one), then the mark comes off. On failure the folder goes.
   */
  private async build(guideId: string, fill: (folder: Dir) => Promise<void>, guide: Json) {
    const guides = await this.root.makeFolder("guides");
    const existing = await guides.folder(guideId);
    if (existing) {
      if (await existing.stat("guide.json")) throw errors.guideExists();
      // What an interrupted build or move to the Bin left: never a guide, so it can go.
      await guides.remove(guideId, true);
    }
    const folder = await guides.makeFolder(guideId);
    try {
      await folder.write(BUILDING, nowIso());
      await fill(folder);
      await createJson(folder, "guide.json", guide);
    } catch (error) {
      await guides.remove(guideId, true).catch(() => undefined);
      throw error;
    }
    // A mark left behind by a failure here is taken off by the next sweep.
    await folder.remove(BUILDING).catch(() => undefined);
  }

  async createGuide(title: string, author: string): Promise<RawGuideDocument> {
    const now = nowIso();
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
    await this.build(
      guide.id as string,
      async (folder) => {
        await folder.makeFolder("steps");
        await folder.makeFolder("media");
      },
      guide,
    );
    return { guide, steps: [] };
  }

  /** Replaces `guide.json`; the UI owns every field, this only checks the id and format. */
  async saveGuide(guideId: string, guide: unknown): Promise<void> {
    const folder = await this.guideDir(guideId);
    const value = obj(guide);
    if (value.id !== guideId)
      throw errors.invalid("The guide's id doesn't match the guide being saved.");
    checkFormatVersion(value, "guide");
    const onDisk = await readJson(folder, "guide.json").catch(() => null);
    await writeJson(folder, "guide.json", withNewerFields("guide", onDisk, value));
  }

  async saveStep(guideId: string, step: unknown): Promise<void> {
    const folder = await this.guideDir(guideId);
    const value = obj(step);
    const stepId = checked(value.id ?? "", "step");
    checkFormatVersion(value, "step");
    const steps = await folder.makeFolder("steps");
    const onDisk = await readJson(steps, `${stepId}.json`).catch(() => null);
    await writeJson(steps, `${stepId}.json`, withNewerFields("step", onDisk, value));
  }

  /** Removes a step file; its screenshot stays, as saved versions may use it. */
  async deleteStep(guideId: string, stepId: string): Promise<void> {
    const folder = await this.guideDir(guideId);
    const steps = await folder.folder("steps");
    await steps?.remove(`${checked(stepId, "step")}.json`);
  }

  // ---------- the Bin ----------

  /**
   * Moves a guide to `.trash\<guideId>-<time>` with a `trashed.json` note: copied whole first,
   * and only then taken out of the library, `guide.json` first so it leaves every list at once.
   */
  async trashGuide(guideId: string): Promise<TrashEntry> {
    const folder = await this.guideDir(guideId);
    const title = text(obj(await tryJson(folder, "guide.json")), "title", UNTITLED);
    const trash = await this.root.makeFolder(".trash");
    let trashId = `${guideId}-${Date.now()}`;
    // Ids are capped at 128 characters: a long guide id gets a fresh bin id.
    if (!isSafeId(trashId) || (await trash.folder(trashId))) trashId = newId();
    const entry: TrashEntry = { trashId, guideId, title, deletedAt: nowIso() };
    const destination = await trash.makeFolder(trashId);
    try {
      await destination.write(BUILDING, entry.deletedAt);
      await writeJson(destination, "trashed.json", { ...entry, formatVersion: 1 });
      await copyGuideFolder(folder, destination, [], true);
      await folder.remove("guide.json");
    } catch (error) {
      await trash.remove(trashId, true).catch(() => undefined);
      throw error;
    }
    await destination.remove(BUILDING).catch(() => undefined);
    // Without its guide.json the rest is hidden; restoring clears anything left behind.
    await (await this.guidesDir()).remove(guideId, true).catch(() => undefined);
    this.summaries.forget(guideId);
    this.texts.forget(guideId);
    return entry;
  }

  /** The Bin, newest first; entries deleted more than 30 days ago are removed for good. */
  async listTrash(): Promise<TrashEntry[]> {
    const trash = await this.root.folder(".trash");
    if (!trash) return [];
    const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
    const result: TrashEntry[] = [];
    for (const item of await trash.entries()) {
      if (item.kind !== "directory" || !isSafeId(item.name)) continue;
      const folder = await trash.folder(item.name);
      const entry = folder && (await readTrashEntry(folder, item.name));
      if (!entry) continue;
      const deleted = Date.parse(entry.deletedAt);
      if (Number.isFinite(deleted) && deleted < cutoff) {
        // Best effort: a file a sync client holds open is tried again next time.
        await trash.remove(item.name, true).catch(() => undefined);
        continue;
      }
      result.push(entry);
    }
    return result.sort((a, b) => byName(b.deletedAt, a.deletedAt));
  }

  /** Puts a guide from the Bin back under its old id. */
  async restoreGuide(trashId: string): Promise<LibraryGuideSummary> {
    const id = checked(trashId, "bin entry");
    const trash = await this.root.folder(".trash");
    const folder = await trash?.folder(id);
    const entry = folder && (await readTrashEntry(folder, id));
    if (!trash || !folder || !entry) throw errors.trashNotFound();
    const guide = obj(await readJson(folder, "guide.json"));
    await this.build(
      entry.guideId,
      (target) => copyGuideFolder(folder, target, ["trashed.json"], false),
      guide,
    );
    await trash.remove(id, true).catch(() => undefined);
    return this.summary(entry.guideId);
  }

  /** Deletes a guide in the Bin for good. */
  async deleteTrashed(trashId: string): Promise<void> {
    const id = checked(trashId, "bin entry");
    const trash = await this.root.folder(".trash");
    const folder = await trash?.folder(id);
    if (!trash || !folder || !(await readTrashEntry(folder, id))) throw errors.trashNotFound();
    await trash.remove(id, true);
  }

  /**
   * Empties the Bin for good. Every entry is tried, so one file a sync client holds open doesn't
   * keep the rest; the first failure is then reported. Answers how many were deleted.
   */
  async emptyTrash(): Promise<number> {
    let deleted = 0;
    let failure: unknown = null;
    for (const entry of await this.listTrash()) {
      try {
        await this.deleteTrashed(entry.trashId);
        deleted += 1;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return deleted;
  }

  // ---------- copies ----------

  /** `preferred` if it's free here, else a new id. */
  async chooseId(preferred: string): Promise<string> {
    const guides = await this.root.folder("guides");
    return isSafeId(preferred) && !(await guides?.folder(preferred)) ? preferred : newId();
  }

  /**
   * Copies a guide into `target` as `newGuideId`, with `guide.json` rewritten by `edit`: its steps
   * and pictures, and with `history` its saved versions and comments too.
   */
  async copyGuideInto(
    target: FolderLibrary,
    guideId: string,
    newGuideId: string,
    history: boolean,
    edit: (guide: Json) => void,
  ): Promise<void> {
    const source = await this.guideDir(guideId);
    const guide = obj(await readJson(source, "guide.json"));
    checkFormatVersion(guide, "guide");
    edit(guide);
    guide.id = newGuideId;
    await target.build(
      newGuideId,
      async (folder) => {
        await copyFiles(await source.folder("steps"), await folder.makeFolder("steps"), [".json"]);
        await copyFiles(await source.folder("media"), await folder.makeFolder("media"), [".webp"]);
        if (history)
          for (const sub of ["versions", "comments"]) {
            const from = await source.folder(sub);
            if (from) await copyTree(from, await folder.makeFolder(sub));
          }
      },
      guide,
    );
  }

  /** A copy under a new id here, with a new title and fresh dates; no history, no session link. */
  async duplicateGuide(guideId: string, title: string): Promise<LibraryGuideSummary> {
    const cleaned = cleanTitle(title);
    const copyId = newId();
    const now = nowIso();
    await this.copyGuideInto(this, guideId, copyId, false, (guide) => {
      guide.title = cleaned;
      guide.createdAt = now;
      guide.updatedAt = now;
      delete guide.recordingSessionId;
    });
    return this.summary(copyId);
  }

  /**
   * Copies a guide into another folder library, keeping its id where free. A copy is what
   * Duplicate makes (01/10/2026): fresh dates, and no versions, comments or session link.
   */
  async copyGuideTo(guideId: string, target: FolderLibrary): Promise<LibraryGuideSummary> {
    const id = await target.chooseId(guideId);
    const now = nowIso();
    await this.copyGuideInto(target, guideId, id, false, (guide) => {
      guide.createdAt = now;
      guide.updatedAt = now;
      delete guide.recordingSessionId;
    });
    return target.summary(id);
  }

  /** Moves a guide into another folder library: a full copy, then the original to this Bin. */
  async moveGuideTo(guideId: string, target: FolderLibrary): Promise<LibraryGuideSummary> {
    await this.guideDir(guideId);
    if (await this.root.same(target.root)) return this.summary(guideId);
    const id = await target.chooseId(guideId);
    await this.copyGuideInto(target, guideId, id, true, () => undefined);
    const summary = await target.summary(id);
    await this.trashGuide(guideId).catch((error: unknown) => {
      throw new LibraryError(
        "moveIncomplete",
        `The guide was copied, but the original could not be moved to the bin: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return summary;
  }

  /** A guide from elsewhere (the browser's own library, or a recording), written whole. */
  async publish(
    guideId: string,
    guide: Json,
    steps: Json[],
    media: { id: string; image: Blob }[],
    extra?: (folder: Dir) => Promise<void>,
  ): Promise<void> {
    checked(guideId, "guide");
    await this.build(
      guideId,
      async (folder) => {
        const stepsDir = await folder.makeFolder("steps");
        for (const step of steps)
          await writeJson(stepsDir, `${checked(step.id, "step")}.json`, step);
        const mediaDir = await folder.makeFolder("media");
        for (const item of media)
          await mediaDir.write(`${checked(item.id, "image")}.webp`, item.image);
        await extra?.(folder);
      },
      { ...guide, id: guideId },
    );
  }

  /** The recording session a guide came from: "" when it has none, null when there's no guide. */
  async recordingOf(guideId: string): Promise<string | null> {
    try {
      return text(
        obj(await readJson(await this.guideDir(guideId), "guide.json")),
        "recordingSessionId",
      );
    } catch (error) {
      if (error instanceof LibraryError && error.code === "guideNotFound") return null;
      throw error;
    }
  }

  // ---------- pictures ----------

  /** Stores a pasted, dropped or chosen picture as a new WebP in the guide. */
  async importImage(guideId: string, bytes: Uint8Array): Promise<MediaInfo> {
    const folder = await this.guideDir(guideId);
    const prepared = await prepareImage(this.codec, bytes);
    const id = newId();
    await (await folder.makeFolder("media")).create(`${id}.webp`, prepared.blob);
    return { id, width: prepared.width, height: prepared.height };
  }

  /**
   * A picture's WebP. A thumbnail (`<id>.thumb.webp`, within 480 pixels) is made and kept the
   * first time it's asked for, and read first after that, so a list doesn't download every
   * full screenshot kept online only.
   */
  async loadImage(guideId: string, mediaId: string, thumbnail: boolean): Promise<Blob> {
    const id = checked(mediaId, "image");
    const media = await (await this.guideDir(guideId)).folder("media");
    if (thumbnail) {
      const cached = await media?.read(`${id}.thumb.webp`);
      if (cached) return cached;
    }
    const original = await media?.read(`${id}.webp`);
    if (!media || !original) throw errors.imageNotFound();
    if (!thumbnail) return original;
    const size = await this.codec.measure(original);
    const small = fit(size.width, size.height, THUMBNAIL_EDGE);
    const made = await this.codec.render(original, small.width, small.height, THUMBNAIL_QUALITY);
    // Kept for next time; on a folder that can't be written, the fresh one is still shown.
    await media.create(`${id}.thumb.webp`, made).catch(() => undefined);
    return made;
  }

  // ---------- live refresh ----------

  /** Every entry directly in `dir`: name, size and time, in name order (no file is opened). */
  private static async addFolder(parts: string[], dir: Dir | null) {
    if (!dir) {
      parts.push("-");
      return;
    }
    const entries = (await dir.entries()).sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      const stat = entry.kind === "file" ? await dir.stat(entry.name) : null;
      parts.push(`${entry.name}:${entry.kind}:${stat?.size ?? ""}:${stat?.modified ?? ""}`);
    }
  }

  /** What of a guide the window shows changing: its own files, steps, comments, drafts and delete notes. */
  private static async addGuide(parts: string[], folder: Dir) {
    await FolderLibrary.addFolder(parts, folder);
    for (const sub of ["steps", "comments", "drafts", "deleted"])
      await FolderLibrary.addFolder(parts, await folder.folder(sub));
  }

  /** Different whenever a guide is added, removed or changed. */
  async fingerprint(): Promise<string> {
    const guides = await this.guidesDir();
    const parts: string[] = [];
    for (const entry of (await guides.entries()).sort((a, b) => byName(a.name, b.name))) {
      if (entry.kind !== "directory") continue;
      parts.push(`#${entry.name}`);
      const folder = await guides.folder(entry.name);
      if (folder) await FolderLibrary.addGuide(parts, folder);
    }
    return fnv(parts.join("\n"));
  }

  async guideFingerprint(guideId: string): Promise<string> {
    const parts: string[] = [];
    await FolderLibrary.addGuide(parts, await this.guideDir(guideId));
    return fnv(parts.join("\n"));
  }

  // ---------- search ----------

  /** The guides containing every word of `query`, stopping early once `keepGoing` says no. */
  async search(query: string, keepGoing: () => boolean = () => true): Promise<SearchHit[]> {
    const words = queryWords(query);
    if (words.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const guideId of await this.guideFolders()) {
      if (!keepGoing()) break;
      const folder = await this.guideDir(guideId).catch(() => null);
      if (!folder) continue;
      const found = await this.texts
        .get(guideId, folder, async () => {
          const guide = await tryJson(folder, "guide.json");
          if (!isObject(guide) || guide.id !== guideId) return null;
          return searchText(guide, await readSteps(await folder.folder("steps")));
        })
        .catch(() => null);
      const hit = found && matchText(guideId, found, words);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  // ---------- leftovers ----------

  private async sweepOnce() {
    if (this.swept) return;
    this.swept = true;
    await this.sweep(LEFTOVER_MS).catch(() => undefined);
  }

  /**
   * Removes what interrupted writes in this browser left (a crash, a full disk), once per library
   * while the page is open: folders still marked as being built, and temporary files, only when
   * older than a day, as another PC may still be writing them. The desktop's own staging folders
   * are the desktop's to sweep.
   */
  async sweep(olderThan: number, now = Date.now()): Promise<void> {
    const old = (stat: { modified: number } | null) =>
      stat !== null && now - stat.modified >= olderThan;

    const sweepFiles = async (dir: Dir | null) => {
      if (!dir) return;
      for (const entry of await dir.entries())
        if (entry.kind === "file" && isTemporary(entry.name) && old(await dir.stat(entry.name)))
          await dir.remove(entry.name).catch(() => undefined);
    };

    /** A folder marked as being built: finished if `whole` is there, else gone once old. */
    const sweepBuilt = async (parent: Dir, name: string, whole: string) => {
      const folder = await parent.folder(name);
      const mark = folder && (await folder.stat(BUILDING));
      if (!folder || !mark) return;
      if (await folder.stat(whole)) await folder.remove(BUILDING).catch(() => undefined);
      else if (old(mark)) await parent.remove(name, true).catch(() => undefined);
    };

    const guides = await this.root.folder("guides");
    if (guides) {
      await sweepFiles(guides);
      for (const entry of await guides.entries()) {
        if (entry.kind !== "directory" || !isSafeId(entry.name)) continue;
        await sweepBuilt(guides, entry.name, "guide.json");
        const folder = await guides.folder(entry.name);
        if (!folder) continue;
        await sweepFiles(folder);
        for (const sub of ["steps", "media", "comments", "drafts", "deleted"])
          await sweepFiles(await folder.folder(sub));
        const versions = await folder.folder("versions");
        if (!versions) continue;
        for (const version of await versions.entries())
          if (version.kind === "directory" && isSafeId(version.name)) {
            await sweepBuilt(versions, version.name, "version.json");
            const kept = await versions.folder(version.name);
            await sweepFiles(kept);
            await sweepFiles((await kept?.folder("steps")) ?? null);
          }
      }
    }
    const trash = await this.root.folder(".trash");
    if (trash)
      for (const entry of await trash.entries())
        if (entry.kind === "directory" && isSafeId(entry.name))
          await sweepBuilt(trash, entry.name, "guide.json");
  }
}
