import type { VersionInfo } from "@amluto-steps/ui";

import type { Rect } from "../library/blur";
import type { LibraryDb, StoredComment } from "../library/db";
import { errors, isSafeId, newId, sortSteps, text } from "../library/ids";
import type { ImageCodec } from "../library/images";

import { commentFile, parseCommentFile } from "./comments";
import { checked, jsonFiles, jsonText, obj, readJson, writeJson, type Json } from "./files";
import { listVersions, loadVersion, readBlurRecord } from "./history";
import { readSteps, type FolderLibrary } from "./library";

/**
 * A whole guide with its history, for copying or moving it between the browser's own library and
 * a shared folder: what the desktop's copy between libraries takes (steps, pictures, saved
 * versions and comments), and the record of blur already burned in.
 */
export interface GuideBundle {
  guide: Json;
  steps: Json[];
  media: { id: string; image: Blob; thumbnail: Blob | null }[];
  versions: { info: VersionInfo; guide: Json; steps: Json[] }[];
  comments: {
    id: string;
    action: StoredComment["action"];
    thread: string | null;
    stepId: string | null;
    text: string;
    by: string;
    /** Where it was written; comments from the browser's library have none. */
    pc: string;
    at: string;
  }[];
  burned: Record<string, Rect[]>;
}

/**
 * Makes a bundle a copy rather than a move (01/10/2026): what Duplicate makes, with fresh
 * dates. Versions, comments and the recording it came from stay with the original.
 */
export function asCopy(bundle: GuideBundle, now = new Date().toISOString()): GuideBundle {
  delete bundle.guide.recordingSessionId;
  bundle.guide.createdAt = now;
  bundle.guide.updatedAt = now;
  bundle.versions = [];
  bundle.comments = [];
  return bundle;
}

// ---------- the browser's library ----------

export async function browserBundle(db: LibraryDb, guideId: string): Promise<GuideBundle> {
  const stored = await db.get("guides", guideId);
  if (!stored) throw errors.guideNotFound();
  const [steps, media, versions, comments, burned] = await Promise.all([
    db.getAllFromIndex("steps", "guide", guideId),
    db.getAllFromIndex("media", "guide", guideId),
    db.getAllFromIndex("versions", "guide", guideId),
    db.getAllFromIndex("comments", "guide", guideId),
    db.get("burned", guideId),
  ]);
  return {
    guide: { ...stored.guide },
    steps: sortSteps(steps.map((row) => row.step)),
    media: media.map((row) => ({ id: row.id, image: row.image, thumbnail: row.thumbnail })),
    versions: versions
      .filter((row) => row.info.id === row.id)
      .map((row) => ({ info: row.info, guide: row.guide, steps: row.steps })),
    comments: comments.map((row) => ({
      id: row.id,
      action: row.action,
      thread: row.thread,
      stepId: row.stepId,
      text: row.text,
      by: row.by,
      pc: "",
      at: row.at,
    })),
    burned: burned?.burned ?? {},
  };
}

/** Writes a bundle into the browser's library as `preferredId` when that's free; answers its id. */
export async function putBrowserBundle(
  db: LibraryDb,
  codec: ImageCodec,
  bundle: GuideBundle,
  preferredId: string,
): Promise<string> {
  const guideId =
    isSafeId(preferredId) && !(await db.get("guides", preferredId)) ? preferredId : newId();
  // Sizes first, outside the transaction, which would close while a picture is measured.
  const media = await Promise.all(
    bundle.media.map(async (item) => ({ ...item, size: await codec.measure(item.image) })),
  );
  const tx = db.transaction(
    ["guides", "steps", "media", "versions", "comments", "burned"],
    "readwrite",
  );
  await tx.objectStore("guides").put({ id: guideId, guide: { ...bundle.guide, id: guideId } });
  for (const step of bundle.steps)
    await tx.objectStore("steps").put({ guideId, id: text(step, "id"), step });
  for (const item of media)
    await tx.objectStore("media").put({
      guideId,
      id: item.id,
      image: item.image,
      thumbnail: item.thumbnail,
      width: item.size.width,
      height: item.size.height,
    });
  for (const version of bundle.versions)
    await tx.objectStore("versions").put({
      guideId,
      id: version.info.id,
      info: version.info,
      guide: version.guide,
      steps: version.steps,
    });
  for (const comment of bundle.comments)
    await tx.objectStore("comments").put({
      guideId,
      id: comment.id,
      action: comment.action,
      thread: comment.thread,
      stepId: comment.stepId,
      text: comment.text,
      by: comment.by,
      at: comment.at,
    });
  if (Object.keys(bundle.burned).length > 0)
    await tx.objectStore("burned").put({ guideId, burned: bundle.burned });
  await tx.done;
  return guideId;
}

// ---------- a shared folder ----------

export async function folderBundle(library: FolderLibrary, guideId: string): Promise<GuideBundle> {
  const folder = await library.guideDir(guideId);
  const guide = obj(await readJson(folder, "guide.json"));
  const steps = await readSteps(await folder.folder("steps"));

  const media: GuideBundle["media"] = [];
  const mediaDir = await folder.folder("media");
  for (const entry of mediaDir ? await mediaDir.entries() : []) {
    const id = entry.name.replace(/\.webp$/i, "");
    if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".webp") || !isSafeId(id))
      continue;
    const image = await mediaDir?.read(entry.name);
    if (image)
      media.push({ id, image, thumbnail: (await mediaDir?.read(`${id}.thumb.webp`)) ?? null });
  }

  const versions: GuideBundle["versions"] = [];
  for (const info of await listVersions(library, guideId)) {
    const version = await loadVersion(library, guideId, info.id);
    versions.push({ info, guide: obj(version.guide), steps: version.steps.map(obj) });
  }

  const comments: GuideBundle["comments"] = [];
  for (const [name, value] of await jsonFiles(await folder.folder("comments"))) {
    const entry = parseCommentFile(value);
    if (entry && `${entry.id}.json` === name) comments.push(entry);
  }

  return { guide, steps, media, versions, comments, burned: (await readBlurRecord(folder)).burned };
}

/** Writes a bundle into a folder library as `guideId`, whole or not at all. */
export async function putFolderBundle(
  library: FolderLibrary,
  bundle: GuideBundle,
  guideId: string,
  pc: string,
): Promise<void> {
  await library.publish(guideId, bundle.guide, bundle.steps, bundle.media, async (folder) => {
    const media = await folder.makeFolder("media");
    for (const item of bundle.media)
      if (item.thumbnail) await media.write(`${item.id}.thumb.webp`, item.thumbnail);
    if (bundle.versions.length > 0) {
      const versions = await folder.makeFolder("versions");
      for (const version of bundle.versions) {
        const target = await versions.makeFolder(checked(version.info.id, "version"));
        await target.write("guide.json", jsonText(version.guide));
        const steps = await target.makeFolder("steps");
        for (const step of version.steps)
          await writeJson(steps, `${checked(step.id, "step")}.json`, step);
        await writeJson(target, "version.json", version.info);
      }
    }
    if (bundle.comments.length > 0) {
      const comments = await folder.makeFolder("comments");
      // A comment from the browser's library is kept as written in this browser.
      for (const comment of bundle.comments)
        await writeJson(
          comments,
          `${checked(comment.id, "comment")}.json`,
          commentFile(comment, comment.pc || pc),
        );
    }
    if (Object.keys(bundle.burned).length > 0)
      await writeJson(folder, "blur.json", { pending: {}, burned: bundle.burned });
  });
}
