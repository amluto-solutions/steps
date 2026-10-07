// @vitest-environment jsdom
import { findSensitive } from "@amluto-steps/core";
import { beforeEach, describe, expect, it } from "vitest";

import { pageText, TEXT_LIMITS, type Measure } from "./page-text";

const viewport = { width: 1000, height: 500 };

/**
 * Lays text out without a browser: each element sits at its `data-top` (and `data-left`), and
 * each character is 10 pixels wide and 20 high. `data-wrap` wraps its text after that many
 * characters onto the next line.
 */
const layout: Measure = {
  element(element) {
    const top = Number((element as HTMLElement).dataset.top ?? 0);
    const left = Number((element as HTMLElement).dataset.left ?? 0);
    return { left, top, width: 300, height: 20 };
  },
  word(node, start, end) {
    const element = node.parentElement as HTMLElement;
    const wrap = Number(element.dataset.wrap ?? 1_000_000);
    const row = Math.floor(start / wrap);
    const column = start - row * wrap;
    return {
      left: Number(element.dataset.left ?? 0) + column * 10,
      top: Number(element.dataset.top ?? 0) + row * 20,
      width: (end - start) * 10,
      height: 20,
    };
  },
};

/**
 * A clock that never moves, so only the test about the time budget can run out of it. With the
 * real clock, a worker paused for more than the budget (by a busy machine, or garbage collection)
 * stopped reading part-way and the test saw too few words.
 */
const still = () => 0;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the page's own text", () => {
  it("gives each visible word its place, in lines, as percentages of the view", () => {
    document.body.innerHTML = `<p data-top="100" data-left="50">Email sam@example.com</p>`;
    const lines = pageText(document, viewport, layout, still);
    expect(lines).toEqual([
      {
        words: [
          { text: "Email", x: 5, y: 20, w: 5, h: 4 },
          { text: "sam@example.com", x: 11, y: 20, w: 15, h: 4 },
        ],
      },
    ]);
    // The shared rules find the address in it, as they would in OCR's lines.
    expect(findSensitive(lines, []).map((found) => found.kind)).toContain("email");
  });

  it("starts a new line where text wraps", () => {
    document.body.innerHTML = `<p data-top="0" data-wrap="6">Hello there world</p>`;
    expect(pageText(document, viewport, layout, still).map((line) => line.words.length)).toEqual([
      1, 1, 1,
    ]);
  });

  it("leaves out text off screen, hidden, in scripts and in fields", () => {
    document.body.innerHTML = `
      <p data-top="900">Below the fold</p>
      <div aria-hidden="true" data-top="10">Hidden</div>
      <script data-top="10">secret()</script>
      <textarea data-top="10">typed notes</textarea>
      <select data-top="10"><option>Choice</option></select>
      <p data-top="10">Shown</p>`;
    const words = pageText(document, viewport, layout, still).flatMap((line) =>
      line.words.map((word) => word.text),
    );
    expect(words).toEqual(["Shown"]);
  });

  it("never reads an editor's words, which were typed", () => {
    document.body.innerHTML = `
      <div contenteditable="true" data-top="10"><p data-top="10">Dear Sam</p></div>
      <p data-top="40">To: Sam</p>`;
    const words = pageText(document, viewport, layout, still).flatMap((line) =>
      line.words.map((word) => word.text),
    );
    expect(words).toEqual(["To:", "Sam"]);
    document.designMode = "on";
    try {
      expect(pageText(document, viewport, layout, still)).toEqual([]);
    } finally {
      document.designMode = "off";
    }
  });

  it("stops at its limits", () => {
    const many = Array.from({ length: TEXT_LIMITS.words + 50 }, (_, index) => `w${index}`);
    document.body.innerHTML = `<p data-top="0" data-wrap="80">${many.join(" ")}</p>`;
    const count = (lines: ReturnType<typeof pageText>) =>
      lines.reduce((total, line) => total + line.words.length, 0);
    // Wrapped rows past the view's height are off screen, so only the first rows count.
    expect(count(pageText(document, { width: 1000, height: 100_000 }, layout, still))).toBe(
      TEXT_LIMITS.words,
    );
    // Out of time: nothing more is read.
    let now = 0;
    const slow = () => (now += TEXT_LIMITS.budgetMs + 1);
    expect(pageText(document, viewport, layout, slow)).toEqual([]);
  });
});
