import { describe, expect, it } from "vitest";

import type { OcrLine } from "./privacy.ts";
import { textAtPoint } from "./screen-text.ts";

/** A line of words at `y`, each 1% per character wide, `gap`% apart. */
const line = (text: string, x: number, y: number, gap = 0.6): OcrLine => {
  let at = x;
  return {
    words: text.split(" ").map((word) => {
      const box = { text: word, x: at, y, w: word.length, h: 2 };
      at += word.length + gap;
      return box;
    }),
  };
};

describe("naming a click from the screenshot's words", () => {
  const settings = [
    line("Bluetooth & devices", 8, 30),
    line("System", 8, 25),
    line("Network & internet", 8, 35),
    // A second column far to the right on the same row is a different thing.
    { words: [{ text: "Display", x: 60, y: 25, w: 7, h: 2 }] },
  ];

  it("takes the label under the click, not the whole row", () => {
    expect(textAtPoint(settings, 10, 26)).toBe("System");
    expect(textAtPoint(settings, 20, 31)).toBe("Bluetooth & devices");
  });

  it("takes the label beside or below an icon", () => {
    expect(textAtPoint(settings, 5, 26)).toBe("System");
    expect(textAtPoint([line("Paste", 40, 12)], 42, 8)).toBe("Paste");
  });

  it("says nothing when there's no word near, or only a number", () => {
    expect(textAtPoint(settings, 40, 80)).toBeNull();
    expect(textAtPoint([line("42", 10, 10)], 10.5, 10.5)).toBeNull();
  });
});
