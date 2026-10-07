import "fake-indexeddb/auto";

import type { OcrLine } from "@amluto-steps/core";
import { describe, expect, it } from "vitest";

import { KEEP_TEXT_MS, openTextStore, textStore } from "./text-store";

let count = 0;
const open = async (clock: { now: number }) => {
  count += 1;
  return textStore(await openTextStore(`text-${count}`), () => clock.now);
};

const lines: OcrLine[] = [
  {
    words: [
      { text: "Email", x: 10, y: 10, w: 5, h: 2 },
      { text: "sam@example.com", x: 16, y: 10, w: 15, h: 2 },
    ],
  },
  { words: [{ text: "Total", x: 10, y: 20, w: 5, h: 2 }] },
];

const image = new Uint8Array([1, 2, 3, 4]);

describe("the words each screenshot showed", () => {
  it("are found by the screenshot's bytes, wherever they're kept", async () => {
    const store = await open({ now: 0 });
    await store.keep(new Blob([image]), lines);
    expect(await store.read(image.slice())).toEqual(lines);
  });

  it("are unavailable for a screenshot this browser kept none for, not none", async () => {
    // A screenshot from elsewhere, or one changed since, was never read: the export review must
    // call it not checked rather than clear (docs/spec/03-data-and-sharing.md#ocr-cache).
    const store = await open({ now: 0 });
    expect(await store.read(new Uint8Array([9, 9]))).toBe("unavailable");
  });

  it("are none for a page that showed no words", async () => {
    const store = await open({ now: 0 });
    await store.keep(new Blob([image]), []);
    expect(await store.read(image)).toEqual([]);
  });

  it("drop text under a blur for good", async () => {
    const store = await open({ now: 0 });
    await store.keep(new Blob([image]), lines);
    const blurred = await store.read(image, [{ x: 15, y: 9, w: 20, h: 4 }]);
    if (blurred === "unavailable") throw new Error("kept words were unavailable");
    expect(blurred.flatMap((line) => line.words.map((word) => word.text))).toEqual([
      "Email",
      "Total",
    ]);
    // Taking the blur off doesn't bring the words back: they were never kept.
    const again = await store.read(image);
    expect(again === "unavailable" ? again : again.flatMap((line) => line.words)).toHaveLength(2);
  });

  it("are deleted after 30 days unused, and on clearing", async () => {
    const clock = { now: 0 };
    const store = await open(clock);
    await store.keep(new Blob([image]), lines);
    await store.keep(new Blob([new Uint8Array([5])]), lines);
    clock.now = KEEP_TEXT_MS - 1;
    await store.read(image); // used: kept another 30 days
    clock.now = KEEP_TEXT_MS + 1;
    await store.prune();
    expect(await store.read(image)).toEqual(lines);
    expect(await store.read(new Uint8Array([5]))).toBe("unavailable");
    await store.clear();
    expect(await store.read(image)).toBe("unavailable");
  });
});
