import { MARK_COLOUR_HEX, markColourHex, type GuideStep } from "@amluto-steps/core";

import { overlayOf, pixelateBlock, planImage, type PixelRect } from "./geometry";
import { safeFontName, type BrandLook, type RenderedImage } from "./model";

const decode = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The screenshot could not be read."));
    image.src = src;
  });

/**
 * The last few screenshots decoded. The review draws each one twice in a row (with and without
 * marks for the walkthrough), so the second drawing reuses the first's decode.
 */
const decoded = new Map<string, Promise<HTMLImageElement>>();
const loadImage = (src: string) => {
  const known = decoded.get(src);
  if (known) return known;
  const image = decode(src);
  decoded.set(src, image);
  image.catch(() => decoded.delete(src));
  while (decoded.size > 4) {
    const oldest = decoded.keys().next().value;
    if (oldest === undefined) break;
    decoded.delete(oldest);
  }
  return image;
};

/**
 * The canvas as a data URL, encoded without holding up the page: `toBlob` encodes off the main
 * thread, where `toDataURL` blocks it for each large screenshot.
 */
const encode = (canvas: HTMLCanvasElement, format: string, quality: number) =>
  new Promise<string>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("The screenshot could not be drawn."));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("The screenshot could not be drawn."));
        reader.readAsDataURL(blob);
      },
      format,
      quality,
    );
  });

/**
 * Burns a blurred area into the pixels: pixelate with large blocks, then blur on top, so text
 * underneath can't be recovered from the exported image (docs/spec/05-export.md).
 */
function burnBlur(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, rect: PixelRect) {
  const block = pixelateBlock(rect);
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(rect.w / block));
  small.height = Math.max(1, Math.ceil(rect.h / block));
  const smallContext = small.getContext("2d");
  if (!smallContext) throw new Error("No canvas.");
  smallContext.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, small.width, small.height);
  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.w, rect.h);
  context.clip();
  context.imageSmoothingEnabled = false;
  context.drawImage(small, 0, 0, small.width, small.height, rect.x, rect.y, rect.w, rect.h);
  context.imageSmoothingEnabled = true;
  context.filter = `blur(${Math.max(4, Math.round(block / 2))}px)`;
  context.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
  context.restore();
  context.filter = "none";
}

function drawArrow(
  context: CanvasRenderingContext2D,
  from: [number, number],
  to: [number, number],
  width: number,
) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const head = width * 4;
  context.beginPath();
  context.moveTo(from[0], from[1]);
  context.lineTo(to[0] - Math.cos(angle) * head * 0.6, to[1] - Math.sin(angle) * head * 0.6);
  context.stroke();
  context.beginPath();
  context.moveTo(to[0], to[1]);
  context.lineTo(to[0] - head * Math.cos(angle - 0.45), to[1] - head * Math.sin(angle - 0.45));
  context.lineTo(to[0] - head * Math.cos(angle + 0.45), to[1] - head * Math.sin(angle + 0.45));
  context.closePath();
  context.fill();
}

function drawLabel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  size: number,
  accent: string,
  ink: string,
  font: string,
  /** A white label is drawn dark with white text, or it wouldn't show against its own fill. */
  inverted = false,
) {
  context.font = `600 ${size}px "${font}", "Segoe UI", sans-serif`;
  const padding = size * 0.5;
  const width = context.measureText(text).width + padding * 2;
  const height = size * 1.6;
  context.fillStyle = inverted ? MARK_COLOUR_HEX.black : "#FFFFFF";
  context.strokeStyle = accent;
  context.lineWidth = Math.max(2, size / 7);
  context.beginPath();
  context.roundRect(x, y, width, height, size * 0.35);
  context.fill();
  context.stroke();
  context.fillStyle = inverted ? "#FFFFFF" : ink;
  context.textBaseline = "middle";
  context.fillText(text, x + padding, y + height / 2);
}

/**
 * One screenshot as exports show it, drawn at its own resolution (never upscaled): crop, then
 * blur burned in, then the highlight, arrows, boxes and labels on top.
 */
export async function renderStepImage(
  step: GuideStep,
  src: string,
  brand: BrandLook,
  format: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
  /** False leaves the highlight, arrows, boxes and labels out, for the walkthrough to animate. */
  marks = true,
): Promise<RenderedImage> {
  const image = await loadImage(src);
  const plan = planImage(step, image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas.");
  context.drawImage(
    image,
    plan.source.x,
    plan.source.y,
    plan.source.w,
    plan.source.h,
    0,
    0,
    plan.width,
    plan.height,
  );

  for (const rect of plan.blur) burnBlur(context, canvas, rect);
  if (!marks) {
    return {
      dataUrl: await encode(canvas, format, 0.88),
      width: plan.width,
      height: plan.height,
      overlay: overlayOf(plan),
    };
  }

  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = plan.lineWidth;
  for (const item of plan.annotations) {
    context.strokeStyle = markColourHex(item.colour, brand.accent);
    context.fillStyle = markColourHex(item.colour, brand.accent);
    if (item.type === "arrow") drawArrow(context, item.from, item.to, plan.lineWidth);
    if (item.type === "box") {
      context.beginPath();
      context.roundRect(item.rect.x, item.rect.y, item.rect.w, item.rect.h, plan.lineWidth * 2);
      context.stroke();
    }
  }
  if (plan.highlight) {
    const { rect, shape } = plan.highlight;
    context.strokeStyle = brand.highlight;
    context.lineWidth = plan.lineWidth * 1.3;
    context.beginPath();
    if (shape === "circle")
      context.ellipse(
        rect.x + rect.w / 2,
        rect.y + rect.h / 2,
        rect.w / 2,
        rect.h / 2,
        0,
        0,
        Math.PI * 2,
      );
    else context.roundRect(rect.x, rect.y, rect.w, rect.h, plan.lineWidth * 2);
    context.stroke();
  }
  for (const item of plan.annotations) {
    if (item.type === "label")
      drawLabel(
        context,
        item.x,
        item.y,
        item.text,
        plan.fontSize,
        markColourHex(item.colour, brand.accent),
        brand.primary,
        safeFontName(brand.bodyFont, "Aptos"),
        item.colour === "white",
      );
  }
  return { dataUrl: await encode(canvas, format, 0.9), width: plan.width, height: plan.height };
}

/**
 * "Optimise for sharing" (docs/spec/05-export.md): a rendered screenshot re-encoded as JPEG at
 * quality 80, no wider or taller than 1920 px. Blur is already in the pixels, so it stays burned
 * in; the walkthrough's overlay is in percentages, so it still fits.
 */
export async function optimiseForSharing(
  image: RenderedImage,
  maxEdge = 1920,
): Promise<RenderedImage> {
  const source = await loadImage(image.dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas.");
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return {
    ...image,
    dataUrl: await encode(canvas, "image/jpeg", 0.8),
    width: canvas.width,
    height: canvas.height,
  };
}
