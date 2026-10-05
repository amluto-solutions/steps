import "fake-indexeddb/auto";

import type { LibraryBridge } from "@amluto-steps/ui";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FileAccess } from "../files";

import { openLibraryDb } from "./db";
import type { ImageCodec } from "./images";
import { BROWSER_LIBRARY_ID as LIB, createBrowserLibrary } from "./store";

/** A PNG header with this size: all the fake codec reads. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Drawing without a canvas: every picture is a PNG header with its size; pixels are grey. */
const fakeCodec: ImageCodec = {
  async measure(blob) {
    const view = new DataView(await blob.arrayBuffer());
    // A real (lossy, "VP8 ") WebP from the shared file: 14-bit sizes after the frame header.
    if (view.getUint32(0) === 0x52494646)
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    return { width: view.getUint32(16), height: view.getUint32(20) };
  },
  render: (_blob, width, height) => Promise.resolve(new Blob([png(width, height).slice()])),
  pixels: () =>
    Promise.resolve({ data: new Uint8ClampedArray(64 * 64 * 4).fill(128), width: 64, height: 64 }),
  encode: (image) => Promise.resolve(new Blob([png(image.width, image.height).slice()])),
};

/** Files in memory: what a save wrote, and what a pick hands back. */
const saved = new Map<string, Uint8Array>();
let toOpen: Uint8Array = new Uint8Array();
const memoryFiles: FileAccess = {
  pickFile: () => Promise.resolve("file:1"),
  pickSaveLocation: (_title, name) => Promise.resolve(`save:${name}`),
  read: () => Promise.resolve(toOpen),
  write: (token, bytes) => {
    saved.set(token, bytes);
    return Promise.resolve(token);
  },
  pickFolder: () => Promise.resolve("folder:1"),
  saveInFolder: (folder, name, bytes) => {
    if (folder === "folder:bad") return Promise.reject(new Error("The file didn't arrive whole."));
    saved.set(`${folder}/${name}`, bytes);
    return Promise.resolve(name);
  },
};

let library: LibraryBridge;
let name = "Robin";
let dbCount = 0;

beforeEach(async () => {
  dbCount += 1;
  name = "Robin";
  library = createBrowserLibrary({
    db: await openLibraryDb(`test-${dbCount}`),
    codec: fakeCodec,
    displayName: () => name,
    files: memoryFiles,
    appVersion: "9.9.9",
  });
});

const step = (id: string, sortKey: string, extra: Record<string, unknown> = {}) => ({
  id,
  sortKey,
  kind: "interaction",
  action: "click",
  actionText: `Click ${id}`,
  formatVersion: 1,
  ...extra,
});

const idOf = (doc: { guide: unknown }) => (doc.guide as { id: string }).id;

describe("the browser library", () => {
  it("creates, saves and lists guides as the desktop does", async () => {
    const doc = await library.createGuide(LIB, "  Payroll  ");
    const guide = doc.guide as Record<string, unknown>;
    expect(guide).toMatchObject({
      title: "Payroll",
      owner: "Robin",
      createdBy: "Robin",
      formatVersion: 1,
      tags: [],
      intro: null,
    });
    expect(guide.id).toMatch(/^[0-9a-f]{32}$/);
    expect(guide.createdAt).toBe(guide.updatedAt);

    const id = idOf(doc);
    const image = await library.importImage(LIB, id, png(5120, 2880));
    expect(image).toMatchObject({ width: 2560, height: 1440 });
    await library.saveStep(LIB, id, step("s2", "a1"));
    await library.saveStep(LIB, id, step("s1", "a0", { media: { id: image.id } }));
    const loaded = await library.loadGuide(LIB, id);
    expect(loaded.steps.map((each) => (each as { id: string }).id)).toEqual(["s1", "s2"]);

    const [summary] = await library.listGuides(LIB);
    expect(summary).toMatchObject({ id, title: "Payroll", stepCount: 2, openComments: 0 });
    expect(summary?.thumbnailMediaId).toBe(image.id);
    const thumbnail = await library.loadImage(LIB, id, image.id, true);
    const bytes = Uint8Array.from(atob(thumbnail.slice(thumbnail.indexOf(",") + 1)), (ch) =>
      ch.charCodeAt(0),
    );
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([480, 270]);
  });

  it("refuses what the desktop refuses, with the same codes", async () => {
    const id = idOf(await library.createGuide(LIB, "G"));
    await expect(library.loadGuide(LIB, "../x")).rejects.toMatchObject({ code: "invalidId" });
    await expect(library.loadGuide(LIB, "missing")).rejects.toMatchObject({
      code: "guideNotFound",
    });
    await expect(
      library.saveStep(LIB, id, { ...step("s1", "a0"), formatVersion: 2 }),
    ).rejects.toMatchObject({ code: "newerFormat" });
    await expect(
      library.saveGuide(LIB, id, { id: "other", formatVersion: 1 }),
    ).rejects.toMatchObject({ code: "invalidRequest" });
    await expect(
      library.importImage(LIB, id, new TextEncoder().encode("GIF89a")),
    ).rejects.toMatchObject({ code: "unsupportedImage" });
  });

  it("keeps a password lock and history out of copies, and drops the lock in the Bin (04/10/2026)", async () => {
    const id = idOf(await library.createGuide(LIB, "Locked"));
    await library.writeGuideLock(LIB, id, {
      formatVersion: 1,
      locked: { by: "Robin Hale", login: "", pc: "", at: "2026-10-04T10:00:00Z" },
      password: "pbkdf2-sha256$1000$AAAA$AAAA",
    });
    await library.writeGuideHistory(LIB, id, { formatVersion: 1, saves: 2 });
    expect((await library.listGuides(LIB))[0]?.locked).toEqual({
      by: "Robin Hale",
      at: "2026-10-04T10:00:00Z",
    });
    expect(await library.guideMeta(LIB, id)).toMatchObject({ history: { saves: 2 } });
    const copy = await library.duplicateGuide(LIB, id, "Copy");
    expect(copy.locked).toBeUndefined();
    expect(await library.guideMeta(LIB, copy.id)).toEqual({ lock: null, history: null });
    await expect(library.writeGuideLock(LIB, id, { nope: true })).rejects.toThrow();

    const entry = await library.trashGuide(LIB, id);
    const restored = await library.restoreGuide(LIB, entry.trashId);
    expect(restored.locked).toBeUndefined();
    expect(await library.guideMeta(LIB, id)).toMatchObject({ lock: null, history: { saves: 2 } });
  });

  it("moves a guide to the Bin and back, whole", async () => {
    const id = idOf(await library.createGuide(LIB, "Holiday"));
    await library.saveStep(LIB, id, step("s1", "a0"));
    await library.saveVersion(LIB, id, "First");
    const entry = await library.trashGuide(LIB, id);
    expect(entry).toMatchObject({ guideId: id, title: "Holiday" });
    expect(await library.listGuides(LIB)).toEqual([]);
    expect(await library.listTrash(LIB)).toEqual([entry]);

    const restored = await library.restoreGuide(LIB, entry.trashId);
    expect(restored).toMatchObject({ id, stepCount: 1 });
    expect(await library.listVersions(LIB, id)).toHaveLength(1);
    await expect(library.restoreGuide(LIB, entry.trashId)).rejects.toMatchObject({
      code: "trashNotFound",
    });
  });

  it("deletes a guide in the Bin for good, and empties the Bin", async () => {
    const first = await library.trashGuide(LIB, idOf(await library.createGuide(LIB, "One")));
    const second = await library.trashGuide(LIB, idOf(await library.createGuide(LIB, "Two")));
    await library.deleteTrashed(LIB, first.trashId);
    expect(await library.listTrash(LIB)).toEqual([second]);
    await expect(library.deleteTrashed(LIB, first.trashId)).rejects.toMatchObject({
      code: "trashNotFound",
    });
    await library.trashGuide(LIB, idOf(await library.createGuide(LIB, "Three")));
    expect(await library.emptyTrash(LIB)).toBe(2);
    expect(await library.listTrash(LIB)).toEqual([]);
  });

  it("duplicates steps and pictures under a new id, without versions", async () => {
    const id = idOf(await library.createGuide(LIB, "Original"));
    const image = await library.importImage(LIB, id, png(100, 50));
    await library.saveStep(LIB, id, step("s1", "a0", { media: { id: image.id } }));
    await library.saveVersion(LIB, id, "v1");
    const copy = await library.duplicateGuide(LIB, id, "Copy");
    expect(copy.id).not.toBe(id);
    expect(copy).toMatchObject({ title: "Copy", stepCount: 1, thumbnailMediaId: image.id });
    await expect(library.loadImage(LIB, copy.id, image.id, false)).resolves.toMatch(
      /^data:image\/webp;base64,/,
    );
    expect(await library.listVersions(LIB, copy.id)).toEqual([]);
  });

  it("restores a version, keeping the current state as a version first", async () => {
    const id = idOf(await library.createGuide(LIB, "G"));
    await library.saveStep(LIB, id, step("s1", "a0"));
    const version = await library.saveVersion(LIB, id, " Before changes ");
    expect(version).toMatchObject({ note: "Before changes", createdBy: "Robin", stepCount: 1 });
    await library.saveStep(LIB, id, step("s2", "a1"));
    const restored = await library.restoreVersion(LIB, id, version.id);
    expect(restored.steps.map((each) => (each as { id: string }).id)).toEqual(["s1"]);
    const versions = await library.listVersions(LIB, id);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.note).toMatch(/^Before restoring \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
    expect(versions[0]?.stepCount).toBe(2);
  });

  it("keeps comment threads, and lets only the author delete one", async () => {
    const id = idOf(await library.createGuide(LIB, "G"));
    const thread = await library.addComment(LIB, id, "s1", null, "Is this right?");
    name = "Sam";
    await library.addComment(LIB, id, null, thread, "Yes");
    await expect(library.deleteComment(LIB, id, thread)).rejects.toMatchObject({
      code: "invalidRequest",
    });
    await library.resolveComment(LIB, id, thread, true);
    const [listed] = await library.listComments(LIB, id);
    expect(listed).toMatchObject({ stepId: "s1", resolved: { by: "Sam" } });
    expect(listed?.replies).toHaveLength(1);
    expect((await library.listGuides(LIB))[0]?.openComments).toBe(0);
  });

  it("burns blur into new copies, repoints every step and version, and does it once", async () => {
    const id = idOf(await library.createGuide(LIB, "G"));
    const image = await library.importImage(LIB, id, png(64, 64));
    const blurred = step("s1", "a0", {
      media: { id: image.id, width: 64, height: 64 },
      redactions: [{ x: 10, y: 10, w: 20, h: 20, source: "manual" }],
    });
    await library.saveStep(LIB, id, blurred);
    await library.saveVersion(LIB, id, "with blur");

    expect(await library.applyRedactions(LIB, id)).toBe(1);
    const [now] = (await library.loadGuide(LIB, id)).steps as { media: { id: string } }[];
    expect(now?.media.id).not.toBe(image.id);
    const [version] = await library.listVersions(LIB, id);
    const old = (await library.loadVersion(LIB, id, version?.id ?? "")).steps as {
      media: { id: string };
    }[];
    expect(old[0]?.media.id).toBe(now?.media.id);
    await expect(library.loadImage(LIB, id, image.id, false)).rejects.toMatchObject({
      code: "imageNotFound",
    });
    // Nothing new to burn.
    expect(await library.applyRedactions(LIB, id)).toBe(0);
  });

  it("searches wording and says which step", async () => {
    const id = idOf(await library.createGuide(LIB, "Month end"));
    await library.saveStep(LIB, id, { ...step("s1", "a0"), actionText: 'Click "Close period"' });
    expect(await library.searchGuides(LIB, "period")).toEqual([
      { guideId: id, foundIn: { stepNumber: 1, snippet: 'Click "Close period"' } },
    ]);
  });
});

/** The shared guide, as a file the Chrome edition wrote; the desktop's tests read it too. */
const sharedFile = new Uint8Array(
  readFileSync(
    join(import.meta.dirname, "../../../../packages/core/test-vectors/guide-v1-chrome.amlsteps"),
  ),
);

describe("browser storage", () => {
  it("counts each guide's bytes, and the Bin's in the library total", async () => {
    const kept = idOf(await library.createGuide(LIB, "Kept"));
    const image = await library.importImage(LIB, kept, png(800, 600));
    await library.saveStep(LIB, kept, step("s1", "a0", { media: { id: image.id } }));
    const binned = idOf(await library.createGuide(LIB, "Binned"));
    await library.saveStep(LIB, binned, step("s1", "a0"));

    const before = await library.storageUse?.(LIB);
    const sizes = new Map((await library.listGuides(LIB)).map((g) => [g.title, g.sizeBytes ?? 0]));
    expect(sizes.get("Kept")).toBeGreaterThan(sizes.get("Binned") ?? 0);
    expect(before?.libraryBytes).toBe((sizes.get("Kept") ?? 0) + (sizes.get("Binned") ?? 0));

    await library.trashGuide(LIB, binned);
    // In the Bin it still takes its space, so the total barely moves.
    const after = await library.storageUse?.(LIB);
    expect(after?.libraryBytes).toBeGreaterThanOrEqual(sizes.get("Kept") ?? 0);
    expect(after?.libraryBytes).toBeGreaterThan(sizes.get("Kept") ?? 0);
  });

  /** The guide the desktop wrote (two steps, one screenshot), imported into this library. */
  const desktopGuide = async () => {
    toOpen = new Uint8Array(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../../packages/core/test-vectors/guide-v1-desktop.amlsteps",
        ),
      ),
    );
    return (await library.importAmlsteps(LIB, "file:1")).id;
  };

  it("exports a guide with its originals, then deletes it for good (not to the Bin)", async () => {
    const id = await desktopGuide();
    const [first] = (await library.loadGuide(LIB, id)).steps as Record<string, unknown>[];
    const redactions = [{ x: 10, y: 10, w: 20, h: 20, source: "manual" }];
    await library.saveStep(LIB, id, { ...first, redactions });
    await library.saveVersion(LIB, id, "First");

    expect(await library.pickExportFolder?.("Choose")).toBe("folder:1");
    const name = await library.exportAndRemove?.(LIB, id, "folder:1");
    expect(name).toBe("Pay a supplier invoice.amlsteps");
    // The unblurred original, with the blur still a rectangle that can be changed once imported.
    const file = unzipSync(saved.get(`folder:1/${String(name)}`) ?? new Uint8Array());
    const media = (first?.media as { id: string }).id;
    expect(Object.keys(file)).toContain(`guide/media/${media}.webp`);
    const written = JSON.parse(strFromU8(file["guide/steps/step-1.json"] ?? new Uint8Array()));
    expect(written).toMatchObject({ redactions, media: { id: media } });

    expect(await library.listGuides(LIB)).toEqual([]);
    expect(await library.listTrash(LIB)).toEqual([]);
    expect((await library.storageUse?.(LIB))?.libraryBytes).toBe(0);
  });

  it("keeps the guide when its file can't be saved", async () => {
    const id = await desktopGuide();
    await expect(library.exportAndRemove?.(LIB, id, "folder:bad")).rejects.toThrow("whole");
    expect(await library.listGuides(LIB)).toMatchObject([{ id, stepCount: 1 }]);
  });
});

describe(".amlsteps files", () => {
  it("reads the shared guide file, and writes it back with blur burned in and the typed value left out", async () => {
    toOpen = sharedFile;
    const imported = await library.importAmlsteps(LIB, "file:1");
    expect(imported).toMatchObject({
      id: "guide-v1-fixture",
      title: "Pay a supplier invoice",
      stepCount: 1,
    });

    await library.exportAmlsteps(LIB, imported.id, "save:out.amlsteps", false);
    const entries = unzipSync(saved.get("save:out.amlsteps") as Uint8Array);
    expect(JSON.parse(strFromU8(entries["amlsteps.json"] as Uint8Array))).toMatchObject({
      formatVersion: 1,
      kind: "guide",
      appVersion: "9.9.9",
    });
    const written = JSON.parse(strFromU8(entries["guide/steps/step-1.json"] as Uint8Array));
    expect(written.textParts.value).toBeUndefined();
    expect(written.redactions).toEqual([]);
    expect(written.media.id).not.toBe("media-1");
    // Only the burned copy leaves; the unblurred original doesn't.
    expect(Object.keys(entries).filter((name) => name.startsWith("guide/media/"))).toEqual([
      `guide/media/${written.media.id}.webp`,
    ]);

    // Back in again: its id is taken here, so it gets a new one.
    toOpen = saved.get("save:out.amlsteps") as Uint8Array;
    const again = await library.importAmlsteps(LIB, "file:1");
    expect(again.id).not.toBe("guide-v1-fixture");
    expect(again).toMatchObject({ title: "Pay a supplier invoice", stepCount: 1 });
  });

  it("reads a guide file the desktop wrote", async () => {
    toOpen = new Uint8Array(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../../packages/core/test-vectors/guide-v1-desktop.amlsteps",
        ),
      ),
    );
    expect(await library.importAmlsteps(LIB, "file:1")).toMatchObject({
      id: "guide-v1-fixture",
      title: "Pay a supplier invoice",
      stepCount: 1,
    });
  });

  const archive = (files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 9 }]>) =>
    zipSync(files);

  it.each([
    ["a path that climbs out", { "../evil.json": strToU8("{}") }, /climbs out/],
    ["a Windows device name", { "guide/CON.txt": strToU8("x") }, /device name CON/],
    [
      "a zip bomb",
      { "guide/steps/big.json": [new Uint8Array(3 * 1024 * 1024), { level: 9 }] },
      /zip bombs/,
    ],
    ["no manifest", { "guide/guide.json": strToU8("{}") }, /no amlsteps\.json/],
    ["not a zip at all", null, /isn't a valid \.amlsteps file/],
  ] as const)("refuses %s", async (_what, files, rule) => {
    toOpen = files ? archive(files as Record<string, Uint8Array>) : strToU8("not a zip");
    await expect(library.importAmlsteps(LIB, "file:1")).rejects.toMatchObject({
      code: "importRejected",
      message: expect.stringMatching(rule) as unknown,
    });
    expect(await library.listGuides(LIB)).toEqual([]);
  });

  it("refuses a file from a newer Steps", async () => {
    toOpen = archive({
      "amlsteps.json": strToU8(
        JSON.stringify({ formatVersion: 2, kind: "guide", exportedAt: "x", appVersion: "9" }),
      ),
    });
    await expect(library.importAmlsteps(LIB, "file:1")).rejects.toMatchObject({
      code: "newerFormat",
    });
  });

  it("refuses a step whose picture isn't in the file", async () => {
    const entries = unzipSync(sharedFile);
    delete entries["guide/media/media-1.webp"];
    toOpen = archive(entries);
    await expect(library.importAmlsteps(LIB, "file:1")).rejects.toMatchObject({
      message: expect.stringMatching(/uses the image media-1/) as unknown,
    });
  });
});
