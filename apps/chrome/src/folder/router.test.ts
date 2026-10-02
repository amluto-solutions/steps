import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import type { FileAccess } from "../files";
import { openLibraryDb, type LibraryDb } from "../library/db";
import type { ImageCodec } from "../library/images";
import { BROWSER_LIBRARY_ID as BROWSER, createBrowserLibrary } from "../library/store";

import blockStep from "../../../../packages/core/test-vectors/guide-v1/steps/step-2.json";

import { memoryDir, walk, type Dir } from "./dir";
import { readJson } from "./files";
import type { FolderHandle, FolderRegistry, RegisteredFolder } from "./registry";
import { createLibraryRouter, STALE_AFTER_MS, type LibraryRouter } from "./router";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const codec: ImageCodec = {
  async measure(blob) {
    const view = new DataView(await blob.arrayBuffer());
    return { width: view.getUint32(16), height: view.getUint32(20) };
  },
  render: (_blob, width, height) => Promise.resolve(new Blob([png(width, height).slice()])),
  pixels: () =>
    Promise.resolve({ data: new Uint8ClampedArray(8 * 8 * 4).fill(128), width: 8, height: 8 }),
  encode: (image) => Promise.resolve(new Blob([png(image.width, image.height).slice()])),
};

const saved = new Map<string, Uint8Array>();
const files: FileAccess = {
  pickFile: () => Promise.resolve("file:1"),
  pickSaveLocation: (_title, name) => Promise.resolve(`save:${name}`),
  read: (token) => Promise.resolve(saved.get(token) ?? new Uint8Array()),
  write: (token, bytes) => {
    saved.set(token, bytes);
    return Promise.resolve(token);
  },
};

/** A folder the person could choose, allowed or not, and asking or not. */
function folderHandle(name: string, dir: Dir, access = { allowed: true, grantOnAsk: true }) {
  const handle: FolderHandle & { access: typeof access } = {
    name,
    access,
    permitted: (ask) =>
      Promise.resolve(access.allowed || (ask && (access.allowed = access.grantOnAsk))),
    open: () => dir,
    same: (other) => Promise.resolve(other.open() === dir),
  };
  return handle;
}

function memoryRegistry(): FolderRegistry {
  const folders = new Map<string, RegisteredFolder>();
  let chosen: string | null = null;
  return {
    list: () => Promise.resolve([...folders.values()]),
    put: (entry) => {
      folders.set(entry.id, entry);
      return Promise.resolve();
    },
    remove: (id) => {
      folders.delete(id);
      return Promise.resolve();
    },
    defaultId: () => Promise.resolve(chosen),
    setDefaultId: (id) => {
      chosen = id;
      return Promise.resolve();
    },
  };
}

const idOf = (doc: { guide: unknown }) => String((doc.guide as { id?: unknown }).id);

let count = 0;
let db: LibraryDb;
let registry: FolderRegistry;
let shared: Dir;
let clock: number;
let openPages: Set<string>;
let toPick: FolderHandle | null;

function router(name: string, session: string, pc = "PC-1"): LibraryRouter {
  openPages.add(session);
  return createLibraryRouter({
    browser: createBrowserLibrary({
      db,
      codec,
      displayName: () => name,
      files,
      appVersion: "0.4.2",
    }),
    db,
    registry,
    codec,
    files,
    appVersion: "0.4.2",
    displayName: () => name,
    pc,
    session,
    alive: (other) => Promise.resolve(openPages.has(other)),
    pickFolder: () => Promise.resolve(toPick),
    now: () => clock,
  });
}

/** Adds `dir` as a library through the picker, as Settings does; answers its id. */
async function addFolder(
  library: LibraryRouter,
  name: string,
  dir: Dir,
  access?: { allowed: boolean; grantOnAsk: boolean },
) {
  toPick = folderHandle(name, dir, access);
  const token = await library.pickFolder("Choose");
  expect(token).toMatch(new RegExp(`/${name}$`));
  return (await library.addLibrary(name, token ?? "")).id;
}

beforeEach(async () => {
  count += 1;
  db = await openLibraryDb(`router-${count}`);
  registry = memoryRegistry();
  shared = memoryDir("Shared");
  clock = 1_000_000;
  openPages = new Set();
  toPick = null;
});

describe("the libraries", () => {
  it("lists the browser's own library and the folders, and makes a folder a library", async () => {
    const library = router("Robin Hale", "robin");
    expect(library.folderLibraries).toBe(true);
    const id = await addFolder(library, "Shared", shared);
    const [own, folder] = await library.listLibraries();
    expect(own).toMatchObject({ id: BROWSER, isDefault: true, builtIn: true });
    expect(folder).toMatchObject({
      id,
      name: "Shared",
      path: "Shared",
      synced: true,
      guideCount: 0,
    });
    // The folder's own id, from the marker made for it.
    expect(await readJson(shared, ".amluto-library.json")).toMatchObject({
      id,
      name: "Shared",
      formatVersion: 1,
    });
    expect(await walk(shared, "guides")).not.toBeNull();
    toPick = folderHandle("Shared", shared);
    const again = await library.pickFolder("Choose");
    await expect(library.addLibrary("Shared", again ?? "")).rejects.toMatchObject({
      code: "libraryExists",
    });
    // A desktop path from a backup can't be opened here.
    await expect(library.addLibrary("Old", "C:\\Guides")).rejects.toMatchObject({
      code: "invalidRequest",
    });
  });

  it("uses a folder's existing library id, unless another library already has it", async () => {
    await shared.write(
      ".amluto-library.json",
      JSON.stringify({ id: "team-guides", name: "Team", formatVersion: 1 }),
    );
    const library = router("Robin Hale", "robin");
    expect(await addFolder(library, "Shared", shared)).toBe("team-guides");
    const copied = memoryDir("Copy");
    await copied.write(
      ".amluto-library.json",
      JSON.stringify({ id: "team-guides", name: "Team", formatVersion: 1 }),
    );
    expect(await addFolder(library, "Copy", copied)).not.toBe("team-guides");
  });

  it("asks for a folder again only from a click, and lists it as needing that until then", async () => {
    const library = router("Robin Hale", "robin");
    const access = { allowed: true, grantOnAsk: true };
    const id = await addFolder(library, "Shared", shared, access);
    access.allowed = false;
    expect((await library.listLibraries())[1]).toMatchObject({ needsAccess: true, guideCount: 0 });
    await expect(library.listGuides(id)).rejects.toMatchObject({
      code: "folderAccess",
      message: "Shared",
    });
    expect(await library.allowAccess?.(id)).toBe(true);
    expect((await library.listLibraries())[1]?.needsAccess).toBeUndefined();
  });

  it("sends new recordings to the default library, and never removes it or the browser's own", async () => {
    const library = router("Robin Hale", "robin");
    const id = await addFolder(library, "Shared", shared);
    expect(await library.setDefaultLibrary(id)).toMatchObject({ isDefault: true });
    const target = await library.publishTarget();
    await target.publish(
      "rec-1",
      { title: "Recorded", recordingSessionId: "s1", formatVersion: 1 },
      [],
      [],
    );
    expect(await target.recordingOf("rec-1")).toBe("s1");
    expect((await library.listGuides(id)).map((guide) => guide.id)).toEqual(["rec-1"]);
    await expect(library.removeLibrary(id)).rejects.toMatchObject({ code: "defaultLibrary" });
    await expect(library.removeLibrary(BROWSER)).rejects.toMatchObject({ code: "invalidRequest" });
    await library.setDefaultLibrary(BROWSER);
    await library.removeLibrary(id);
    expect(await library.listLibraries()).toHaveLength(1);
    // The folder itself is untouched.
    expect(await walk(shared, "guides", "rec-1")).not.toBeNull();
  });
});

describe("editing a shared guide", () => {
  let robin: LibraryRouter;
  let id: string;
  let guideId: string;

  beforeEach(async () => {
    robin = router("Robin Hale", "robin", "ROBINS-PC");
    id = await addFolder(robin, "Shared", shared);
    guideId = idOf(await robin.createGuide(id, "Payroll"));
  });

  it("is read-only for someone else, and refuses their changes", async () => {
    expect(await robin.openForEditing(id, guideId, false)).toEqual({ kind: "editing" });
    const sam = router("Sam Jones", "sam", "SAMS-PC");
    expect(await sam.openForEditing(id, guideId, false)).toMatchObject({
      kind: "readOnly",
      lock: { name: "Robin Hale", pc: "ROBINS-PC" },
    });
    await expect(
      sam.saveStep(id, guideId, { id: "s1", sortKey: "a0", formatVersion: 1 }),
    ).rejects.toMatchObject({ code: "lockLost", message: expect.stringContaining("Robin Hale") });
    // Nor can Sam move it away from under Robin; a copy only reads it.
    await expect(sam.moveGuide(id, guideId, BROWSER)).rejects.toMatchObject({ code: "lockLost" });
    expect(await sam.copyGuide(id, guideId, BROWSER)).toMatchObject({ title: "Payroll" });
    expect(await robin.listGuides(id)).toHaveLength(1);
    // Comments and drafts don't need the lock.
    await sam.addComment(id, guideId, null, null, "Looks good");
    await sam.saveDraft(id, guideId, { guide: { id: guideId }, steps: [] });
    expect(await robin.listDrafts(id, guideId)).toMatchObject([{ id: "sam", by: "Sam Jones" }]);
  });

  it("takes over a lock only once this page has watched it stand still for 20 minutes", async () => {
    await robin.openForEditing(id, guideId, false);
    const sam = router("Sam Jones", "sam", "SAMS-PC");
    expect((await sam.openForEditing(id, guideId, false)).kind).toBe("readOnly");
    clock += STALE_AFTER_MS - 1;
    expect((await sam.openForEditing(id, guideId, false)).kind).toBe("readOnly");
    // Robin's page is still beating: the wait starts again.
    await robin.beat();
    clock += STALE_AFTER_MS;
    expect((await sam.openForEditing(id, guideId, false)).kind).toBe("readOnly");
    clock += STALE_AFTER_MS;
    expect((await sam.openForEditing(id, guideId, false)).kind).toBe("editing");
  });

  it("takes back a lock left by a page of this browser that has closed, not by one still open", async () => {
    await robin.openForEditing(id, guideId, false);
    const again = router("Robin Hale", "robin-2", "ROBINS-PC");
    expect((await again.openForEditing(id, guideId, false)).kind).toBe("readOnly");
    openPages.delete("robin");
    expect((await again.openForEditing(id, guideId, false)).kind).toBe("editing");
  });

  it("tells the editor when someone takes over, and stops holding the guide", async () => {
    await robin.openForEditing(id, guideId, false);
    const lost: string[] = [];
    await robin.onLockLost((event) => lost.push(`${event.guideId} ${event.lock.name}`));
    const sam = router("Sam Jones", "sam", "SAMS-PC");
    await sam.openForEditing(id, guideId, true);
    await robin.beat();
    expect(lost).toEqual([`${guideId} Sam Jones`]);
    await robin.beat();
    expect(lost).toHaveLength(1);
  });

  it("notes a delete, and forgets it when this page saves the step again", async () => {
    await robin.openForEditing(id, guideId, false);
    await robin.saveStep(id, guideId, { id: "s1", sortKey: "a0", formatVersion: 1 });
    await robin.deleteStep(id, guideId, "s1");
    expect(
      await readJson((await walk(shared, "guides", guideId, "deleted")) as Dir, "s1.json"),
    ).toMatchObject({
      by: "Robin Hale",
      session: "robin",
    });
    await robin.saveStep(id, guideId, { id: "s1", sortKey: "a0", formatVersion: 1 });
    expect(await robin.listConflicts(id, guideId)).toEqual([]);
    await robin.releaseLock(id, guideId);
    expect(await walk(shared, "guides", guideId)).not.toBeNull();
    expect(
      (await (await walk(shared, "guides", guideId))?.entries())?.map((entry) => entry.name),
    ).not.toContain(".lock");
  });
});

describe("between the browser and a folder", () => {
  it("copies a guide both ways without its history, and moves one with it", async () => {
    const library = router("Robin Hale", "robin", "ROBINS-PC");
    const id = await addFolder(library, "Shared", shared);
    const guideId = idOf(await library.createGuide(BROWSER, "Payroll"));
    const media = await library.importImage(BROWSER, guideId, png(10, 10));
    await library.saveStep(BROWSER, guideId, {
      id: "s1",
      sortKey: "a0",
      kind: "interaction",
      actionText: "Click Pay",
      media: { id: media.id },
      formatVersion: 1,
    });
    await library.saveVersion(BROWSER, guideId, "First");
    await library.addComment(BROWSER, guideId, "s1", null, "Check this");

    // A copy is a Duplicate (01/10/2026): steps and pictures, no versions or comments.
    const copied = await library.copyGuide(BROWSER, guideId, id);
    expect(copied).toMatchObject({
      id: guideId,
      stepCount: 1,
      openComments: 0,
      thumbnailMediaId: media.id,
    });
    expect(await library.listVersions(id, guideId)).toEqual([]);
    expect(await library.loadImage(id, guideId, media.id, false)).toMatch(
      /^data:image\/webp;base64,/,
    );

    // And back: the id is taken in the browser, so the copy gets a new one.
    const back = await library.copyGuide(id, guideId, BROWSER);
    expect(back.id).not.toBe(guideId);
    expect(back).toMatchObject({ stepCount: 1, openComments: 0 });

    // A move takes everything: versions and comments, still Robin's own in the folder.
    await library.trashGuide(id, guideId);
    const moved = await library.moveGuide(BROWSER, guideId, id);
    expect(moved).toMatchObject({ stepCount: 1, openComments: 1 });
    expect(await library.listVersions(id, moved.id)).toMatchObject([{ note: "First" }]);
    expect(await library.listComments(id, moved.id)).toMatchObject([
      { text: "Check this", mine: true },
    ]);
    expect((await library.listGuides(BROWSER)).map((guide) => guide.id)).toEqual([back.id]);

    await library.moveGuide(id, moved.id, BROWSER);
    expect(await library.listGuides(id)).toEqual([]);
    expect(await library.listTrash(id)).toHaveLength(2);
  });

  it("merges guides from the browser and a folder into a new guide, copying their pictures", async () => {
    const library = router("Robin Hale", "robin", "ROBINS-PC");
    const id = await addFolder(library, "Shared", shared);
    const fromBrowser = idOf(await library.createGuide(BROWSER, "Payroll"));
    const browserPicture = await library.importImage(BROWSER, fromBrowser, png(10, 10));
    const fromFolder = idOf(await library.createGuide(id, "Holiday"));
    const folderPicture = await library.importImage(id, fromFolder, png(12, 12));
    const guide = {
      id: "merged-1",
      title: "Both",
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      formatVersion: 1,
    };
    const steps = [
      { id: "s1", sortKey: "a0", kind: "interaction", media: { id: "n1" }, formatVersion: 1 },
      { id: "s2", sortKey: "a1", kind: "interaction", media: { id: "n2" }, formatVersion: 1 },
    ];
    const media = [
      {
        fromLibraryId: BROWSER,
        fromGuideId: fromBrowser,
        mediaId: browserPicture.id,
        newMediaId: "n1",
      },
      { fromLibraryId: id, fromGuideId: fromFolder, mediaId: folderPicture.id, newMediaId: "n2" },
    ];

    const made = await library.createFromParts(id, guide, steps, media);
    expect(made).toMatchObject({ id: "merged-1", title: "Both", stepCount: 2 });
    for (const picture of ["n1", "n2"])
      expect(await library.loadImage(id, "merged-1", picture, false)).toMatch(/^data:image\/webp/);
    // The guides it came from are as they were.
    expect((await library.listGuides(BROWSER)).map((item) => item.id)).toEqual([fromBrowser]);
    expect((await library.listGuides(id)).map((item) => item.id).sort()).toEqual(
      ["merged-1", fromFolder].sort(),
    );

    // Into the browser's own library too; a picture that isn't there stops it.
    const inBrowser = await library.createFromParts(
      BROWSER,
      { ...guide, id: "merged-2" },
      steps,
      media,
    );
    expect(inBrowser).toMatchObject({ id: "merged-2", stepCount: 2 });
    await expect(
      library.createFromParts(id, { ...guide, id: "merged-3" }, steps, [
        { ...media[0], mediaId: "missing" } as (typeof media)[number],
      ]),
    ).rejects.toMatchObject({ code: "imageNotFound" });
  });

  it("exports and imports .amlsteps files in a folder library", async () => {
    const library = router("Robin Hale", "robin");
    const id = await addFolder(library, "Shared", shared);
    const guideId = idOf(await library.createGuide(id, "Payroll"));
    await library.openForEditing(id, guideId, false);
    // A whole valid step (a tip box), as exports check every step.
    await library.saveStep(id, guideId, blockStep);
    await library.exportAmlsteps(id, guideId, "save:Payroll.amlsteps", false);
    saved.set("file:1", saved.get("save:Payroll.amlsteps") ?? new Uint8Array());
    const imported = await library.importAmlsteps(id, "file:1");
    expect(imported.id).not.toBe(guideId);
    // A tip box only: notes and headers aren't counted as steps.
    expect(imported).toMatchObject({ title: "Payroll", stepCount: 0 });
  });
});
