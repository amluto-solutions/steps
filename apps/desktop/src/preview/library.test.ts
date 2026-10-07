// @vitest-environment jsdom
import { libraryContract } from "@amluto-steps/ui/library-contract";
import { describe, expect, it } from "vitest";

import { PREVIEW_LIBRARY_ID, PREVIEW_TEAM_ID, previewLibraryFor } from "./library";

// The preview's made-up library keeps the same contract as the editions'; its own library is
// full of sample guides, so the laws run in the empty second one.
libraryContract("the preview", () =>
  Promise.resolve({
    library: previewLibraryFor(new URLSearchParams()),
    libraryId: PREVIEW_TEAM_ID,
    otherLibraryId: PREVIEW_LIBRARY_ID,
    me: "Sam Example",
  }),
);

describe("the preview's library", () => {
  it("shows the sample guides, with a picture for each step", async () => {
    const library = previewLibraryFor(new URLSearchParams());
    const guides = await library.listGuides(PREVIEW_LIBRARY_ID);
    expect(guides.map((guide) => guide.title)).toContain("Add a new supplier");
    const [first] = guides;
    if (!first) throw new Error("no sample guides");
    expect(first.thumbnailMediaId).toBe("shot");
    expect(await library.loadImage(PREVIEW_LIBRARY_ID, first.id, "shot", true)).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
  });

  it("?access: a shared folder waiting for the browser's permission, until allowed", async () => {
    const library = previewLibraryFor(new URLSearchParams("access"));
    const [own] = await library.listLibraries();
    expect(own).toMatchObject({ needsAccess: true, guideCount: 0 });
    await expect(library.listGuides(PREVIEW_LIBRARY_ID)).rejects.toMatchObject({
      code: "folderAccess",
    });
    expect(await library.allowAccess?.(PREVIEW_LIBRARY_ID)).toBe(true);
    expect((await library.listLibraries())[0]?.needsAccess).toBeUndefined();
    expect((await library.listGuides(PREVIEW_LIBRARY_ID)).length).toBeGreaterThan(0);
  });

  it("?storage: each guide's size, the storage used, and Export and remove", async () => {
    const library = previewLibraryFor(new URLSearchParams("storage"));
    const [guide] = await library.listGuides(PREVIEW_LIBRARY_ID);
    expect(guide?.sizeBytes).toBeGreaterThanOrEqual(0);
    expect(await library.storageUse?.(PREVIEW_LIBRARY_ID)).toMatchObject({
      quotaBytes: 60 * 1024 ** 3,
    });
    if (!guide) throw new Error("no sample guides");
    expect(await library.exportAndRemove?.(PREVIEW_LIBRARY_ID, guide.id, "folder")).toBe(
      `${guide.title}.amlsteps`,
    );
    const left = await library.listGuides(PREVIEW_LIBRARY_ID);
    expect(left.map((each) => each.id)).not.toContain(guide.id);
  });

  it("has no storage methods without ?storage", () => {
    const library = previewLibraryFor(new URLSearchParams());
    expect(library.storageUse).toBeUndefined();
    expect(library.exportAndRemove).toBeUndefined();
  });
});
