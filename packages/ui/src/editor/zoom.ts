import type { GuideStep } from "@amluto-steps/core";

import type { Change, EditorDoc, Edit } from "./document";
import type { Stamp } from "./edits";

/**
 * Smart zoom (docs/spec/04-editor.md#image-tools): a page shows about 1,600 pixels of screenshot
 * legibly, so wider captures (whole monitors, 4K screens) get an automatic crop of that width
 * around the click. It is marked "auto" and removed like any other crop.
 */
export const LEGIBLE_WIDTH_PX = 1600;

export function smartZoomCrop(step: GuideStep): GuideStep["crop"] {
  const width = step.media?.width ?? 0;
  const height = step.media?.height ?? 0;
  if (!step.highlight || width <= LEGIBLE_WIDTH_PX * 1.25 || height <= 0) return null;
  const w = (LEGIBLE_WIDTH_PX / width) * 100;
  // The same share of the height keeps the screenshot's own shape, so the page layout holds.
  const h = w;
  const centreX = step.highlight.x + step.highlight.w / 2;
  const centreY = step.highlight.y + step.highlight.h / 2;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    x: round(Math.min(100 - w, Math.max(0, centreX - w / 2))),
    y: round(Math.min(100 - h, Math.max(0, centreY - h / 2))),
    w: round(w),
    h: round(h),
    source: "auto",
  };
}

/** "Zoom in on each click": every eligible step without a crop gets one, as one undo step. */
export function applySmartZoom(doc: EditorDoc, stamp: Stamp): Edit | null {
  const changes: Change[] = [];
  for (const step of doc.steps) {
    if (step.kind !== "interaction" || step.crop) continue;
    const crop = smartZoomCrop(step);
    if (!crop) continue;
    changes.push({
      kind: "step",
      id: step.id,
      before: step,
      after: { ...step, crop, updatedAt: new Date(stamp.at).toISOString(), updatedBy: stamp.by },
    });
  }
  return changes.length ? { label: "zoom in on clicks", changes, at: stamp.at } : null;
}
