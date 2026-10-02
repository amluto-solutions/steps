import { describe, expect, it } from "vitest";

import { placeCard } from "./placement";
import { TOUR_STEPS } from "./steps";
import en from "../locales/en.json";

const viewport = { width: 1040, height: 680 };
const card = { width: 320, height: 180 };

describe("placeCard", () => {
  it("puts the card below a small target near the top, arrow at its centre", () => {
    const placed = placeCard({ left: 600, top: 10, width: 80, height: 36 }, card, viewport);
    expect(placed.side).toBe("below");
    expect(placed.top).toBe(60);
    expect(placed.left + placed.arrow).toBe(640);
  });

  it("goes above when there's no room below", () => {
    const placed = placeCard({ left: 600, top: 600, width: 80, height: 36 }, card, viewport);
    expect(placed.side).toBe("above");
    expect(placed.top + card.height).toBeLessThanOrEqual(600);
  });

  it("goes to the right of a tall narrow target, like the sidebar's views", () => {
    const placed = placeCard({ left: 14, top: 120, width: 188, height: 500 }, card, viewport);
    expect(placed.side).toBe("right");
    expect(placed.left).toBe(216);
  });

  it("stays on screen for a target in the top-right corner", () => {
    const placed = placeCard({ left: 1000, top: 8, width: 36, height: 36 }, card, viewport);
    expect(placed.left + card.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(placed.arrow).toBeLessThanOrEqual(card.width - 18);
  });

  it("puts the card inside a target that fills most of the window, like the guide list", () => {
    const placed = placeCard({ left: 216, top: 80, width: 824, height: 600 }, card, viewport);
    expect(placed.side).toBe("inside");
    expect(placed.left + card.width).toBeLessThanOrEqual(viewport.width);
  });
});

describe("the steps", () => {
  it("have unique ids, and words for every one", () => {
    expect(new Set(TOUR_STEPS.map((step) => step.id)).size).toBe(TOUR_STEPS.length);
    const words = en.tour.steps as Record<
      string,
      { title?: string; body?: string; tryIt?: string }
    >;
    for (const step of TOUR_STEPS) {
      expect(words[step.id]?.title, step.id).toBeTruthy();
      expect(words[step.id]?.body, step.id).toBeTruthy();
      if (step.tryIt) expect(words[step.id]?.tryIt, step.id).toBeTruthy();
    }
  });
});
