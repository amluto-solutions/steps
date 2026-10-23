import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeLibrary } from "../library-fake";
import { moveGuide } from "./move";

afterEach(() => {
  vi.restoreAllMocks();
});

/** "Payroll" in "lib", and an empty "other". */
const twoLibraries = () =>
  fakeLibrary({
    libraries: [
      { id: "lib", name: "Guides", guides: [{ guide: { id: "g1", title: "Payroll" }, steps: [] }] },
      { id: "other", name: "Other" },
    ],
  });

describe("Move to", () => {
  it("leaves no Bin entry behind for the guide that moved (F053)", async () => {
    const library = twoLibraries();
    // The editions move by copying, then putting the original in the Bin.
    vi.spyOn(library, "moveGuide").mockImplementation(async (from, guideId, to) => {
      const copy = await library.copyGuide(from, guideId, to);
      await library.trashGuide(from, guideId);
      return copy;
    });
    const moved = await moveGuide(library, "lib", "g1", "other");
    expect((await library.listGuides("other")).map((guide) => guide.id)).toEqual([moved.id]);
    expect(await library.listTrash("lib")).toEqual([]);
  });

  it("is done once the guide has moved, even if its Bin entry can't be removed (#111)", async () => {
    const library = twoLibraries();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(library, "listTrash").mockResolvedValue([
      { trashId: "t1", guideId: "g1", title: "Payroll", deletedAt: "" },
    ]);
    vi.spyOn(library, "deleteTrashed").mockRejectedValue(new Error("the Bin is held open"));

    const moved = await moveGuide(library, "lib", "g1", "other");
    expect(moved).toMatchObject({ id: "g1", title: "Payroll" });
    expect(library.data.libraries.get("other")?.guides.has("g1")).toBe(true);
    // Said quietly, in the log only.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is done too when the Bin can't be read", async () => {
    const library = twoLibraries();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(library, "listTrash").mockRejectedValue(new Error("the Bin is held open"));
    await expect(moveGuide(library, "lib", "g1", "other")).resolves.toMatchObject({ id: "g1" });
  });

  it("fails when the move itself does, and touches no Bin", async () => {
    const library = twoLibraries();
    vi.spyOn(library, "moveGuide").mockRejectedValue(new Error("the drive has gone"));
    const listTrash = vi.spyOn(library, "listTrash");
    await expect(moveGuide(library, "lib", "g1", "other")).rejects.toThrow("the drive has gone");
    expect(listTrash).not.toHaveBeenCalled();
  });
});
