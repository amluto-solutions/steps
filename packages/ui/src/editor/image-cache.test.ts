import { describe, expect, it, vi } from "vitest";

import { cachedImages } from "./image-cache";

/** A store whose images are named after what was asked for, counting each load. */
function fakeStore() {
  return {
    loadImage: vi.fn((mediaId: string, thumbnail: boolean) =>
      Promise.resolve(`data:${mediaId}:${thumbnail ? "thumbnail" : "full"}`),
    ),
  };
}

describe("the editor's image cache", () => {
  it("loads a screenshot once and serves it from memory after", async () => {
    const store = fakeStore();
    const load = cachedImages(store);
    expect(await load("m1", false)).toBe("data:m1:full");
    expect(await load("m1", false)).toBe("data:m1:full");
    expect(store.loadImage).toHaveBeenCalledTimes(1);
  });

  it("keeps a screenshot and its thumbnail apart", async () => {
    const store = fakeStore();
    const load = cachedImages(store);
    expect(await load("m1", true)).toBe("data:m1:thumbnail");
    expect(await load("m1", false)).toBe("data:m1:full");
    expect(await load("m1", true)).toBe("data:m1:thumbnail");
    expect(store.loadImage).toHaveBeenCalledTimes(2);
  });

  it("keeps the 24 screenshots most recently used", async () => {
    const store = fakeStore();
    const load = cachedImages(store);
    for (let n = 1; n <= 24; n += 1) await load(`m${n}`, false);
    // Using the first again makes the second the oldest, which goes when a 25th comes.
    await load("m1", false);
    await load("m25", false);
    store.loadImage.mockClear();
    await load("m1", false);
    await load("m3", false);
    expect(store.loadImage).not.toHaveBeenCalled();
    await load("m2", false);
    expect(store.loadImage).toHaveBeenCalledWith("m2", false);
  });

  it("keeps 400 thumbnails, counted apart from the screenshots", async () => {
    const store = fakeStore();
    const load = cachedImages(store);
    await load("full", false);
    for (let n = 1; n <= 401; n += 1) await load(`m${n}`, true);
    store.loadImage.mockClear();
    await load("full", false);
    await load("m2", true);
    expect(store.loadImage).not.toHaveBeenCalled();
    await load("m1", true);
    expect(store.loadImage).toHaveBeenCalledWith("m1", true);
  });

  it("doesn't keep a load that failed, so the next ask tries again", async () => {
    const store = fakeStore();
    store.loadImage.mockRejectedValueOnce(new Error("busy"));
    const load = cachedImages(store);
    await expect(load("m1", false)).rejects.toThrow("busy");
    expect(await load("m1", false)).toBe("data:m1:full");
  });
});
