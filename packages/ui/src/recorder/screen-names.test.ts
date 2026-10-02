import { describe, expect, it } from "vitest";
import type { GuideStep } from "@amluto-steps/core";

import { blankStep } from "../editor/edits";
import { nameFromScreen } from "./screen-names";

const unnamed = (id: string): GuideStep => ({
  ...blankStep(id, { at: 0, by: "Robin" }),
  kind: "interaction",
  action: "click",
  actionText: 'Click in "Settings"',
  reviewRequired: true,
  media: { id: `m-${id}`, width: 100, height: 100, scale: 1, captureRect: null },
  highlight: { shape: "circle", x: 9, y: 25, w: 2, h: 2 },
});

describe("naming clicks from their screenshots (F016)", () => {
  it("names a click from the words at it, and leaves it to check when there are none", async () => {
    const lines = [{ words: [{ text: "System", x: 8, y: 25, w: 6, h: 2 }] }];
    const [named, still] = await nameFromScreen(
      [
        unnamed("a"),
        {
          ...unnamed("b"),
          media: { id: "empty", width: 100, height: 100, scale: 1, captureRect: null },
        },
      ],
      async (mediaId) => (mediaId === "empty" ? [] : lines),
      { language: "en", tone: "casual" },
    );
    expect(named?.actionText).toBe('Click "System"');
    expect(named?.reviewRequired).toBe(false);
    expect(still?.actionText).toBe('Click in "Settings"');
    expect(still?.reviewRequired).toBe(true);
  });
});
