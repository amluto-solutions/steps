import { describe, expect, it } from "vitest";

import { CAMERA_MARGIN, cameraFrame, cameraOf, withCameraFrame } from "./camera";

const auto = (x: number, y: number, w: number, h: number) =>
  ({ x, y, w, h, source: "auto" }) as const;

describe("the walkthrough's camera", () => {
  it("starts on a slightly wider view, the crop's shape, and rests on the crop", () => {
    const crop = auto(30, 30, 40, 40);
    const found = cameraFrame(crop);
    expect(found?.frame).toEqual({ x: 24, y: 24, w: 52, h: 52, source: "auto" });
    const frame = found?.frame ?? crop;
    const camera = found?.camera ?? { x: 0, y: 0, w: 100, h: 100 };
    expect(frame.w / crop.w).toBeCloseTo(CAMERA_MARGIN);
    // Back from the camera box to the crop, in the screenshot's percentages.
    expect(frame.x + (camera.x / 100) * frame.w).toBeCloseTo(crop.x);
    expect(frame.y + (camera.y / 100) * frame.h).toBeCloseTo(crop.y);
    expect((camera.w / 100) * frame.w).toBeCloseTo(crop.w);
  });

  it("stays inside the screenshot at its edges, still the crop's shape", () => {
    const found = cameraFrame(auto(0, 70, 40, 30));
    expect(found?.frame.x).toBe(0);
    expect((found?.frame.y ?? 0) + (found?.frame.h ?? 0)).toBeCloseTo(100);
    expect((found?.frame.w ?? 0) / (found?.frame.h ?? 1)).toBeCloseTo(40 / 30);
    // A crop nearly the whole height can only grow as far as the screenshot allows.
    expect((cameraFrame(auto(10, 5, 60, 90))?.frame.h ?? 0) <= 100).toBe(true);
  });

  it("leaves hand-drawn crops alone, and crops already near the whole screenshot", () => {
    expect(cameraFrame({ x: 30, y: 30, w: 40, h: 40, source: "manual" })).toBeNull();
    expect(cameraFrame(auto(0, 0, 98, 98))).toBeNull();
    expect(cameraFrame(null)).toBeNull();
    const manual = { crop: { x: 1, y: 1, w: 50, h: 50, source: "manual" as const } };
    expect(withCameraFrame(manual)).toBe(manual);
    expect(cameraOf(manual)).toBeNull();
  });
});
