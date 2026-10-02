import type { Annotation, GuideStep, MarkColour } from "@amluto-steps/core";

/** A rectangle in pixels of the rendered image. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PixelAnnotation =
  | { type: "arrow"; from: [number, number]; to: [number, number]; colour?: MarkColour }
  | { type: "box"; rect: PixelRect; colour?: MarkColour }
  | { type: "label"; x: number; y: number; text: string; colour?: MarkColour };

/**
 * Where everything goes on one exported screenshot, in pixels of the output image (after the
 * crop). Steps store percentages of the original screenshot (docs/spec/02-capture.md); this is the
 * single place they become pixels, so every format draws the same thing.
 */
export interface ImagePlan {
  /** The part of the source image to keep, in source pixels. */
  source: PixelRect;
  width: number;
  height: number;
  blur: PixelRect[];
  highlight: { shape: "circle" | "box"; rect: PixelRect } | null;
  annotations: PixelAnnotation[];
  /** Line width and label size scale with the image, so 1080p and 4K captures look alike. */
  lineWidth: number;
  fontSize: number;
}

const clampRect = (rect: PixelRect, width: number, height: number): PixelRect | null => {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.w);
  const bottom = Math.min(height, rect.y + rect.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
};

export function planImage(step: GuideStep, sourceWidth: number, sourceHeight: number): ImagePlan {
  const toSource = (rect: { x: number; y: number; w: number; h: number }): PixelRect => ({
    x: (rect.x / 100) * sourceWidth,
    y: (rect.y / 100) * sourceHeight,
    w: (rect.w / 100) * sourceWidth,
    h: (rect.h / 100) * sourceHeight,
  });
  const source = (step.crop && clampRect(toSource(step.crop), sourceWidth, sourceHeight)) ?? {
    x: 0,
    y: 0,
    w: sourceWidth,
    h: sourceHeight,
  };
  const width = Math.round(source.w);
  const height = Math.round(source.h);
  // Into output pixels: shift by the crop origin.
  const out = (rect: PixelRect): PixelRect => ({
    x: rect.x - source.x,
    y: rect.y - source.y,
    w: rect.w,
    h: rect.h,
  });
  const point = (p: [number, number]): [number, number] => [
    (p[0] / 100) * sourceWidth - source.x,
    (p[1] / 100) * sourceHeight - source.y,
  ];
  // Blur is clipped to the image; every blurred pixel inside the crop must be covered.
  const blur = step.redactions
    .map((area) => clampRect(out(toSource(area)), width, height))
    .filter((rect): rect is PixelRect => rect !== null);
  const annotations = step.annotations.map((item: Annotation): PixelAnnotation => {
    const colour = item.colour ? { colour: item.colour } : {};
    if (item.type === "arrow")
      return { type: "arrow", from: point(item.from), to: point(item.to), ...colour };
    if (item.type === "box") return { type: "box", rect: out(toSource(item)), ...colour };
    const [x, y] = point([item.x, item.y]);
    return { type: "label", x, y, text: item.text, ...colour };
  });
  const scale = Math.max(sourceWidth, sourceHeight);
  return {
    source,
    width,
    height,
    blur,
    highlight: step.highlight
      ? { shape: step.highlight.shape, rect: out(toSource(step.highlight)) }
      : null,
    annotations,
    ...markSizes(scale),
  };
}

/**
 * The block size used to pixelate a blurred area: large enough that text can't be read back
 * (at least 12 px, and a sixth of the area's shorter side), then the area is blurred as well.
 */
export const pixelateBlock = (rect: PixelRect) =>
  Math.max(12, Math.round(Math.min(rect.w, rect.h) / 6));

/** The marks the walkthrough draws live over a screenshot, as percentages of the output image. */
export interface Overlay {
  highlight: { shape: "circle" | "box"; x: number; y: number; w: number; h: number } | null;
  /** Where the cursor goes: the centre of the highlight. */
  click: { x: number; y: number } | null;
  annotations: (
    | { type: "arrow"; from: [number, number]; to: [number, number]; colour?: MarkColour }
    | { type: "box"; x: number; y: number; w: number; h: number; colour?: MarkColour }
    | { type: "label"; x: number; y: number; text: string; colour?: MarkColour }
  )[];
}

export function overlayOf(plan: ImagePlan): Overlay {
  const px = (value: number) => Math.round((value / plan.width) * 10000) / 100;
  const py = (value: number) => Math.round((value / plan.height) * 10000) / 100;
  const highlight = plan.highlight
    ? {
        shape: plan.highlight.shape,
        x: px(plan.highlight.rect.x),
        y: py(plan.highlight.rect.y),
        w: px(plan.highlight.rect.w),
        h: py(plan.highlight.rect.h),
      }
    : null;
  return {
    highlight,
    click: highlight
      ? { x: highlight.x + highlight.w / 2, y: highlight.y + highlight.h / 2 }
      : null,
    annotations: plan.annotations.map((item) => {
      const colour = item.colour ? { colour: item.colour } : {};
      return item.type === "arrow"
        ? {
            type: "arrow" as const,
            from: [px(item.from[0]), py(item.from[1])] as [number, number],
            to: [px(item.to[0]), py(item.to[1])] as [number, number],
            ...colour,
          }
        : item.type === "box"
          ? {
              type: "box" as const,
              x: px(item.rect.x),
              y: py(item.rect.y),
              w: px(item.rect.w),
              h: py(item.rect.h),
              ...colour,
            }
          : { type: "label" as const, x: px(item.x), y: py(item.y), text: item.text, ...colour };
    }),
  };
}

/**
 * How thick lines and how large labels are drawn on a picture whose longer edge is `longEdge`
 * pixels: the same in exported pictures and in the walkthrough's overlay.
 */
export function markSizes(longEdge: number): { lineWidth: number; fontSize: number } {
  return {
    lineWidth: Math.max(3, Math.round(longEdge / 320)),
    fontSize: Math.max(14, Math.round(longEdge / 90)),
  };
}
