import { describe, expect, it } from "vitest";
import type { Guide } from "@amluto-steps/core";

import { applyChanges } from "./document";
import { blankStep } from "./edits";
import { applySmartZoom, smartZoomCrop } from "./zoom";

const stamp = { at: 0, by: "Robin" };
const wide = {
  ...blankStep("wide", stamp),
  media: { id: "m", width: 3840, height: 2160, scale: 2, captureRect: null },
  highlight: { shape: "circle" as const, x: 90, y: 5, w: 2, h: 3.5 },
};

describe("smart zoom", () => {
  it("crops a 4K capture to a readable width around the click, inside the image", () => {
    const crop = smartZoomCrop(wide);
    expect(crop?.source).toBe("auto");
    expect(crop?.w).toBeCloseTo((1600 / 3840) * 100, 1);
    expect(crop?.h).toBe(crop?.w);
    // The click is near the top-right corner, so the crop is pushed back inside the image.
    expect(crop && crop.x + crop.w).toBeLessThanOrEqual(100);
    expect(crop?.y).toBe(0);
  });

  it("leaves ordinary window captures and cropped steps alone, as one undo step", () => {
    const normal = { ...wide, id: "normal", media: { ...wide.media, width: 1600, height: 900 } };
    const cropped = {
      ...wide,
      id: "cropped",
      crop: { x: 0, y: 0, w: 50, h: 50, source: "manual" as const },
    };
    expect(smartZoomCrop(normal)).toBeNull();
    const doc = { guide: { id: "g" } as Guide, steps: [cropped, normal, wide] };
    const edit = applySmartZoom(doc, stamp);
    expect(edit?.changes.map((change) => (change.kind === "step" ? change.id : ""))).toEqual([
      "wide",
    ]);
    const zoomed = applyChanges(doc, edit?.changes ?? [], "do");
    expect(applyChanges(zoomed, edit?.changes ?? [], "undo")).toEqual(doc);
  });
});
