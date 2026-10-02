import {
  guideSchema,
  guideStepSchema,
  parseGuide,
  parseStep,
  withoutTypedValue,
} from "@amluto-steps/core";
import { unzipSync, zipSync, type Unzipped, type Zippable } from "fflate";

import { burnRedactions, type Rect } from "./blur";
import type { Json, LibraryDb, StoredMedia } from "./db";
import {
  checkFormatVersion,
  errors,
  isSafeId,
  LibraryError,
  newId,
  nowIso,
  sortSteps,
} from "./ids";
import {
  fit,
  isLosslessWebp,
  MAX_EDGE,
  MAX_PIXELS,
  sniff,
  WEBP_QUALITY,
  type ImageCodec,
} from "./images";

/**
 * `.amlsteps` files (docs/spec/03-data-and-sharing.md#guide-files), made and read as the desktop's
 * `library/src/archive.rs` does, so a guide moves between the editions. Import applies the same
 * rules against hostile files: sizes, names, zip bombs, and nothing kept unless everything passes.
 */

const MANIFEST = "amlsteps.json";
const GUIDE_FILE = "guide/guide.json";
const STEPS_PREFIX = "guide/steps/";
const MEDIA_PREFIX = "guide/media/";

const MB = 1024 * 1024;
export const IMPORT_LIMITS = {
  maxEntries: 5000,
  maxTotalBytes: 2048 * MB,
  maxEntryBytes: 100 * MB,
  maxJsonBytes: 4 * MB,
  maxRatio: 100,
  maxPixels: MAX_PIXELS,
};
export type ImportLimits = typeof IMPORT_LIMITS;

const rejected = (rule: string) =>
  new LibraryError("importRejected", `This file can't be imported: ${rule}`);

const json = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const obj = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

// ---------- export ----------

/** A guide to export, from whichever library holds it. */
export interface ArchiveSource {
  guide: unknown;
  steps: unknown[];
  /** A screenshot's WebP, or null when it's missing. */
  image(mediaId: string): Promise<Blob | null>;
}

/** A guide in the browser's own library, as an export reads it. */
export async function browserSource(db: LibraryDb, guideId: string): Promise<ArchiveSource> {
  const stored = await db.get("guides", guideId);
  if (!stored) throw errors.guideNotFound();
  return {
    guide: stored.guide,
    steps: (await db.getAllFromIndex("steps", "guide", guideId)).map((row) => row.step),
    image: async (mediaId) => (await db.get("media", [guideId, mediaId]))?.image ?? null,
  };
}

/** The guide as an `.amlsteps` file. Blur is burned in unless `includeOriginals`. */
export async function exportArchive(
  source: ArchiveSource,
  codec: ImageCodec,
  includeOriginals: boolean,
  appVersion: string,
): Promise<Uint8Array> {
  const problem = (error: unknown) =>
    errors.invalid(`This guide can't be exported because ${String(error)}.`);
  let guide: Json;
  try {
    guide = parseGuide(source.guide) as Json;
  } catch (error) {
    throw problem(error);
  }
  delete guide.recordingSessionId;

  const files: Zippable = {
    [MANIFEST]: [
      json({ formatVersion: 1, kind: "guide", exportedAt: nowIso(), appVersion }),
      { level: 6 },
    ],
    [GUIDE_FILE]: [json(guide), { level: 6 }],
  };
  const originals = new Map<string, Blob>();
  const burned: [string, Uint8Array][] = [];
  const raw = sortSteps(source.steps);
  for (const rawStep of raw) {
    let step: Json;
    try {
      step = parseStep(rawStep) as unknown as Json;
    } catch (error) {
      throw problem(error);
    }
    delete step.recordingSessionId;
    // A hidden typed value leaves the guide with the file: gone from the wording and alt text.
    const parts = obj(step.textParts);
    if (step.showValue !== true && typeof parts.value === "string") {
      step.actionText = withoutTypedValue(String(step.actionText), parts.value);
      if (typeof step.altText === "string")
        step.altText = withoutTypedValue(step.altText, parts.value);
      step.textParts = Object.fromEntries(Object.entries(parts).filter(([key]) => key !== "value"));
    }
    const media = obj(step.media);
    if (isSafeId(media.id)) {
      const original = await source.image(media.id);
      if (!original) throw errors.invalid("A screenshot this guide uses is missing.");
      const rects = (Array.isArray(step.redactions) ? step.redactions : []) as Rect[];
      if (!includeOriginals && rects.length > 0) {
        // Each step gets its own burned copy, so no unblurred picture leaves the PC.
        const pixels = await codec.pixels(original);
        burnRedactions(pixels.data, pixels.width, pixels.height, rects);
        const copyId = newId();
        burned.push([
          copyId,
          new Uint8Array(await (await codec.encode(pixels, WEBP_QUALITY)).arrayBuffer()),
        ]);
        step.media = { ...media, id: copyId, width: pixels.width, height: pixels.height };
        step.redactions = [];
      } else {
        originals.set(media.id, original);
      }
    }
    files[`${STEPS_PREFIX}${String(step.id)}.json`] = [json(step), { level: 6 }];
  }
  for (const id of [...originals.keys()].sort()) {
    const image = originals.get(id) as Blob;
    files[`${MEDIA_PREFIX}${id}.webp`] = [new Uint8Array(await image.arrayBuffer()), { level: 0 }];
  }
  for (const [id, bytes] of burned.sort(([a], [b]) => (a < b ? -1 : 1)))
    files[`${MEDIA_PREFIX}${id}.webp`] = [bytes, { level: 0 }];
  return zipSync(files);
}

// ---------- import ----------

const DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

/** The path rules; returns the rule an entry name breaks, or null. */
export function entryNameProblem(name: string): string | null {
  // eslint-disable-next-line no-control-regex -- control characters are what's being refused
  if (name === "" || /[\u0000-\u001f\u007f-\u009f]/.test(name))
    return "an entry has an empty or unprintable name";
  if (name.startsWith("/") || name.startsWith("\\"))
    return `${name} is an absolute or network (UNC) path`;
  if (name.includes(":")) return `${name} names a drive letter or a stream`;
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  for (const part of trimmed.split(/[/\\]/)) {
    if (part === "..") return `${name} climbs out of its folder (..)`;
    if (part === "" || part === ".") return `${name} has an empty path segment`;
    if (part.endsWith(".") || part.endsWith(" "))
      return `${name} ends a segment with a dot or space`;
    const stem = (part.split(".")[0] ?? part).trimEnd().toUpperCase();
    if (DEVICE_NAMES.has(stem)) return `${name} uses the Windows device name ${stem}`;
  }
  return null;
}

const describeBytes = (bytes: number) =>
  bytes >= 1024 * MB
    ? `${bytes / (1024 * MB)} GB`
    : bytes >= MB
      ? `${bytes / MB} MB`
      : `${bytes} bytes`;

/** Reads the zip, applying every size and name rule before and after inflating. */
function readEntries(bytes: Uint8Array, limits: ImportLimits): Unzipped {
  if (bytes.length > limits.maxTotalBytes + 64 * MB) throw rejected("the file is larger than 2 GB");
  const seen = new Set<string>();
  const declared = new Map<string, { size: number; compressed: number }>();
  let entries = 0;
  let total = 0;
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(bytes, {
      filter(file) {
        entries += 1;
        if (entries > limits.maxEntries)
          throw rejected(`it has more than ${limits.maxEntries} entries`);
        const problem = entryNameProblem(file.name);
        if (problem) throw rejected(problem);
        if (seen.has(file.name.toLowerCase()))
          throw rejected(`two entries are named ${file.name} (names may differ only by case)`);
        seen.add(file.name.toLowerCase());
        if (file.originalSize > limits.maxEntryBytes)
          throw rejected(`${file.name} is larger than ${describeBytes(limits.maxEntryBytes)}`);
        if (file.originalSize > 0 && file.originalSize > file.size * limits.maxRatio)
          throw rejected(
            `${file.name} is compressed more than ${limits.maxRatio}:1, which is how zip bombs work`,
          );
        if (file.name.toLowerCase().endsWith(".json") && file.originalSize > limits.maxJsonBytes)
          throw rejected(`${file.name} is larger than ${describeBytes(limits.maxJsonBytes)}`);
        total += file.originalSize;
        if (total > limits.maxTotalBytes)
          throw rejected(`it expands to more than ${describeBytes(limits.maxTotalBytes)}`);
        declared.set(file.name, { size: file.originalSize, compressed: file.size });
        // Only the files a guide is made of are ever inflated.
        return file.name === MANIFEST || file.name === GUIDE_FILE || file.name.startsWith("guide/");
      },
    });
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    throw rejected(`it isn't a valid .amlsteps file (${String(error)})`);
  }
  // A zip's headers can claim anything: the bytes actually produced must agree.
  for (const [name, data] of Object.entries(unzipped)) {
    const header = declared.get(name);
    if (!header || data.length > header.size)
      throw rejected(`${name} is larger than its header says`);
  }
  return unzipped;
}

function parseJson(name: string, data: Uint8Array | undefined): Json | undefined {
  if (!data) return undefined;
  try {
    return obj(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
  } catch (error) {
    throw rejected(`a JSON file is damaged (${name}: ${String(error)})`);
  }
}

const versionChecked = (value: Json, what: string) => {
  try {
    checkFormatVersion(value, what);
  } catch (error) {
    if (error instanceof LibraryError && error.code === "newerFormat") throw error;
    throw rejected(`the ${what} has no valid formatVersion`);
  }
};

/** A guide read from an `.amlsteps` file and checked, ready to put into a library. */
export interface ImportedGuide {
  /** Its id is the file's; the library gives it a new one if that's taken or unsafe. */
  guide: Json;
  steps: Json[];
  media: { id: string; image: Blob; width: number; height: number }[];
}

/** Reads and checks a guide file, applying every rule; nothing is written. */
export async function readArchive(
  codec: ImageCodec,
  bytes: Uint8Array,
  limits: ImportLimits = IMPORT_LIMITS,
): Promise<ImportedGuide> {
  const entries = readEntries(bytes, limits);

  const manifest = parseJson(MANIFEST, entries[MANIFEST]);
  if (!manifest) throw rejected("it has no amlsteps.json manifest");
  versionChecked(manifest, "file");
  if (!["kind", "exportedAt", "appVersion"].every((key) => typeof manifest[key] === "string"))
    throw rejected("its manifest is incomplete");
  if (manifest.kind !== "guide") throw rejected("it isn't a guide");

  const rawGuide = parseJson(GUIDE_FILE, entries[GUIDE_FILE]);
  if (!rawGuide) throw rejected("it has no guide");
  versionChecked(rawGuide, "guide");
  const checked = guideSchema.safeParse(rawGuide);
  if (!checked.success)
    throw rejected(`the guide isn't valid (${checked.error.issues[0]?.message ?? ""})`);
  const guide = checked.data as Json;
  delete guide.recordingSessionId;

  const steps: Json[] = [];
  const mediaFiles = new Map<string, { name: string; data: Uint8Array }>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith(STEPS_PREFIX)) {
      const id = name.slice(STEPS_PREFIX.length).replace(/\.json$/, "");
      if (!name.endsWith(".json") || !isSafeId(id)) continue;
      const raw = parseJson(name, data) ?? {};
      versionChecked(raw, "step");
      const step = guideStepSchema.safeParse(raw);
      if (!step.success)
        throw rejected(`a step isn't valid (${step.error.issues[0]?.message ?? ""})`);
      if (step.data.id !== id) throw rejected(`the step in ${name} has a different id`);
      steps.push(step.data as unknown as Json);
    } else if (name.startsWith(MEDIA_PREFIX)) {
      const match = /^([^./\\]+)\.(webp|png|jpe?g)$/i.exec(name.slice(MEDIA_PREFIX.length));
      if (!match || !isSafeId(match[1])) continue;
      if (mediaFiles.has(match[1])) throw rejected(`two images share the id ${match[1]}`);
      mediaFiles.set(match[1], { name, data });
    }
  }

  // Every picture a step uses must be in the file; any other is left behind.
  const media: ImportedGuide["media"] = [];
  for (const id of new Set(steps.map((step) => obj(step.media).id).filter(isSafeId))) {
    const file = mediaFiles.get(id);
    if (!file) throw rejected(`a step uses the image ${id}, which isn't in the file`);
    const format = sniff(file.data);
    if (!format) throw rejected("an image isn't WebP, PNG or JPEG");
    const source = new Blob([file.data.slice()], { type: `image/${format}` });
    let size: { width: number; height: number };
    try {
      size = await codec.measure(source);
    } catch {
      throw rejected("an image is damaged");
    }
    if (size.width * size.height > limits.maxPixels)
      throw rejected("an image is larger than 100 megapixels");
    // A WebP within 2560 pixels, or a lossless one of any size (an Original screenshot), is
    // kept as it is, so a guide passed back and forth doesn't lose quality.
    const fitted = fit(size.width, size.height, MAX_EDGE);
    const keep =
      format === "webp" &&
      ((fitted.width === size.width && fitted.height === size.height) || isLosslessWebp(file.data));
    media.push({
      id,
      image: keep ? source : await codec.render(source, fitted.width, fitted.height, WEBP_QUALITY),
      width: keep ? size.width : fitted.width,
      height: keep ? size.height : fitted.height,
    });
  }
  return { guide, steps, media };
}

/** Imports a guide file into the browser's library; nothing is kept unless every rule passes. Returns the new guide's id. */
export async function importArchive(
  db: LibraryDb,
  codec: ImageCodec,
  bytes: Uint8Array,
  limits: ImportLimits = IMPORT_LIMITS,
): Promise<string> {
  const { guide, steps, media } = await readArchive(codec, bytes, limits);
  const guideId = isSafeId(guide.id) && !(await db.get("guides", guide.id)) ? guide.id : newId();
  guide.id = guideId;
  const tx = db.transaction(["guides", "steps", "media"], "readwrite");
  if (await tx.objectStore("guides").get(guideId)) {
    tx.done.catch(() => undefined);
    tx.abort();
    throw errors.guideExists();
  }
  await tx.objectStore("guides").put({ id: guideId, guide });
  for (const step of steps)
    await tx.objectStore("steps").put({ guideId, id: String(step.id), step });
  for (const item of media)
    await tx.objectStore("media").put({ ...item, guideId, thumbnail: null } satisfies StoredMedia);
  await tx.done;
  return guideId;
}
