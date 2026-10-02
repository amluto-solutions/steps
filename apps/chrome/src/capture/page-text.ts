import type { OcrLine, OcrWord } from "@amluto-steps/core";

/**
 * The words on screen as a click happens, with where each one is, so the editor can suggest
 * blurs (docs/spec/02-capture.md#chrome-edition). The desktop reads a screenshot's words with
 * OCR; a page already knows its own. Only the page's text is read: never a field's value, which
 * stays behind "Record what's typed".
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How boxes are measured: the browser's layout, or a stand-in in tests. */
export interface Measure {
  element(element: Element): Box;
  word(node: Text, start: number, end: number): Box;
}

export const browserMeasure = (document: Document): Measure => {
  const range = document.createRange();
  return {
    element: (element) => element.getBoundingClientRect(),
    word(node, start, end) {
      range.setStart(node, start);
      range.setEnd(node, end);
      return range.getBoundingClientRect();
    },
  };
};

/** Limits, so reading the page never holds up the click noticeably. */
export const TEXT_LIMITS = { words: 3000, wordLength: 200, budgetMs: 25 };

/** Never read: code, lists of options, hidden text, and what people typed (fields, editors). */
const SKIPPED = [
  "script, style, noscript, template, textarea, select, option, [aria-hidden='true']",
  "[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']",
].join(", ");

const percent = (value: number, total: number) =>
  Math.round(Math.min(Math.max(value / total, 0), 1) * 10_000) / 100;

/** The visible words, as lines of words in percentages of the viewport, like OCR's lines. */
export function pageText(
  document: Document,
  viewport: { width: number; height: number },
  measure: Measure,
  clock: () => number = () => performance.now(),
): OcrLine[] {
  const started = clock();
  // A document in design mode is all editor: every word in it was typed.
  if (document.designMode === "on") return [];
  const { width, height } = viewport;
  const onScreen = (box: Box) =>
    box.width > 0 &&
    box.height > 0 &&
    box.left < width &&
    box.top < height &&
    box.left + box.width > 0 &&
    box.top + box.height > 0;
  const lines: OcrLine[] = [];
  let count = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (count >= TEXT_LIMITS.words || clock() - started > TEXT_LIMITS.budgetMs) break;
    const text = node.nodeValue ?? "";
    const parent = node.parentElement;
    if (!parent || !text.trim() || parent.closest(SKIPPED) || !onScreen(measure.element(parent)))
      continue;
    let line: OcrWord[] = [];
    let lineTop = Number.NaN;
    for (const match of text.matchAll(/\S+/g)) {
      if (count >= TEXT_LIMITS.words) break;
      const box = measure.word(node as Text, match.index, match.index + match[0].length);
      if (!onScreen(box)) continue;
      // A word lower down than half its height starts a new line.
      if (line.length > 0 && Math.abs(box.top - lineTop) > box.height / 2) {
        lines.push({ words: line });
        line = [];
      }
      lineTop = box.top;
      line.push({
        text: match[0].slice(0, TEXT_LIMITS.wordLength),
        x: percent(box.left, width),
        y: percent(box.top, height),
        w: percent(box.width, width),
        h: percent(box.height, height),
      });
      count += 1;
    }
    if (line.length > 0) lines.push({ words: line });
  }
  return lines;
}
