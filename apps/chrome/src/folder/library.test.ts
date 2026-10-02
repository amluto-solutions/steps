import { beforeEach, describe, expect, it } from "vitest";

import type { ImageCodec } from "../library/images";

import { addComment, deleteComment, listComments, setCommentResolved } from "./comments";
import { memoryDir, walk, type Dir } from "./dir";
import { BUILDING, readJson } from "./files";
import { applyRedactions, listVersions, loadVersion, restoreVersion, saveVersion } from "./history";
import { FolderLibrary } from "./library";
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
} from "./sharing";

/** A PNG header with this size: all the fake codec reads. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Drawing without a canvas: every picture is a PNG header with its size. */
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

const step = (id: string, sortKey: string, extra: Record<string, unknown> = {}) => ({
  id,
  sortKey,
  kind: "interaction",
  actionText: `Click ${id}`,
  formatVersion: 1,
  ...extra,
});

const idOf = (doc: { guide: unknown }) => String((doc.guide as { id?: unknown }).id);

const names = async (dir: Dir | null) =>
  dir ? (await dir.entries()).map((entry) => entry.name).sort() : [];

const DAY = 24 * 60 * 60 * 1000;

let root: ReturnType<typeof memoryDir>;
let library: FolderLibrary;
let guideId: string;

beforeEach(async () => {
  root = memoryDir();
  await root.makeFolder("guides");
  library = new FolderLibrary(root, codec);
  guideId = idOf(await library.createGuide("Payroll", "Robin Hale"));
  await library.saveStep(guideId, step("s1", "a0", { media: { id: "m1" } }));
  await library.saveStep(guideId, step("s2", "a1"));
});

describe("guides", () => {
  it("creates a guide whole, and lists and loads it as the desktop does", async () => {
    const folder = await walk(root, "guides", guideId);
    expect(await names(folder)).toEqual(["guide.json", "media", "steps"]);
    expect(await readJson(folder as Dir, "guide.json")).toMatchObject({
      title: "Payroll",
      owner: "Robin Hale",
      formatVersion: 1,
    });
    const [summary] = await library.listGuides();
    expect(summary).toMatchObject({ id: guideId, stepCount: 2, thumbnailMediaId: "m1" });
    expect(
      (await library.loadGuide(guideId)).steps.map((each) => (each as { id: string }).id),
    ).toEqual(["s1", "s2"]);
  });

  it("leaves out conflict copies and unfinished writes, and sees changes made elsewhere", async () => {
    const steps = (await walk(root, "guides", guideId, "steps")) as Dir;
    await steps.write("s1-SAMS-PC.json", JSON.stringify(step("s1", "a0")));
    await steps.write("s3.json.crswap", "{");
    expect((await library.summary(guideId)).stepCount).toBe(2);
    // Another PC renames the guide: the cached list entry isn't used once the file changed.
    const folder = (await walk(root, "guides", guideId)) as Dir;
    const guide = (await readJson(folder, "guide.json")) as Record<string, unknown>;
    await folder.write("guide.json", JSON.stringify({ ...guide, title: "Pay staff" }));
    expect((await library.summary(guideId)).title).toBe("Pay staff");
  });

  it("refuses a guide saved under another id or by a newer Steps", async () => {
    await expect(
      library.saveGuide(guideId, { id: "other", formatVersion: 1 }),
    ).rejects.toMatchObject({
      code: "invalidRequest",
    });
    await expect(
      library.saveStep(guideId, step("s3", "a2", { formatVersion: 2 })),
    ).rejects.toMatchObject({
      code: "newerFormat",
    });
    await expect(library.saveStep(guideId, step("../x", "a2"))).rejects.toMatchObject({
      code: "invalidId",
    });
  });

  it("deletes a guide in the Bin for good, and empties the Bin", async () => {
    const first = await library.trashGuide(guideId);
    const second = await library.trashGuide(idOf(await library.createGuide("Two", "")));
    await library.deleteTrashed(first.trashId);
    expect(await walk(root, ".trash", first.trashId)).toBeNull();
    expect(await library.listTrash()).toEqual([second]);
    await expect(library.deleteTrashed(first.trashId)).rejects.toMatchObject({
      code: "trashNotFound",
    });
    await library.trashGuide(idOf(await library.createGuide("Three", "")));
    expect(await library.emptyTrash()).toBe(2);
    expect(await library.listTrash()).toEqual([]);
  });

  it("moves a guide to the Bin whole, and back", async () => {
    const entry = await library.trashGuide(guideId);
    expect(await walk(root, "guides", guideId)).toBeNull();
    expect(await library.listTrash()).toEqual([entry]);
    const bin = (await walk(root, ".trash", entry.trashId)) as Dir;
    expect(await names(bin)).toEqual(["guide.json", "media", "steps", "trashed.json"]);
    const restored = await library.restoreGuide(entry.trashId);
    expect(restored).toMatchObject({ id: guideId, stepCount: 2 });
    expect(await library.listTrash()).toEqual([]);
    expect(await names(await walk(root, "guides", guideId))).toEqual([
      "guide.json",
      "media",
      "steps",
    ]);
  });

  it("leaves the guide where it was when the Bin can't be written", async () => {
    const failing = memoryDir("library", root.node, {
      failWrites: (name) => name === "trashed.json",
    });
    const flaky = new FolderLibrary(failing, codec);
    await expect(flaky.trashGuide(guideId)).rejects.toMatchObject({ code: "storageError" });
    expect((await library.summary(guideId)).stepCount).toBe(2);
    expect(await names(await walk(root, ".trash"))).toEqual([]);
  });

  it("restores over what an interrupted move to the Bin left, never over a guide", async () => {
    const entry = await library.trashGuide(guideId);
    await (
      await root.makeFolder("guides")
    )
      .makeFolder(guideId)
      .then((left) => left.write("x.webp", "x"));
    await library.restoreGuide(entry.trashId);
    const again = await library.trashGuide(guideId);
    await library.createGuide("Other", "Sam");
    await library.restoreGuide(again.trashId);
    const third = await library.trashGuide(guideId);
    await library.publish(guideId, { title: "Same id", formatVersion: 1 }, [], []);
    await expect(library.restoreGuide(third.trashId)).rejects.toMatchObject({
      code: "guideExists",
    });
  });

  it("duplicates and copies without history, and moves to another library with it", async () => {
    await saveVersion(library, guideId, "v", "Robin Hale");
    await addComment(library, guideId, null, null, "Hi", { name: "Robin Hale", pc: "PC" });
    const copy = await library.duplicateGuide(guideId, "Payroll copy");
    expect(copy).toMatchObject({ title: "Payroll copy", stepCount: 2, openComments: 0 });
    expect(await listVersions(library, copy.id)).toEqual([]);

    const other = new FolderLibrary(memoryDir("other"), codec);
    // A copy is a Duplicate (01/10/2026): no versions or comments.
    const copied = await library.copyGuideTo(guideId, other);
    expect(copied).toMatchObject({ id: guideId, stepCount: 2, openComments: 0 });
    expect(await listVersions(other, guideId)).toEqual([]);
    // Taken there now: a second copy gets a new id.
    expect((await library.copyGuideTo(guideId, other)).id).not.toBe(guideId);

    const third = new FolderLibrary(memoryDir("third"), codec);
    await library.moveGuideTo(guideId, third);
    expect(await library.listGuides()).toHaveLength(1);
    expect(await library.listTrash()).toHaveLength(1);
    // A move takes everything.
    expect(await third.summary(guideId)).toMatchObject({ stepCount: 2, openComments: 1 });
    expect(await listVersions(third, guideId)).toHaveLength(1);
  });

  it("keeps pictures as new files, and a thumbnail made once", async () => {
    const media = await library.importImage(guideId, png(4000, 2000));
    expect(media).toMatchObject({ width: 2560, height: 1280 });
    const thumbnail = await library.loadImage(guideId, media.id, true);
    expect(await codec.measure(thumbnail)).toEqual({ width: 480, height: 240 });
    expect(await names(await walk(root, "guides", guideId, "media"))).toEqual(
      [`${media.id}.thumb.webp`, `${media.id}.webp`].sort(),
    );
    await expect(library.loadImage(guideId, "missing", false)).rejects.toMatchObject({
      code: "imageNotFound",
    });
  });

  it("changes the fingerprint only when something changes", async () => {
    const before = await library.fingerprint();
    const guideBefore = await library.guideFingerprint(guideId);
    expect(await library.fingerprint()).toBe(before);
    await library.saveStep(guideId, step("s3", "a2"));
    expect(await library.fingerprint()).not.toBe(before);
    expect(await library.guideFingerprint(guideId)).not.toBe(guideBefore);
  });

  it("publishes a recording whole, and knows which recording a guide came from", async () => {
    await library.publish(
      "rec",
      { title: "Rec", recordingSessionId: "s1", formatVersion: 1 },
      [step("a", "a0")],
      [{ id: "m9", image: new Blob([png(2, 2).slice()]) }],
    );
    expect(await library.recordingOf("rec")).toBe("s1");
    expect(await library.recordingOf(guideId)).toBe("");
    expect(await library.recordingOf("nothing")).toBeNull();
    expect((await library.summary("rec")).thumbnailMediaId).toBeNull();
    expect(await names(await walk(root, "guides", "rec"))).toEqual([
      "guide.json",
      "media",
      "steps",
    ]);
  });

  it("sweeps what interrupted writes left, once a day old", async () => {
    const guides = (await walk(root, "guides")) as Dir;
    const half = await guides.makeFolder("half");
    await half.write(BUILDING, "x");
    const done = await guides.makeFolder("done");
    await done.write(BUILDING, "x");
    await done.write("guide.json", JSON.stringify({ id: "done", formatVersion: 1 }));
    const steps = (await walk(root, "guides", guideId, "steps")) as Dir;
    await steps.write("s9.json.crswap", "{");
    await library.sweep(DAY);
    expect(await names(guides)).toContain("half");
    await library.sweep(DAY, Date.now() + 2 * DAY);
    expect(await names(guides)).not.toContain("half");
    expect(await names(done)).toEqual(["guide.json"]);
    expect(await names(steps)).toEqual(["s1.json", "s2.json"]);
  });

  it("searches the guides' wording, and stops when a newer search starts", async () => {
    // "Click" is found first in step 1, the first place with a word the card doesn't show.
    expect(await library.search("click s2")).toEqual([
      { guideId, foundIn: { stepNumber: 1, snippet: "Click s1" } },
    ]);
    expect(await library.search("s2")).toEqual([
      { guideId, foundIn: { stepNumber: 2, snippet: "Click s2" } },
    ]);
    expect(await library.search("payroll")).toEqual([{ guideId, foundIn: null }]);
    expect(await library.search("click", () => false)).toEqual([]);
  });
});

describe("sharing", () => {
  const robin = { name: "Robin Hale", pc: "ROBINS-PC", session: "robin" };
  const sam = { name: "Sam Jones", pc: "SAMS-PC", session: "sam" };

  it("takes, holds and lets go of the edit lock", async () => {
    expect(await openForEditing(library, guideId, robin, false)).toMatchObject({ kind: "mine" });
    expect(await openForEditing(library, guideId, sam, false)).toMatchObject({
      kind: "theirs",
      lock: { name: "Robin Hale", counter: 0 },
    });
    expect(await heartbeat(library, guideId, robin)).toEqual({ kind: "held", counter: 1 });
    expect(await mayWrite(library, guideId, "sam")).toBe(false);
    await openForEditing(library, guideId, sam, true);
    expect(await heartbeat(library, guideId, robin)).toMatchObject({
      kind: "displaced",
      lock: { name: "Sam Jones" },
    });
    await releaseLock(library, guideId, "robin");
    expect((await readLock(library, guideId))?.session).toBe("sam");
    await releaseLock(library, guideId, "sam");
    expect(await readLock(library, guideId)).toBeNull();
    expect(await mayWrite(library, guideId, "anyone")).toBe(true);
  });

  it("settles a sync client's conflict copies", async () => {
    const steps = (await walk(root, "guides", guideId, "steps")) as Dir;
    const theirs = step("s1", "a0", { actionText: "Theirs" });
    await steps.write("s1-SAMS-PC.json", JSON.stringify(theirs));
    await steps.write("s1-LAPTOP.json", JSON.stringify(theirs));
    const [copy] = await listConflicts(library, guideId);
    expect(copy).toMatchObject({ kind: "step", file: "s1-LAPTOP.json", from: "LAPTOP" });
    await resolveConflict(library, guideId, "s1-SAMS-PC.json", "keepTheirs");
    await resolveConflict(library, guideId, "s1-LAPTOP.json", "keepBoth");
    const loaded = (await library.loadGuide(guideId)).steps as {
      id: string;
      sortKey: string;
      actionText: string;
    }[];
    expect(loaded.map((each) => [each.sortKey, each.actionText])).toEqual([
      ["a0", "Theirs"],
      ["a0m", "Theirs"],
      ["a1", "Click s2"],
    ]);
    const folder = (await walk(root, "guides", guideId)) as Dir;
    const guide = (await readJson(folder, "guide.json")) as Record<string, unknown>;
    await folder.write("guide-SAMS-PC.json", JSON.stringify({ ...guide, title: "Theirs" }));
    await expect(
      resolveConflict(library, guideId, "guide-SAMS-PC.json", "keepBoth"),
    ).rejects.toMatchObject({
      code: "invalidRequest",
    });
    await resolveConflict(library, guideId, "guide-SAMS-PC.json", "keepTheirs");
    expect((await library.summary(guideId)).title).toBe("Theirs");
    expect(await listConflicts(library, guideId)).toEqual([]);
  });

  it("brings back a step deleted on one PC and edited on another, to keep or delete", async () => {
    await noteDelete(library, guideId, "s2", "Robin Hale", "robin");
    expect(await listConflicts(library, guideId)).toMatchObject([
      { kind: "restored", id: "s2", deletedBy: "Robin Hale" },
    ]);
    await resolveConflict(library, guideId, "s2", "keepOurs");
    expect((await library.summary(guideId)).stepCount).toBe(1);
    await library.saveStep(guideId, step("s2", "a1"));
    await noteDelete(library, guideId, "s2", "Robin Hale", "robin");
    // Undo in the same session isn't someone bringing it back.
    await forgetOwnDelete(library, guideId, "s2", "sam");
    expect(await listConflicts(library, guideId)).toHaveLength(1);
    await forgetOwnDelete(library, guideId, "s2", "robin");
    expect(await listConflicts(library, guideId)).toEqual([]);
  });

  it("keeps a displaced editor's work as a draft, to open as a copy or discard", async () => {
    const { guide } = await library.loadGuide(guideId);
    await saveDraft(library, guideId, "robin", "Robin Hale", {
      guide: { ...(guide as object), description: "Draft wording" },
      steps: [step("d1", "a0")],
    });
    await saveDraft(library, guideId, "sam", "Sam Jones", { guide: guide as object, steps: [] });
    // Oldest first, then by id (two saved in the same millisecond, or not).
    const drafts = await listDrafts(library, guideId);
    expect(drafts.map((draft) => [draft.id, draft.stepCount]).sort()).toEqual([
      ["robin", 1],
      ["sam", 0],
    ]);
    expect(drafts).toEqual(
      [...drafts].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1)),
    );
    const copy = await draftToCopy(library, guideId, "robin", "Payroll (Robin's changes)");
    expect(copy).toMatchObject({ title: "Payroll (Robin's changes)", stepCount: 1 });
    expect((await library.loadGuide(copy.id)).guide).toMatchObject({
      description: "Draft wording",
    });
    await discardDraft(library, guideId, "sam");
    expect(await listDrafts(library, guideId)).toEqual([]);
  });

  it("keeps comments as files of their own", async () => {
    const robinHere = { name: "Robin Hale", pc: "ROBINS-PC" };
    const samThere = { name: "Sam Jones", pc: "SAMS-PC" };
    const thread = await addComment(library, guideId, "s1", null, " Right field? ", robinHere);
    await addComment(library, guideId, "s1", thread, "Yes", samThere);
    await setCommentResolved(library, guideId, thread, true, samThere);
    await setCommentResolved(library, guideId, thread, true, samThere);
    const [listed] = await listComments(library, guideId, robinHere);
    expect(listed).toMatchObject({
      text: "Right field?",
      stepId: "s1",
      mine: true,
      replies: [{ text: "Yes", mine: false }],
      resolved: { by: "Sam Jones" },
    });
    expect(await names(await walk(root, "guides", guideId, "comments"))).toHaveLength(3);
    await expect(deleteComment(library, guideId, thread, robinHere)).rejects.toMatchObject({
      message: "a comment with replies can't be deleted",
    });
    await expect(
      deleteComment(library, guideId, listed?.replies[0]?.id ?? "", robinHere),
    ).rejects.toMatchObject({
      message: "only the person who wrote a comment can delete it",
    });
    expect((await library.summary(guideId)).openComments).toBe(0);
  });
});

describe("history", () => {
  it("saves versions and restores one, keeping the state before it", async () => {
    const version = await saveVersion(library, guideId, " First ", "Robin Hale");
    expect(version).toMatchObject({ note: "First", stepCount: 2, createdBy: "Robin Hale" });
    expect(await names(await walk(root, "guides", guideId, "versions", version.id))).toEqual([
      "guide.json",
      "steps",
      "version.json",
    ]);
    await library.deleteStep(guideId, "s2");
    await library.saveStep(guideId, step("s3", "a2"));
    const restored = await restoreVersion(library, guideId, version.id, "Sam Jones");
    expect(restored.steps.map((each) => (each as { id: string }).id)).toEqual(["s1", "s2"]);
    expect(restored.guide).toMatchObject({ id: guideId, updatedBy: "Sam Jones" });
    const versions = await listVersions(library, guideId);
    expect(versions[0]?.note).toMatch(/^Before restoring \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
    expect((await loadVersion(library, guideId, versions[0]?.id ?? "")).steps).toHaveLength(2);
    await expect(loadVersion(library, guideId, "nope")).rejects.toMatchObject({
      code: "versionNotFound",
    });
  });

  it("burns blur into copies, points every step at them, then deletes the originals", async () => {
    const media = await library.importImage(guideId, png(100, 100));
    await library.saveStep(
      guideId,
      step("s1", "a0", { media: { id: media.id }, redactions: [{ x: 1, y: 2, w: 3, h: 4 }] }),
    );
    await saveVersion(library, guideId, "", "Robin Hale");
    expect(await applyRedactions(library, guideId)).toBe(1);
    const [s1] = (await library.loadGuide(guideId)).steps as { media: { id: string } }[];
    const copy = s1?.media.id ?? "";
    expect(copy).not.toBe(media.id);
    const [version] = await listVersions(library, guideId);
    expect(
      (
        (await loadVersion(library, guideId, version?.id ?? "")).steps[0] as {
          media: { id: string };
        }
      ).media.id,
    ).toBe(copy);
    expect(await names(await walk(root, "guides", guideId, "media"))).toEqual([`${copy}.webp`]);
    const record = await readJson((await walk(root, "guides", guideId)) as Dir, "blur.json");
    expect(record).toEqual({ pending: {}, burned: { [copy]: [{ x: 1, y: 2, w: 3, h: 4 }] } });
    // Already burned in: nothing to do again.
    expect(await applyRedactions(library, guideId)).toBe(0);
  });
});
