import { describe, expect, it, vi } from "vitest";

import type { Editing } from "../library-bridge";
import { underEditLock } from "./edit-lock";

const sam = { name: "Sam Jones", pc: "SAMS-PC", session: "s", counter: 3, since: "" };
const ref = { libraryId: "lib", guideId: "g1" };

/** A library whose guide is free, or Sam's until it's taken over. */
const libraryWith = (holder: "free" | "sam") => ({
  openForEditing: vi.fn((_library: string, _guide: string, takeOver: boolean): Promise<Editing> =>
    Promise.resolve(
      holder === "free" || takeOver ? { kind: "editing" } : { kind: "readOnly", lock: sam },
    ),
  ),
  releaseLock: vi.fn().mockResolvedValue(undefined),
});

describe("a change from the guide list under the edit lock", () => {
  it("makes the change while it holds the lock, and lets go after", async () => {
    const library = libraryWith("free");
    const change = vi.fn().mockResolvedValue(7);
    expect(await underEditLock(library, ref, null, change)).toEqual({ done: true, value: 7 });
    expect(library.openForEditing).toHaveBeenCalledWith("lib", "g1", false);
    expect(library.releaseLock).toHaveBeenCalledWith("lib", "g1");
  });

  it("leaves a guide someone else is editing alone when it can't take over", async () => {
    const library = libraryWith("sam");
    const change = vi.fn();
    expect(await underEditLock(library, ref, null, change)).toEqual({ done: false, lock: sam });
    expect(change).not.toHaveBeenCalled();
    expect(library.openForEditing).not.toHaveBeenCalledWith("lib", "g1", true);
    expect(library.releaseLock).not.toHaveBeenCalled();
  });

  it("takes over only when the person agrees", async () => {
    const declined = libraryWith("sam");
    const change = vi.fn().mockResolvedValue("renamed");
    const no = vi.fn().mockResolvedValue(false);
    expect(await underEditLock(declined, ref, no, change)).toEqual({ done: false, lock: sam });
    expect(no).toHaveBeenCalledWith(sam);
    expect(change).not.toHaveBeenCalled();

    const agreed = libraryWith("sam");
    const yes = vi.fn().mockResolvedValue(true);
    expect(await underEditLock(agreed, ref, yes, change)).toEqual({
      done: true,
      value: "renamed",
    });
    expect(agreed.openForEditing).toHaveBeenLastCalledWith("lib", "g1", true);
    expect(agreed.releaseLock).toHaveBeenCalledWith("lib", "g1");
  });

  it("lets go of the lock when the change fails, and when there's no guide left to let go of", async () => {
    const library = libraryWith("free");
    await expect(
      underEditLock(library, ref, null, () => Promise.reject(new Error("disk full"))),
    ).rejects.toThrow("disk full");
    expect(library.releaseLock).toHaveBeenCalledTimes(1);

    // Moved or binned: letting go fails, and that doesn't fail the change.
    library.releaseLock.mockRejectedValue({ code: "guideNotFound" });
    expect(await underEditLock(library, ref, null, () => Promise.resolve("moved"))).toEqual({
      done: true,
      value: "moved",
    });
  });
});
