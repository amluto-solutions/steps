import { errors } from "./ids";

/**
 * Screenshots and pictures, handled as the desktop does (`library/src/media.rs`): PNG, JPEG or
 * WebP in, up to 50 MB and 100 megapixels, fitted within 2560 pixels and kept as WebP; thumbnails
 * within 480. The drawing itself is behind `ImageCodec`, so the rules are tested without a canvas.
 */

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_PIXELS = 100_000_000;
export const MAX_EDGE = 2560;
export const THUMBNAIL_EDGE = 480;
export const WEBP_QUALITY = 0.9;
/** Chrome writes lossless WebP (`VP8L`) at quality 1: "Original" screenshots. */
export const LOSSLESS = 1;

/**
 * Whether WebP bytes are lossless, as an Original screenshot is: a `VP8L` image, on its own or
 * after the `VP8X` and `ICCP` chunks Chrome writes first. Only chunk headers are read.
 */
export function isLosslessWebp(bytes: Uint8Array): boolean {
  let at = 12;
  for (let chunk = 0; chunk < 8 && at + 8 <= bytes.length; chunk += 1) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    if (id === "VP8L") return true;
    if (id === "VP8 " || id === "ANMF") return false;
    const size = new DataView(bytes.buffer, bytes.byteOffset + at + 4, 4).getUint32(0, true);
    at += 8 + size + (size % 2);
  }
  return false;
}
export const THUMBNAIL_QUALITY = 0.8;

export type ImageFormat = "png" | "jpeg" | "webp";

/** The format from the file's first bytes; its name or type is never trusted. */
export function sniff(bytes: Uint8Array): ImageFormat | null {
  const starts = (...expected: number[]) => expected.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  const ascii = (from: number) => String.fromCharCode(...bytes.slice(from, from + 4));
  if (ascii(0) === "RIFF" && ascii(8) === "WEBP") return "webp";
  return null;
}

/** A size fitted within `edge` on its longest side, rounded half up; never smaller than 1. */
export function fit(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const side = (value: number) =>
    Math.max(Math.floor((value * edge + Math.floor(longest / 2)) / longest), 1);
  return { width: side(width), height: side(height) };
}

/** RGBA pixels. */
export interface RawImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** What drawing the library needs; `canvasCodec` in the browser, a fake in tests. */
export interface ImageCodec {
  /** The picture's size, without keeping its pixels. */
  measure(blob: Blob): Promise<{ width: number; height: number }>;
  /** The picture drawn at `width` × `height` and encoded as WebP. */
  render(blob: Blob, width: number, height: number, quality: number): Promise<Blob>;
  pixels(blob: Blob): Promise<RawImage>;
  encode(image: RawImage, quality: number): Promise<Blob>;
}

/**
 * A picture checked and kept as the library keeps them: WebP, within 2560 pixels. A screenshot
 * at "Original" quality is kept lossless at its own size instead.
 */
export async function prepareImage(
  codec: ImageCodec,
  bytes: Uint8Array,
  quality: "balanced" | "original" = "balanced",
): Promise<{ blob: Blob; width: number; height: number }> {
  if (bytes.length > MAX_IMPORT_BYTES) throw errors.unsupportedImage("it is larger than 50 MB");
  const format = sniff(bytes);
  if (!format) throw errors.unsupportedImage("only PNG, JPEG and WebP images can be used");
  const source = new Blob([bytes.slice()], { type: `image/${format}` });
  let size: { width: number; height: number };
  try {
    size = await codec.measure(source);
  } catch (problem) {
    throw errors.unsupportedImage(`the image is damaged (${String(problem)})`);
  }
  if (size.width === 0 || size.height === 0) throw errors.unsupportedImage("the image is empty");
  if (size.width * size.height > MAX_PIXELS)
    throw errors.unsupportedImage("it is larger than 100 megapixels");
  if (quality === "original") {
    const blob = await codec.render(source, size.width, size.height, LOSSLESS);
    return { blob, ...size };
  }
  const fitted = fit(size.width, size.height, MAX_EDGE);
  const blob = await codec.render(source, fitted.width, fitted.height, WEBP_QUALITY);
  return { blob, ...fitted };
}

/** A data URL, as the UI expects (it reads the base64 back for text recognition). */
export async function dataUrl(blob: Blob, type = "image/webp"): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return `data:${type};base64,${btoa(binary)}`;
}

/** The browser's own drawing: `createImageBitmap` and an `OffscreenCanvas`. */
export const canvasCodec: ImageCodec = {
  async measure(blob) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  },
  async render(blob, width, height, quality) {
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: "none",
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "high",
    });
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2D canvas");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.convertToBlob({ type: "image/webp", quality });
  },
  async pixels(blob) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2D canvas");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return { data: image.data, width: image.width, height: image.height };
  },
  async encode(image, quality) {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2D canvas");
    context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    return canvas.convertToBlob({ type: "image/webp", quality });
  },
};
