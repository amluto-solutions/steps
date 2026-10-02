import type { RawGuideDocument, VersionInfo } from "@amluto-steps/ui";

import { burnRedactions, type Rect } from "../library/blur";
import { errors, LibraryError, newId, nowIso } from "../library/ids";
import { WEBP_QUALITY } from "../library/images";

import type { Dir } from "./dir";
import {
  BUILDING,
  byName,
  checkFormatVersion,
  checked,
  copyFiles,
  createJson,
  isObject,
  isTemporary,
  obj,
  readJson,
  tryJson,
  writeJson,
  type Json,
  stepCount,
} from "./files";
import { readSteps, type FolderLibrary } from "./library";

/**
 * Saved versions and "Apply blur permanently", as the desktop's `versions.rs` and `redact.rs`.
 * `versions\<id>\` holds `version.json`, a copy of `guide.json` and `steps\`; pictures are shared
 * with the guide, which is safe because editing never changes or deletes one.
 */

const MAX_NOTE = 1000;

const pad = (value: number) => String(value).padStart(2, "0");
/** "29/09/2026 10:32", local time, for the version kept before a restore. */
const localStamp = (date: Date) =>
  `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

function parseInfo(value: unknown): VersionInfo | null {
  if (!isObject(value)) return null;
  const { id, createdAt, note, createdBy, stepCount } = value;
  if (
    typeof id !== "string" ||
    typeof createdAt !== "string" ||
    typeof note !== "string" ||
    typeof createdBy !== "string" ||
    typeof stepCount !== "number" ||
    !Number.isInteger(stepCount) ||
    stepCount < 0
  )
    return null;
  return { id, createdAt, note, createdBy, stepCount };
}

/** Saves the guide as it is now as a new version. */
export async function saveVersion(
  library: FolderLibrary,
  guideId: string,
  note: string,
  author: string,
): Promise<VersionInfo> {
  const trimmed = note.trim();
  if ([...trimmed].length > MAX_NOTE)
    throw errors.invalid(`Enter a note of up to ${MAX_NOTE} characters.`);
  const folder = await library.guideDir(guideId);
  const stepsDir = await folder.folder("steps");
  const info: VersionInfo = {
    id: newId(),
    createdAt: nowIso(),
    note: trimmed,
    createdBy: author,
    stepCount: stepCount(await readSteps(stepsDir)),
  };
  const versions = await folder.makeFolder("versions");
  // Built in place and marked, with version.json last: the desktop lists a version only once
  // version.json is there.
  const target = await versions.makeFolder(info.id);
  try {
    await target.write(BUILDING, info.createdAt);
    const guide = await folder.read("guide.json");
    if (!guide) throw errors.guideNotFound();
    await target.write("guide.json", guide);
    await copyFiles(stepsDir, await target.makeFolder("steps"), [".json"]);
    await createJson(target, "version.json", info);
  } catch (error) {
    await versions.remove(info.id, true).catch(() => undefined);
    throw error;
  }
  await target.remove(BUILDING).catch(() => undefined);
  return info;
}

/** Every readable version, newest first. */
export async function listVersions(
  library: FolderLibrary,
  guideId: string,
): Promise<VersionInfo[]> {
  const versions = await (await library.guideDir(guideId)).folder("versions");
  if (!versions) return [];
  const found: VersionInfo[] = [];
  for (const entry of await versions.entries()) {
    if (entry.kind !== "directory" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
    const info = parseInfo(await tryJson(await versions.folder(entry.name), "version.json"));
    if (info?.id === entry.name) found.push(info);
  }
  return found.sort((a, b) => byName(b.createdAt, a.createdAt) || byName(b.id, a.id));
}

async function versionDir(
  library: FolderLibrary,
  guideId: string,
  versionId: string,
): Promise<Dir> {
  const id = checked(versionId, "version");
  const folder = await (await (await library.guideDir(guideId)).folder("versions"))?.folder(id);
  if (!folder || !(await folder.stat("version.json"))) throw errors.versionNotFound();
  return folder;
}

export async function loadVersion(
  library: FolderLibrary,
  guideId: string,
  versionId: string,
): Promise<RawGuideDocument> {
  const folder = await versionDir(library, guideId, versionId);
  return {
    guide: await readJson(folder, "guide.json"),
    steps: await readSteps(await folder.folder("steps")),
  };
}

/**
 * Makes a saved version the current guide, keeping the current state first as a version called
 * "Before restoring <date>" so a restore can itself be undone. The version's step files are
 * written over the guide's, then the ones it doesn't have are removed (the browser can't swap
 * folders, as the desktop does): if that stops part-way, the version saved first has everything.
 */
export async function restoreVersion(
  library: FolderLibrary,
  guideId: string,
  versionId: string,
  author: string,
): Promise<RawGuideDocument> {
  const source = await versionDir(library, guideId, versionId);
  const guide = obj(await readJson(source, "guide.json"));
  checkFormatVersion(guide, "version");
  await saveVersion(library, guideId, `Before restoring ${localStamp(new Date())}`, author);
  // The guide keeps its identity, and the restore counts as a change.
  guide.id = guideId;
  guide.updatedAt = nowIso();
  guide.updatedBy = author;
  const folder = await library.guideDir(guideId);
  const steps = await folder.makeFolder("steps");
  const incoming = await source.folder("steps");
  const kept = new Set<string>();
  for (const entry of incoming ? await incoming.entries() : []) {
    const name = entry.name;
    if (entry.kind !== "file" || isTemporary(name) || !name.toLowerCase().endsWith(".json"))
      continue;
    const data = await incoming?.read(name);
    if (!data) continue;
    await steps.write(name, data);
    kept.add(name);
  }
  for (const entry of await steps.entries())
    if (!kept.has(entry.name)) await steps.remove(entry.name, true);
  await writeJson(folder, "guide.json", guide);
  return library.loadGuide(guideId);
}

// ---------- Apply blur permanently ----------

/** `blur.json`: originals being replaced by blurred copies, and what's burned into each copy. */
interface BlurRecord {
  pending: Record<string, string>;
  burned: Record<string, Rect[]>;
}

const BLUR_RECORD = "blur.json";

const rectsOf = (value: unknown): Rect[] =>
  (Array.isArray(value) ? value : []).flatMap((raw) => {
    const area = obj(raw);
    const { x, y, w, h } = area;
    return typeof x === "number" &&
      typeof y === "number" &&
      typeof w === "number" &&
      typeof h === "number"
      ? [{ x, y, w, h }]
      : [];
  });

export async function readBlurRecord(folder: Dir): Promise<BlurRecord> {
  const value = obj(await tryJson(folder, BLUR_RECORD));
  const pending: Record<string, string> = {};
  for (const [key, copy] of Object.entries(obj(value.pending)))
    if (typeof copy === "string") pending[key] = copy;
  const burned: Record<string, Rect[]> = {};
  for (const [key, rects] of Object.entries(obj(value.burned))) burned[key] = rectsOf(rects);
  return { pending, burned };
}

async function writeRecord(folder: Dir, record: BlurRecord) {
  if (Object.keys(record.pending).length === 0 && Object.keys(record.burned).length === 0)
    await folder.remove(BLUR_RECORD);
  else await writeJson(folder, BLUR_RECORD, record);
}

/** Every step file of the guide and of all its saved versions. */
async function stepFiles(folder: Dir): Promise<{ dir: Dir; name: string }[]> {
  const dirs: Dir[] = [];
  const steps = await folder.folder("steps");
  if (steps) dirs.push(steps);
  const versions = await folder.folder("versions");
  for (const entry of versions ? await versions.entries() : []) {
    if (entry.kind !== "directory") continue;
    const kept = await (await versions?.folder(entry.name))?.folder("steps");
    if (kept) dirs.push(kept);
  }
  const files: { dir: Dir; name: string }[] = [];
  for (const dir of dirs)
    for (const entry of await dir.entries())
      if (entry.kind === "file" && entry.name.endsWith(".json"))
        files.push({ dir, name: entry.name });
  return files;
}

/** Points every step (guide and versions) that shows an original at its blurred copy. */
async function repoint(folder: Dir, swaps: Record<string, string>) {
  for (const { dir, name } of await stepFiles(folder)) {
    const step = obj(await readJson(dir, name));
    const copy = Object.hasOwn(swaps, String(obj(step.media).id))
      ? swaps[String(obj(step.media).id)]
      : undefined;
    if (!copy) continue;
    await writeJson(dir, name, { ...step, media: { ...obj(step.media), id: copy } });
  }
}

/** Deletes each pending original and its thumbnail; one that can't go yet stays listed. */
async function deleteOriginals(folder: Dir, record: BlurRecord) {
  const media = await folder.folder("media");
  const left: Record<string, string> = {};
  for (const [original, copy] of Object.entries(record.pending)) {
    let deleted = true;
    for (const name of [`${original}.webp`, `${original}.thumb.webp`])
      await media?.remove(name).catch(() => {
        deleted = false;
      });
    if (!deleted) left[original] = copy;
  }
  record.pending = left;
}

const finish = (record: BlurRecord, changed: number) => {
  const left = Object.keys(record.pending).length;
  if (left > 0)
    throw new LibraryError(
      "originalsLeft",
      `The blur is burned in, but ${left} original screenshots couldn't be deleted yet.`,
    );
  return changed;
};

const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * Burns every blur into its screenshot for good: blurred copies are written first, recorded in
 * `blur.json`, every step in the guide and its versions pointed at them, and only then are the
 * originals deleted. A run that stops part-way is finished by the next. Answers how many
 * screenshots changed.
 */
export async function applyRedactions(library: FolderLibrary, guideId: string): Promise<number> {
  const folder = await library.guideDir(guideId);
  const record = await readBlurRecord(folder);

  // 0. Finish an earlier run that stopped part-way.
  if (Object.keys(record.pending).length > 0) {
    await repoint(folder, record.pending);
    await deleteOriginals(folder, record);
    await writeRecord(folder, record);
  }

  const steps: Json[] = [];
  for (const { dir, name } of await stepFiles(folder)) steps.push(obj(await readJson(dir, name)));

  // Every area blurred on each screenshot, less what's already burned into it.
  const areas = new Map<string, Rect[]>();
  for (const step of steps) {
    // Any id, as the desktop: an unsafe one is refused when its picture is read.
    const raw = obj(step.media).id;
    const id = typeof raw === "string" ? raw : null;
    if (id === null) continue;
    const done = record.burned[id] ?? [];
    for (const rect of rectsOf(step.redactions)) {
      const list = areas.get(id) ?? [];
      if (!done.some((each) => same(each, rect)) && !list.some((each) => same(each, rect)))
        list.push(rect);
      areas.set(id, list);
    }
  }
  for (const [id, rects] of areas) if (rects.length === 0) areas.delete(id);
  if (areas.size === 0) return finish(record, 0);

  // 1. The blurred copies. Nothing else changes until they all exist.
  const media = await folder.makeFolder("media");
  const replaced: Record<string, string> = {};
  for (const [original, rects] of [...areas].sort(([a], [b]) => byName(a, b))) {
    const image = await library.loadImage(guideId, original, false);
    const pixels = await library.codec.pixels(image);
    burnRedactions(pixels.data, pixels.width, pixels.height, rects);
    const copy = newId();
    await media.write(`${copy}.webp`, await library.codec.encode(pixels, WEBP_QUALITY));
    // The copy takes over its original's record of what's burned in.
    const { [original]: burned = [], ...others } = record.burned;
    record.burned = { ...others, [copy]: [...burned, ...rects] };
    replaced[original] = copy;
  }

  // 2. The swap is recorded before any step changes; then every step points at its copy.
  record.pending = { ...record.pending, ...replaced };
  await writeRecord(folder, record);
  await repoint(folder, replaced);

  // 3. Only now do the originals and their thumbnails go.
  await deleteOriginals(folder, record);
  await writeRecord(folder, record);
  return finish(record, Object.keys(replaced).length);
}
