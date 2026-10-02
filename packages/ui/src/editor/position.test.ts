import { describe, expect, it } from "vitest";

import { fieldsOf, placed, type Geometry } from "./ImageEditor";

const geometry: Geometry = {
  highlight: { shape: "box", x: 10, y: 10, w: 5, h: 5 },
  annotations: [
    { type: "arrow", from: [1, 2], to: [3, 4] },
    { type: "label", x: 20, y: 30, text: "Here" },
  ],
  redactions: [{ x: 40, y: 40, w: 10, h: 10, source: "manual" }],
  crop: null,
};

describe("the numeric position panel", () => {
  it("shows the right numbers for each kind of mark", () => {
    expect(fieldsOf(geometry, { kind: "highlight" })).toEqual({ x: 10, y: 10, w: 5, h: 5 });
    expect(fieldsOf(geometry, { kind: "annotation", index: 0 })).toEqual({
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
    });
    expect(fieldsOf(geometry, { kind: "annotation", index: 1 })).toEqual({ x: 20, y: 30 });
    expect(fieldsOf(geometry, { kind: "crop" })).toBeNull();
  });

  it("sets one number exactly, leaving everything else as it was", () => {
    const moved = placed(geometry, { kind: "redaction", index: 0 }, "w", 25);
    expect(moved.redactions[0]).toEqual({ x: 40, y: 40, w: 25, h: 10, source: "manual" });
    expect(moved.highlight).toBe(geometry.highlight);
    const arrow = placed(geometry, { kind: "annotation", index: 0 }, "toY", 50);
    expect(arrow.annotations[0]).toEqual({ type: "arrow", from: [1, 2], to: [3, 50] });
    const label = placed(geometry, { kind: "annotation", index: 1 }, "x", 5);
    expect(label.annotations[1]).toEqual({ type: "label", x: 5, y: 30, text: "Here" });
  });
});
