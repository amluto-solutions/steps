import { describe, expect, it } from "vitest";
import { hashPassword, parseGuideHistory } from "@amluto-steps/core";

import type { LibraryBridge, TrashEntry } from "../library-bridge";
import { GuideLockedError, withGuideLocks } from "./guide-locks";

/** Just enough of a library: one guide's lock, history, saves and the Bin. */
function fakeLibrary() {
  const files = new Map<string, { lock: unknown; history: unknown }>();
  const meta = (guideId: string) => {
    const found = files.get(guideId) ?? { lock: null, history: null };
    files.set(guideId, found);
    return found;
  };
  const saved: string[] = [];
  const library = {
    guideMeta: (_libraryId: string, guideId: string) => Promise.resolve({ ...meta(guideId) }),
    writeGuideLock: (_libraryId: string, guideId: string, lock: unknown) => {
      meta(guideId).lock = lock;
      return Promise.resolve();
    },
    writeGuideHistory: (_libraryId: string, guideId: string, history: unknown) => {
      meta(guideId).history = history;
      return Promise.resolve();
    },
    saveGuide: (_libraryId: string, guideId: string) => {
      saved.push(guideId);
      return Promise.resolve();
    },
    saveStep: () => Promise.resolve(),
    openForEditing: () => Promise.resolve({ kind: "editing" as const }),
    releaseLock: () => Promise.resolve(),
    trashGuide: (_libraryId: string, guideId: string) => {
      // As every storage does: the Bin takes the lock off.
      meta(guideId).lock = null;
      return Promise.resolve({ trashId: "t", guideId, title: "", deletedAt: "" } as TrashEntry);
    },
    moveGuide: () => Promise.resolve({}),
    duplicateGuide: () => Promise.resolve({ id: "copy" }),
  } as unknown as LibraryBridge;
  return { library, files, saved };
}

const setUp = (recovery: string | null = null) => {
  const fake = fakeLibrary();
  const locks = withGuideLocks(fake.library, {
    who: () => Promise.resolve({ by: "Robin Hale", login: "robin", pc: "PC-1" }),
    recoveryPassword: () => recovery,
    now: () => new Date("2026-10-04T10:00:00Z"),
    iterations: 1_000,
  });
  return { ...fake, locks };
};

describe("guide password locks (04/10/2026)", () => {
  it("refuses changes, moves and the Bin until the password is given, never copies", async () => {
    const { locks, saved } = setUp();
    await locks.lock("lib", "g1", "secret1");
    const lock = await locks.lockOf("lib", "g1");
    expect(lock?.locked).toEqual({
      by: "Robin Hale",
      login: "robin",
      pc: "PC-1",
      at: "2026-10-04T10:00:00.000Z",
    });
    expect(JSON.stringify(lock)).not.toContain("secret1");

    await expect(locks.library.saveGuide("lib", "g1", {})).rejects.toBeInstanceOf(GuideLockedError);
    await expect(locks.library.saveGuide("lib", "g1", {})).rejects.toThrow("Robin Hale");
    await expect(locks.library.moveGuide("lib", "g1", "other")).rejects.toBeInstanceOf(
      GuideLockedError,
    );
    await expect(locks.library.trashGuide("lib", "g1")).rejects.toBeInstanceOf(GuideLockedError);
    await expect(locks.library.writeGuideLock("lib", "g1", null)).rejects.toThrow();
    // Duplicate, view and the rest go straight through.
    await expect(locks.library.duplicateGuide("lib", "g1", "Copy")).resolves.toEqual({
      id: "copy",
    });
    expect(saved).toEqual([]);

    expect(await locks.unlock("lib", "g1", "wrong!")).toEqual({ kind: "wrong" });
    expect(await locks.unlock("lib", "g1", "secret1")).toEqual({
      kind: "unlocked",
      recovery: false,
    });
    await locks.library.saveGuide("lib", "g1", {});
    expect(saved).toEqual(["g1"]);
    // The unlock is for this session only.
    locks.relock("lib", "g1");
    await expect(locks.library.saveGuide("lib", "g1", {})).rejects.toBeInstanceOf(GuideLockedError);
  });

  it("takes the lock off in the Bin, and records it", async () => {
    const { locks, files } = setUp();
    await locks.lock("lib", "g1", "secret1");
    await locks.unlock("lib", "g1", "secret1");
    await locks.library.trashGuide("lib", "g1");
    expect(files.get("g1")?.lock).toBeNull();
    expect(parseGuideHistory(files.get("g1")?.history).events.map((e) => e.kind)).toEqual([
      "locked",
      "binned",
    ]);
  });

  it("counts an editing session that changed the guide as one save", async () => {
    const { locks, files } = setUp();
    await locks.library.openForEditing("lib", "g1", false);
    await locks.library.saveGuide("lib", "g1", {});
    await locks.library.saveStep("lib", "g1", {});
    await locks.library.releaseLock("lib", "g1");
    // A rename from the library is a save of its own.
    await locks.library.saveGuide("lib", "g1", {});
    const history = parseGuideHistory(files.get("g1")?.history);
    expect(history.saves).toBe(2);
    expect(history.lastSaved?.pc).toBe("PC-1");
  });

  it("removes the lock or changes the password only once unlocked, keeping who locked it", async () => {
    const { locks, files } = setUp();
    await locks.lock("lib", "g1", "secret1");
    await expect(locks.removeLock("lib", "g1")).rejects.toBeInstanceOf(GuideLockedError);
    await locks.unlock("lib", "g1", "secret1");
    await locks.changePassword("lib", "g1", "secret2");
    expect(await locks.unlock("lib", "g1", "secret1")).toEqual({ kind: "wrong" });
    expect(await locks.unlock("lib", "g1", "secret2")).toMatchObject({ kind: "unlocked" });
    expect((await locks.lockOf("lib", "g1"))?.locked.by).toBe("Robin Hale");
    await locks.removeLock("lib", "g1");
    expect(files.get("g1")?.lock).toBeNull();
    expect(parseGuideHistory(files.get("g1")?.history).events.map((e) => e.kind)).toEqual([
      "locked",
      "passwordChanged",
      "lockRemoved",
    ]);
  });

  it("opens any guide with IT's recovery password, and says so in its history", async () => {
    const { locks, files } = setUp(await hashPassword("it-recovery", 1_000));
    await locks.lock("lib", "g1", "forgotten");
    expect(await locks.unlock("lib", "g1", "it-recovery")).toEqual({
      kind: "unlocked",
      recovery: true,
    });
    expect(parseGuideHistory(files.get("g1")?.history).events.at(-1)?.kind).toBe(
      "unlockedWithRecovery",
    );
  });

  it("makes the eleventh wrong try wait", async () => {
    const { locks } = setUp();
    await locks.lock("lib", "g1", "secret1");
    for (let index = 0; index < 10; index += 1)
      expect(await locks.unlock("lib", "g1", "nope")).toEqual({ kind: "wrong" });
    expect(await locks.unlock("lib", "g1", "secret1")).toMatchObject({ kind: "wait" });
  });
});
