import { describe, expect, it } from "vitest";

import {
  LOSSLESS,
  MAX_EDGE,
  WEBP_QUALITY,
  isLosslessWebp,
  prepareImage,
  type ImageCodec,
} from "./images";

/** A WebP file's header, then chunks of the given ids, each with a few bytes. */
function webp(...chunks: string[]): Uint8Array {
  const parts: number[] = [..."RIFF"].map((ch) => ch.charCodeAt(0));
  parts.push(0, 0, 0, 0, ...[..."WEBP"].map((ch) => ch.charCodeAt(0)));
  for (const id of chunks)
    parts.push(...[...id].map((ch) => ch.charCodeAt(0)), 3, 0, 0, 0, 1, 2, 3, 0);
  return new Uint8Array(parts);
}

/** A 5120×2880 PNG header: all the fake codec reads. Rendering records what it was asked. */
const renders: { width: number; height: number; quality: number }[] = [];
const codec: ImageCodec = {
  measure: () => Promise.resolve({ width: 5120, height: 2880 }),
  render: (_blob, width, height, quality) => {
    renders.push({ width, height, quality });
    return Promise.resolve(new Blob(["webp"]));
  },
  pixels: () => Promise.reject(new Error("not used")),
  encode: () => Promise.reject(new Error("not used")),
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("screenshot quality", () => {
  it("keeps Balanced within 2560 pixels, and Original lossless at full size", async () => {
    renders.length = 0;
    expect(await prepareImage(codec, png)).toMatchObject({ width: MAX_EDGE, height: 1440 });
    expect(await prepareImage(codec, png, "original")).toMatchObject({ width: 5120, height: 2880 });
    expect(renders).toEqual([
      { width: MAX_EDGE, height: 1440, quality: WEBP_QUALITY },
      { width: 5120, height: 2880, quality: LOSSLESS },
    ]);
  });

  it("tells lossless WebP from lossy by its chunks, as Chrome writes them", () => {
    expect(isLosslessWebp(webp("VP8L"))).toBe(true);
    expect(isLosslessWebp(webp("VP8X", "ICCP", "VP8L"))).toBe(true);
    expect(isLosslessWebp(webp("VP8X", "ICCP", "VP8 "))).toBe(false);
    expect(isLosslessWebp(webp("VP8 "))).toBe(false);
    expect(isLosslessWebp(webp("VP8X").slice(0, 14))).toBe(false);
  });
});
