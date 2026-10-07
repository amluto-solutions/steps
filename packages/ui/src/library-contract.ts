import { describe, expect, it } from "vitest";

import { errorCode } from "./errors";
import type { LibraryBridge, RawGuideDocument } from "./library-bridge";

/**
 * The library bridge's contract (07/10/2026): what every edition's library does, law by law, one
 * `describe` per small interface. Each adapter's tests run it (the UI package's fake, Steps for
 * Chrome's library in the browser and its shared folders, and the preview's), so they can't drift
 * apart. The desktop's library is Rust, tested by its own crate; its TypeScript adapter is checked
 * against the Rust commands it calls (`apps/desktop/src/library-bridge.test.ts`).
 */

export interface LibraryUnderTest {
  library: LibraryBridge;
  /** An empty library to work in. */
  libraryId: string;
  /** A second library, for copies and moves; absent where there's only one. */
  otherLibraryId?: string;
  /** The name Settings gives, on comments and versions; "Robin" when left out. */
  me?: string;
}

/** A plain recorded click, as saved in a version-1 guide. */
export const contractStep = (id: string, sortKey: string, actionText = `Click ${id}`) => ({
  id,
  sortKey,
  kind: "interaction",
  action: "click",
  actionText,
  textParts: { verb: "click", target: id, kind: "button" },
  showValue: false,
  textEdited: false,
  notes: null,
  altText: null,
  context: { app: "example.exe", windowTitle: "Example" },
  target: null,
  media: null,
  highlight: null,
  crop: null,
  redactions: [],
  annotations: [],
  block: null,
  capturedAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
});

const idOf = (document: RawGuideDocument) => String((document.guide as { id?: unknown }).id);
const titleOf = (document: RawGuideDocument) =>
  String((document.guide as { title?: unknown }).title);
const stepIds = (document: RawGuideDocument) =>
  document.steps.map((step) => (step as { id: string }).id);

export function libraryContract(name: string, setUp: () => Promise<LibraryUnderTest>): void {
  describe(`${name}: guide files`, () => {
    it("lists a new guide and opens it with its title and no steps", async () => {
      const { library, libraryId } = await setUp();
      const created = await library.createGuide(libraryId, "Add a supplier");
      const id = idOf(created);
      expect(titleOf(created)).toBe("Add a supplier");
      expect(created.steps).toEqual([]);
      const listed = (await library.listGuides(libraryId)).find((guide) => guide.id === id);
      expect(listed).toMatchObject({ title: "Add a supplier", stepCount: 0 });
      const opened = await library.loadGuide(libraryId, id);
      expect(titleOf(opened)).toBe("Add a supplier");
      expect(opened.steps).toEqual([]);
    });

    it("keeps saved steps in their order, counts them, and deletes one", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Steps"));
      await library.saveStep(libraryId, id, contractStep("s2", "a2"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      await library.saveStep(libraryId, id, contractStep("s3", "a3"));
      expect(stepIds(await library.loadGuide(libraryId, id))).toEqual(["s1", "s2", "s3"]);
      expect(
        (await library.listGuides(libraryId)).find((guide) => guide.id === id)?.stepCount,
      ).toBe(3);
      // Saving a step again replaces it.
      await library.saveStep(libraryId, id, contractStep("s2", "a2", "Click again"));
      const again = await library.loadGuide(libraryId, id);
      expect(again.steps).toHaveLength(3);
      expect(again.steps[1]).toMatchObject({ id: "s2", actionText: "Click again" });
      await library.deleteStep(libraryId, id, "s2");
      expect(stepIds(await library.loadGuide(libraryId, id))).toEqual(["s1", "s3"]);
    });

    it("saves the guide's details", async () => {
      const { library, libraryId } = await setUp();
      const created = await library.createGuide(libraryId, "Before");
      const id = idOf(created);
      await library.saveGuide(libraryId, id, { ...(created.guide as object), title: "After" });
      expect(titleOf(await library.loadGuide(libraryId, id))).toBe("After");
      expect((await library.listGuides(libraryId)).find((guide) => guide.id === id)?.title).toBe(
        "After",
      );
    });

    it("refuses a guide that isn't there", async () => {
      const { library, libraryId } = await setUp();
      const refused = await library.loadGuide(libraryId, "no-such-guide").catch(errorCode);
      expect(refused).toBe("guideNotFound");
    });

    it("keeps an imported picture, and gives it and its thumbnail back", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Pictures"));
      const media = await library.importImage(libraryId, id, contractPng(40, 30));
      expect(media).toMatchObject({ width: 40, height: 30 });
      expect(await library.loadImage(libraryId, id, media.id, false)).toMatch(/^data:/);
      expect(await library.loadImage(libraryId, id, media.id, true)).toMatch(/^data:/);
      const refused = await library
        .loadImage(libraryId, id, "no-such-image", false)
        .catch(errorCode);
      expect(refused).toBe("imageNotFound");
    });

    it("finds a guide by a word of its title, and not by a word it hasn't", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Approve an expense claim"));
      await library.createGuide(libraryId, "Book a room");
      const hits = await library.searchGuides(libraryId, "expense");
      expect(hits.map((hit) => hit.guideId)).toEqual([id]);
      expect(await library.searchGuides(libraryId, "holiday")).toEqual([]);
    });
  });

  describe(`${name}: guide lock files`, () => {
    it("has no lock or history for a new guide", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "New"));
      expect(await library.guideMeta(libraryId, id)).toEqual({ lock: null, history: null });
    });

    it("keeps a lock and a history, shows who locked the guide, and takes the lock off", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Locked"));
      await library.writeGuideLock(libraryId, id, contractLock);
      await library.writeGuideHistory(libraryId, id, contractHistory);
      expect(await library.guideMeta(libraryId, id)).toEqual({
        lock: contractLock,
        history: contractHistory,
      });
      const listed = (await library.listGuides(libraryId)).find((guide) => guide.id === id);
      expect(listed?.locked).toEqual({ by: "Robin", at: "2026-10-07T10:00:00.000Z" });
      await library.writeGuideLock(libraryId, id, null);
      expect((await library.guideMeta(libraryId, id)).lock).toBeNull();
      const unlocked = (await library.listGuides(libraryId)).find((guide) => guide.id === id);
      expect(unlocked?.locked).toBeUndefined();
    });
  });

  describe(`${name}: the Bin`, () => {
    it("takes a guide out of the library into the Bin, and restores it", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Binned"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      const entry = await library.trashGuide(libraryId, id);
      expect(entry).toMatchObject({ guideId: id, title: "Binned" });
      expect((await library.listGuides(libraryId)).map((guide) => guide.id)).not.toContain(id);
      expect((await library.listTrash(libraryId)).map((each) => each.trashId)).toEqual([
        entry.trashId,
      ]);
      const restored = await library.restoreGuide(libraryId, entry.trashId);
      expect(restored).toMatchObject({ id, title: "Binned", stepCount: 1 });
      expect(stepIds(await library.loadGuide(libraryId, id))).toEqual(["s1"]);
      expect(await library.listTrash(libraryId)).toEqual([]);
    });

    it("takes a guide's password lock off", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Locked"));
      await library.writeGuideLock(libraryId, id, contractLock);
      const entry = await library.trashGuide(libraryId, id);
      await library.restoreGuide(libraryId, entry.trashId);
      expect((await library.guideMeta(libraryId, id)).lock).toBeNull();
    });

    it("deletes one guide for good, or all of them", async () => {
      const { library, libraryId } = await setUp();
      const ids = await Promise.all(
        ["One", "Two", "Three"].map(async (title) =>
          idOf(await library.createGuide(libraryId, title)),
        ),
      );
      const entries = [];
      for (const id of ids) entries.push(await library.trashGuide(libraryId, id));
      const [first] = entries;
      if (!first) throw new Error("nothing binned");
      await library.deleteTrashed(libraryId, first.trashId);
      expect(await library.listTrash(libraryId)).toHaveLength(2);
      const refused = await library.restoreGuide(libraryId, first.trashId).catch(errorCode);
      expect(refused).toBe("trashNotFound");
      expect(await library.emptyTrash(libraryId)).toBe(2);
      expect(await library.listTrash(libraryId)).toEqual([]);
    });
  });

  describe(`${name}: comments`, () => {
    it("starts a thread on a step, counts it open, and takes replies", async () => {
      const { library, libraryId, me = "Robin" } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Reviewed"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      const thread = await library.addComment(libraryId, id, "s1", null, "  Is this right?  ");
      const reply = await library.addComment(libraryId, id, null, thread, "Yes.");
      const [listed, ...others] = await library.listComments(libraryId, id);
      expect(others).toEqual([]);
      expect(listed).toMatchObject({
        id: thread,
        stepId: "s1",
        text: "Is this right?",
        by: me,
        mine: true,
        resolved: null,
      });
      expect(listed?.replies.map((each) => [each.id, each.text])).toEqual([[reply, "Yes."]]);
      const card = (await library.listGuides(libraryId)).find((guide) => guide.id === id);
      expect(card?.openComments).toBe(1);
    });

    it("resolves a thread and opens it again", async () => {
      const { library, libraryId, me = "Robin" } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Reviewed"));
      const thread = await library.addComment(libraryId, id, null, null, "On the whole guide");
      await library.resolveComment(libraryId, id, thread, true);
      expect((await library.listComments(libraryId, id))[0]?.resolved).toMatchObject({
        by: me,
      });
      expect(
        (await library.listGuides(libraryId)).find((guide) => guide.id === id)?.openComments,
      ).toBe(0);
      await library.resolveComment(libraryId, id, thread, false);
      expect((await library.listComments(libraryId, id))[0]?.resolved).toBeNull();
    });

    it("deletes the person's own reply, then the thread", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Reviewed"));
      const thread = await library.addComment(libraryId, id, null, null, "First");
      const reply = await library.addComment(libraryId, id, null, thread, "Second");
      await library.deleteComment(libraryId, id, reply);
      expect((await library.listComments(libraryId, id))[0]?.replies).toEqual([]);
      await library.deleteComment(libraryId, id, thread);
      expect(await library.listComments(libraryId, id)).toEqual([]);
    });
  });

  describe(`${name}: versions`, () => {
    it("saves a version with its note, and opens it as it was", async () => {
      const { library, libraryId, me = "Robin" } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Versioned"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      const version = await library.saveVersion(libraryId, id, "First draft");
      expect(version).toMatchObject({ note: "First draft", createdBy: me, stepCount: 1 });
      await library.saveStep(libraryId, id, contractStep("s2", "a2"));
      expect((await library.listVersions(libraryId, id)).map((each) => each.id)).toEqual([
        version.id,
      ]);
      expect(stepIds(await library.loadVersion(libraryId, id, version.id))).toEqual(["s1"]);
      const refused = await library.loadVersion(libraryId, id, "no-such-version").catch(errorCode);
      expect(refused).toBe("versionNotFound");
    });

    it("restores a version's steps", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Versioned"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      const version = await library.saveVersion(libraryId, id, "");
      await library.saveStep(libraryId, id, contractStep("s2", "a2"));
      await library.deleteStep(libraryId, id, "s1");
      expect(stepIds(await library.restoreVersion(libraryId, id, version.id))).toEqual(["s1"]);
      expect(stepIds(await library.loadGuide(libraryId, id))).toEqual(["s1"]);
    });

    it("has nothing to burn in a guide without blurs", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Plain"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      expect(await library.applyRedactions(libraryId, id)).toBe(0);
    });
  });

  describe(`${name}: copies`, () => {
    it("duplicates a guide under a new id and title, with its steps", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Original"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      const copy = await library.duplicateGuide(libraryId, id, "Original (copy)");
      expect(copy.id).not.toBe(id);
      expect(copy).toMatchObject({ title: "Original (copy)", stepCount: 1 });
      expect(stepIds(await library.loadGuide(libraryId, copy.id))).toEqual(["s1"]);
      expect(titleOf(await library.loadGuide(libraryId, id))).toBe("Original");
    });

    it("copies a guide to another library, leaving its lock behind", async () => {
      const { library, libraryId, otherLibraryId } = await setUp();
      if (!otherLibraryId) return;
      const id = idOf(await library.createGuide(libraryId, "Shared out"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      await library.writeGuideLock(libraryId, id, contractLock);
      const copy = await library.copyGuide(libraryId, id, otherLibraryId);
      expect(copy).toMatchObject({ title: "Shared out", stepCount: 1 });
      expect(stepIds(await library.loadGuide(otherLibraryId, copy.id))).toEqual(["s1"]);
      expect((await library.guideMeta(otherLibraryId, copy.id)).lock).toBeNull();
      expect((await library.guideMeta(libraryId, id)).lock).toEqual(contractLock);
    });

    it("moves a guide to another library, with its lock and history", async () => {
      const { library, libraryId, otherLibraryId } = await setUp();
      if (!otherLibraryId) return;
      const id = idOf(await library.createGuide(libraryId, "Moving"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      await library.writeGuideLock(libraryId, id, contractLock);
      await library.writeGuideHistory(libraryId, id, contractHistory);
      const moved = await library.moveGuide(libraryId, id, otherLibraryId);
      expect(moved).toMatchObject({ title: "Moving", stepCount: 1 });
      expect((await library.listGuides(libraryId)).map((guide) => guide.id)).not.toContain(id);
      expect(stepIds(await library.loadGuide(otherLibraryId, moved.id))).toEqual(["s1"]);
      expect(await library.guideMeta(otherLibraryId, moved.id)).toEqual({
        lock: contractLock,
        history: contractHistory,
      });
    });

    it("makes a guide from parts of others, with their pictures under new ids", async () => {
      const { library, libraryId } = await setUp();
      const source = await library.createGuide(libraryId, "Source");
      const sourceId = idOf(source);
      const picture = await library.importImage(libraryId, sourceId, contractPng(40, 30));
      const step = { ...contractStep("m1", "a1"), media: { ...picture, id: "merged-picture" } };
      const made = await library.createFromParts(
        libraryId,
        { ...(source.guide as object), id: "merged-guide", title: "Merged" },
        [step],
        [
          {
            fromLibraryId: libraryId,
            fromGuideId: sourceId,
            mediaId: picture.id,
            newMediaId: "merged-picture",
          },
        ],
      );
      expect(made).toMatchObject({ id: "merged-guide", title: "Merged", stepCount: 1 });
      expect(stepIds(await library.loadGuide(libraryId, "merged-guide"))).toEqual(["m1"]);
      expect(await library.loadImage(libraryId, "merged-guide", "merged-picture", false)).toMatch(
        /^data:/,
      );
    });
  });

  describe(`${name}: shared editing`, () => {
    it("opens a guide nobody else is editing, and lets it go", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Edited"));
      expect(await library.openForEditing(libraryId, id, false)).toEqual({ kind: "editing" });
      await library.releaseLock(libraryId, id);
      expect(await library.openForEditing(libraryId, id, false)).toEqual({ kind: "editing" });
      await library.releaseLock(libraryId, id);
    });

    it("has no conflicts or drafts in a new guide", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Quiet"));
      expect(await library.listConflicts(libraryId, id)).toEqual([]);
      expect(await library.listDrafts(libraryId, id)).toEqual([]);
    });

    it("changes the library's and the guide's fingerprints when the guide changes", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Watched"));
      const before = await library.fingerprint(libraryId);
      const guideBefore = await library.guideFingerprint(libraryId, id);
      expect(await library.fingerprint(libraryId)).toBe(before);
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      expect(await library.fingerprint(libraryId)).not.toBe(before);
      expect(await library.guideFingerprint(libraryId, id)).not.toBe(guideBefore);
    });

    it("answers a way to stop listening for a lost edit lock", async () => {
      const { library } = await setUp();
      const stop = await library.onLockLost(() => undefined);
      expect(() => stop()).not.toThrow();
    });
  });

  describe(`${name}: the list of libraries`, () => {
    it("lists the library with its guides counted, and one default", async () => {
      const { library, libraryId } = await setUp();
      await library.createGuide(libraryId, "One");
      await library.createGuide(libraryId, "Two");
      const libraries = await library.listLibraries();
      expect(libraries.find((each) => each.id === libraryId)?.guideCount).toBe(2);
      expect(libraries.filter((each) => each.isDefault)).toHaveLength(1);
    });

    it("makes another library the default", async () => {
      const { library, otherLibraryId } = await setUp();
      if (!otherLibraryId) return;
      expect(await library.setDefaultLibrary(otherLibraryId)).toMatchObject({
        id: otherLibraryId,
        isDefault: true,
      });
      const defaults = (await library.listLibraries()).filter((each) => each.isDefault);
      expect(defaults.map((each) => each.id)).toEqual([otherLibraryId]);
    });
  });

  describe(`${name}: Steps files`, () => {
    it("saves a guide as a Steps file and opens it again", async () => {
      const { library, libraryId } = await setUp();
      const id = idOf(await library.createGuide(libraryId, "Sent"));
      await library.saveStep(libraryId, id, contractStep("s1", "a1"));
      await library.saveStep(libraryId, id, contractStep("s2", "a2"));
      await library.exportAmlsteps(libraryId, id, "sent.amlsteps", false);
      const opened = await library.importAmlsteps(libraryId, "sent.amlsteps");
      expect(opened).toMatchObject({ title: "Sent", stepCount: 2 });
      expect(stepIds(await library.loadGuide(libraryId, opened.id))).toEqual(["s1", "s2"]);
    });
  });
}

/** A password lock as `withGuideLocks` writes one (the hash is never checked here). */
export const contractLock = {
  formatVersion: 1,
  locked: { by: "Robin", login: "", pc: "", at: "2026-10-07T10:00:00.000Z" },
  password: "pbkdf2-sha256$1000$c2FsdA==$aGFzaA==",
};

export const contractHistory = {
  formatVersion: 1,
  saves: 2,
  created: { by: "Robin", at: "2026-10-07T09:00:00.000Z" },
  lastSaved: { by: "Robin", at: "2026-10-07T10:00:00.000Z" },
  events: [],
};

/** A PNG's signature and size header: enough for every edition to take it as a picture. */
export function contractPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
