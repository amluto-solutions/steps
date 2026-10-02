import type { GuideStep } from "@amluto-steps/core";

/**
 * The walkthrough's camera (docs/spec/05-export.md#motion): a step with an automatic smart-zoom
 * crop opens on a slightly wider view and eases into the crop. The file holds only that wider
 * view, never the whole screenshot, so what the crop leaves out stays out; blur is burned into
 * all of it, and the export review checks all of it. A crop drawn by hand gets no camera, since
 * it may be there to leave something out.
 */

/** How much wider the camera starts than the crop. */
export const CAMERA_MARGIN = 1.3;

type Crop = NonNullable<GuideStep["crop"]>;

/** A box as percentages. */
export interface CameraBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * For an automatic crop: the wider view the camera starts from (as percentages of the
 * screenshot, the same shape as the crop and inside the screenshot), and the crop within that
 * view (as percentages of the view). Null for no crop, a hand-drawn one, or one already near the
 * whole screenshot.
 */
export function cameraFrame(crop: Crop | null): { frame: Crop; camera: CameraBox } | null {
  if (!crop || crop.source !== "auto" || crop.w <= 0 || crop.h <= 0) return null;
  const scale = Math.min(CAMERA_MARGIN, 100 / crop.w, 100 / crop.h);
  if (scale < 1.05) return null;
  const w = crop.w * scale;
  const h = crop.h * scale;
  const x = clamp(crop.x + crop.w / 2 - w / 2, 0, 100 - w);
  const y = clamp(crop.y + crop.h / 2 - h / 2, 0, 100 - h);
  return {
    frame: { x: round(x), y: round(y), w: round(w), h: round(h), source: "auto" },
    camera: {
      x: round(((crop.x - x) / w) * 100),
      y: round(((crop.y - y) / h) * 100),
      w: round((crop.w / w) * 100),
      h: round((crop.h / h) * 100),
    },
  };
}

/** The step as the walkthrough's picture shows it: an automatic crop widened for the camera. */
export function withCameraFrame<Step extends Pick<GuideStep, "crop">>(step: Step): Step {
  const found = cameraFrame(step.crop);
  return found ? { ...step, crop: found.frame } : step;
}

/** Where the camera ends, within the walkthrough's picture; null when it doesn't move. */
export const cameraOf = (step: Pick<GuideStep, "crop">): CameraBox | null =>
  cameraFrame(step.crop)?.camera ?? null;
