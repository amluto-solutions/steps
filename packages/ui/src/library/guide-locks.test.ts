import { describe, expect, it, vi } from "vitest";
import { hashPassword, parseGuideHistory } from "@amluto-steps/core";

import { fakeLibrary } from "../library-fake";
import type { LibraryBridge } from "../library-bridge";
import {
  CHANGES_GUIDE,
  GuideLockedError,
  withGuideLocks,
  type LibraryMethod,
  type ListAttempt,
  type LockedListPrompt,
  type LockTarget,
  type PasswordPrompt,
  type UnlockResult,
} from "./guide-locks";

const METHODS = Object.keys(CHANGES_GUIDE) as LibraryMethod[];

/** A guide as a library holds it: just enough of one to save and bin. */
const document = (id: string) => ({ guide: { id, title: id }, steps: [] });

/**
 * The library fake with three guides in "lib" and an empty "other", every method spied on, so a
 * test can tell which calls reached it.
 */
function spiedLibrary() {
  const fake = fakeLibrary({
    libraries: [
      { id: "lib", name: "Guides", guides: ["g1", "g2", "g3"].map(document) },
      { id: "other", name: "Other" },
    ],
  });
  const spies = new Map(
    METHODS.filter((name) => fake[name] !== undefined).map((name) => [
      name,
      vi.spyOn(fake as Required<LibraryBridge>, name),
    ]),
  );
  const reached = (name: LibraryMethod) => spies.get(name)?.mock.calls.length ?? 0;
  /** The guides saved, in order. */
  const saved = () => (spies.get("saveGuide")?.mock.calls ?? []).map((call) => call[1]);
  const stored = (guideId: string) => fake.data.libraries.get("lib")?.guides.get(guideId);
  return { library: fake, spies, reached, saved, stored };
}

/**
 * Stands in for the password dialog: types each password in turn until one opens the guide, and
 * cancels when they run out. Notes which guides it was shown for and what each try answered.
 */
function typing(...passwords: string[]) {
  const shown: LockTarget[] = [];
  const answers: UnlockResult["kind"][] = [];
  const prompt: PasswordPrompt = async (target, _action, attempt) => {
    shown.push(target);
    for (const password of passwords) {
      const result = await attempt(password);
      answers.push(result.kind);
      if (result.kind === "unlocked") return true;
    }
    return false;
  };
  return { prompt, shown, answers };
}

/** Stands in for the list of locked guides a bulk action left: each try is a guide and a password. */
function typingInList(...tries: [guideId: string, password: string][]) {
  const answers: ListAttempt[] = [];
  const list: LockedListPrompt = async (targets, _body, attempt) => {
    for (const [guideId, password] of tries) {
      const target = targets.find((item) => item.guideId === guideId);
      if (!target) throw new Error(`${guideId} isn't listed`);
      answers.push(await attempt(target, password));
    }
  };
  return { list, answers };
}

const setUp = (
  options: { recovery?: string; prompt?: PasswordPrompt; list?: LockedListPrompt } = {},
) => {
  const fake = spiedLibrary();
  const locks = withGuideLocks(fake.library, {
    who: () => Promise.resolve({ by: "Robin Hale", login: "robin", pc: "PC-1" }),
    recoveryPassword: () => options.recovery ?? null,
    now: () => new Date("2026-10-04T10:00:00Z"),
    iterations: 1_000,
    prompts: {
      password: options.prompt ?? typing().prompt,
      list: options.list ?? typingInList().list,
    },
  });
  return { ...fake, locks };
};

const guide = { libraryId: "lib", guideId: "g1", title: "Payroll" };
const g1 = { libraryId: "lib", guideId: "g1" };

describe("guide password locks (04/10/2026)", () => {
  it("refuses every guide-changing library method while the guide is locked", async () => {
    const { locks, reached } = setUp();
    await locks.lock(g1, "secret1");
    const changing = METHODS.filter((name) => CHANGES_GUIDE[name]);
    for (const name of changing) {
      const method = locks.library[name] as ((...args: unknown[]) => Promise<unknown>) | undefined;
      // Export and remove is Steps for Chrome's only, and the fake hasn't got it.
      if (!method) continue;
      const before = reached(name);
      await expect(method("lib", "g1", "x", "y"), name).rejects.toThrow();
      // Refused before the library was asked to change anything.
      expect(reached(name), name).toBe(before);
    }
  });

  it("refuses new pictures and retakes on a locked guide, and allows drafts", async () => {
    const { locks, reached } = setUp();
    await locks.lock(g1, "secret1");
    await expect(
      locks.library.importImage("lib", "g1", new Uint8Array([1])),
    ).rejects.toBeInstanceOf(GuideLockedError);
    await expect(locks.library.retakeImage("lib", "g1", 0, [])).rejects.toBeInstanceOf(
      GuideLockedError,
    );
    await locks.library.saveDraft("lib", "g1", { guide: {}, steps: [] });
    const [draft] = await locks.library.listDrafts("lib", "g1");
    await locks.library.draftToCopy("lib", "g1", draft?.id ?? "", "Copy");
    await locks.library.discardDraft("lib", "g1", draft?.id ?? "");
    expect(reached("importImage")).toBe(0);
    expect(reached("retakeImage")).toBe(0);
    for (const name of ["saveDraft", "listDrafts", "discardDraft", "draftToCopy"] as const)
      expect(reached(name), name).toBe(1);
  });

  it("runs an action on a guide that isn't locked without asking", async () => {
    const asked = typing("secret1");
    const { locks, saved } = setUp({ prompt: asked.prompt });
    const ran = await locks.runOnGuide(guide, "Rename", () =>
      locks.library.saveGuide("lib", "g1", { id: "g1" }),
    );
    expect(ran).toBe(true);
    expect(saved()).toEqual(["g1"]);
    expect(asked.shown).toEqual([]);
  });

  it("asks for a locked guide's password, runs the action, then locks it again", async () => {
    const asked = typing("wrong!", "secret1");
    const { locks, saved } = setUp({ prompt: asked.prompt });
    await locks.lock(g1, "secret1");
    const ran = await locks.runOnGuide(guide, "Rename", () =>
      locks.library.saveGuide("lib", "g1", { id: "g1" }),
    );
    expect(ran).toBe(true);
    expect(asked.shown).toEqual([
      { ...guide, locked: { by: "Robin Hale", at: "2026-10-04T10:00:00.000Z" } },
    ]);
    expect(asked.answers).toEqual(["wrong", "unlocked"]);
    expect(saved()).toEqual(["g1"]);
    // Opened for that one action only.
    await expect(locks.library.saveGuide("lib", "g1", { id: "g1" })).rejects.toBeInstanceOf(
      GuideLockedError,
    );
  });

  it("leaves a locked guide alone when the password prompt is cancelled", async () => {
    const asked = typing("wrong!");
    const { locks, saved } = setUp({ prompt: asked.prompt });
    await locks.lock(g1, "secret1");
    let ran = false;
    expect(
      await locks.runOnGuide(guide, "Move", () => {
        ran = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(ran).toBe(false);
    expect(saved()).toEqual([]);
  });

  it("unlocks a guide to edit until its editing session ends", async () => {
    const asked = typing("secret1");
    const { locks, saved } = setUp({ prompt: asked.prompt });
    await locks.lock(g1, "secret1");
    expect(await locks.unlockToEdit(guide, "Unlock")).toBe(true);
    await locks.library.openForEditing("lib", "g1", false);
    await locks.library.saveGuide("lib", "g1", { id: "g1" });
    await locks.library.saveStep("lib", "g1", { id: "s1" });
    expect(saved()).toEqual(["g1"]);
    await locks.library.releaseLock("lib", "g1");
    await expect(locks.library.saveGuide("lib", "g1", { id: "g1" })).rejects.toBeInstanceOf(
      GuideLockedError,
    );
  });

  it("tries the password that opened one guide of a bulk action on the others", async () => {
    const asked = typingInList(["g1", "wrong!"], ["g1", "secret1"]);
    const { locks, saved } = setUp({ list: asked.list });
    await locks.lock(g1, "secret1");
    await locks.lock({ libraryId: "lib", guideId: "g2" }, "secret1");
    await locks.lock({ libraryId: "lib", guideId: "g3" }, "another");
    const locked = { by: "Robin Hale", at: "2026-10-04T10:00:00.000Z" };
    const targets = ["g1", "g2", "g3"].map((guideId) => ({
      libraryId: "lib",
      guideId,
      title: guideId,
      locked,
    }));
    await locks.runOnLocked(targets, "Move these", (target) =>
      locks.library.saveGuide(target.libraryId, target.guideId, { id: target.guideId }),
    );
    expect(asked.answers).toEqual([
      { kind: "wrong" },
      { kind: "done", done: [targets[0], targets[1]], failed: [], left: [targets[2]] },
    ]);
    expect(saved()).toEqual(["g1", "g2"]);
    // Each is locked again once done.
    await expect(locks.library.saveGuide("lib", "g2", { id: "g2" })).rejects.toBeInstanceOf(
      GuideLockedError,
    );
  });

  it("refuses changes, moves and the Bin until the password is given, never copies", async () => {
    const { locks, saved } = setUp();
    await locks.lock(g1, "secret1");
    const lock = await locks.lockOf(g1);
    expect(lock?.locked).toEqual({
      by: "Robin Hale",
      login: "robin",
      pc: "PC-1",
      at: "2026-10-04T10:00:00.000Z",
    });
    expect(JSON.stringify(lock)).not.toContain("secret1");

    const save = () => locks.library.saveGuide("lib", "g1", { id: "g1" });
    await expect(save()).rejects.toBeInstanceOf(GuideLockedError);
    await expect(save()).rejects.toThrow("Robin Hale");
    await expect(locks.library.moveGuide("lib", "g1", "other")).rejects.toBeInstanceOf(
      GuideLockedError,
    );
    await expect(locks.library.trashGuide("lib", "g1")).rejects.toBeInstanceOf(GuideLockedError);
    await expect(locks.library.writeGuideLock("lib", "g1", null)).rejects.toThrow();
    // Duplicate, view and the rest go straight through.
    const copy = await locks.library.duplicateGuide("lib", "g1", "Copy");
    expect(copy.id).not.toBe("g1");
    expect(saved()).toEqual([]);

    expect(await locks.unlock(g1, "wrong!")).toEqual({ kind: "wrong" });
    expect(await locks.unlock(g1, "secret1")).toEqual({ kind: "unlocked", recovery: false });
    await save();
    expect(saved()).toEqual(["g1"]);
    // The unlock is for this session only.
    locks.relock(g1);
    await expect(save()).rejects.toBeInstanceOf(GuideLockedError);
  });

  it("takes the lock off in the Bin, and records it in the history that goes with the guide", async () => {
    const { locks, library } = setUp();
    await locks.lock(g1, "secret1");
    await locks.unlock(g1, "secret1");
    const entry = await locks.library.trashGuide("lib", "g1");
    await library.restoreGuide("lib", entry.trashId);
    const meta = await library.guideMeta("lib", "g1");
    expect(meta.lock).toBeNull();
    expect(parseGuideHistory(meta.history).events.map((e) => e.kind)).toEqual(["locked", "binned"]);
  });

  it("counts an editing session that changed the guide as one save", async () => {
    const { locks, stored } = setUp();
    await locks.library.openForEditing("lib", "g1", false);
    await locks.library.saveGuide("lib", "g1", { id: "g1" });
    await locks.library.saveStep("lib", "g1", { id: "s1" });
    await locks.library.releaseLock("lib", "g1");
    // A rename from the library is a save of its own.
    await locks.library.saveGuide("lib", "g1", { id: "g1" });
    const history = parseGuideHistory(stored("g1")?.history);
    expect(history.saves).toBe(2);
    expect(history.lastSaved?.pc).toBe("PC-1");
  });

  it("removes the lock or changes the password only once unlocked, keeping who locked it", async () => {
    const { locks, stored } = setUp();
    await locks.lock(g1, "secret1");
    await expect(locks.removeLock(g1)).rejects.toBeInstanceOf(GuideLockedError);
    await locks.unlock(g1, "secret1");
    await locks.changePassword(g1, "secret2");
    expect(await locks.unlock(g1, "secret1")).toEqual({ kind: "wrong" });
    expect(await locks.unlock(g1, "secret2")).toMatchObject({ kind: "unlocked" });
    expect((await locks.lockOf(g1))?.locked.by).toBe("Robin Hale");
    await locks.removeLock(g1);
    expect(stored("g1")?.lock).toBeNull();
    expect(parseGuideHistory(stored("g1")?.history).events.map((e) => e.kind)).toEqual([
      "locked",
      "passwordChanged",
      "lockRemoved",
    ]);
  });

  it("opens any guide with IT's recovery password, and says so in its history", async () => {
    const { locks, stored } = setUp({ recovery: await hashPassword("it-recovery", 1_000) });
    await locks.lock(g1, "forgotten");
    expect(await locks.unlock(g1, "it-recovery")).toEqual({ kind: "unlocked", recovery: true });
    expect(parseGuideHistory(stored("g1")?.history).events.at(-1)?.kind).toBe(
      "unlockedWithRecovery",
    );
  });

  it("makes the eleventh wrong try wait", async () => {
    const { locks } = setUp();
    await locks.lock(g1, "secret1");
    for (let index = 0; index < 10; index += 1)
      expect(await locks.unlock(g1, "nope")).toEqual({ kind: "wrong" });
    expect(await locks.unlock(g1, "secret1")).toMatchObject({ kind: "wait" });
  });
});
