import type { OcrLine, OcrWord } from "./privacy.ts";

/** A point on a screenshot, in percentages of it. */
export interface Point {
  x: number;
  y: number;
}

/** A box on a screenshot, in percentages of it: the outline of what was clicked. */
export interface Box extends Point {
  w: number;
  h: number;
}

/**
 * What a click was on, read from the screenshot's own words when the app didn't say
 * (01/10/2026): many apps don't give their buttons usable names.
 * The words under the click, or, for an icon, the label just to its right or just below it.
 * Points and boxes are percentages of the image. `element` is the clicked element's outline,
 * when the recorder had one: its own words, or the label centred just under it, come before
 * anything else near the click (07/10/2026: an icon in a web panel's side rail, labelled
 * underneath, was named after a button on its row and a menu heading beside it).
 */
export function textAtPoint(
  lines: OcrLine[],
  x: number,
  y: number,
  element?: Box | null,
): string | null {
  const PAD = 0.6;
  // How far the click is outside a word's box (0 inside it). Of the words within PAD of the
  // click, the nearest is taken, so two close rows can't hand over the wrong one by their order.
  const outside = (word: OcrWord) =>
    Math.hypot(
      Math.max(word.x - x, 0, x - (word.x + word.w)),
      Math.max(word.y - y, 0, y - (word.y + word.h)),
    );
  type Found = { distance: number; words: OcrWord[]; index: number };
  let on: Found | null = null;
  for (const line of lines) {
    line.words.forEach((word, index) => {
      const distance = outside(word);
      if (distance <= PAD && (!on || distance < on.distance))
        on = { distance, words: line.words, index };
    });
  }
  const hit = on as Found | null;
  if (hit) return phraseAround(hit.words, hit.index);
  if (element) {
    const own = ownLabel(lines, x, y, element);
    if (own) return phraseAround(own.words, own.index);
  }
  // An icon with its label beside it (Settings' navigation, File Explorer's buttons), a click
  // just past the end of a menu item's word, or one in a button below its words. A label on the
  // click's own row comes before one underneath: the next menu item or button down is not the
  // one clicked (05/10/2026).
  let row: Found | null = null;
  let under: Found | null = null;
  for (const line of lines) {
    line.words.forEach((word, index) => {
      const sameRow = y >= word.y - word.h * 0.25 && y <= word.y + word.h * 1.25;
      const gap = word.x > x ? word.x - x : x - (word.x + word.w);
      if (sameRow && gap > 0 && gap < 12 && (!row || gap < row.distance))
        row = { distance: gap, words: line.words, index };
      // Less than the words' own height below them is still their row.
      const over = y - (word.y + word.h);
      const across = x >= word.x - PAD && x <= word.x + word.w + PAD;
      if (across && over > 0 && over < word.h && (!row || over < row.distance))
        row = { distance: over, words: line.words, index };
      const below = word.y - y;
      const centred = Math.abs(word.x + word.w / 2 - x) < Math.max(word.w, 3);
      if (centred && below > 0 && below < 5 && (!under || below < under.distance))
        under = { distance: below, words: line.words, index };
    });
  }
  const found = (row ?? under) as Found | null;
  return found ? phraseAround(found.words, found.index) : null;
}

/**
 * The element's own words: those inside its outline (the nearest to the click), or else a label
 * centred under it, within its own height (an icon labelled underneath).
 */
function ownLabel(
  lines: OcrLine[],
  x: number,
  y: number,
  box: Box,
): { words: OcrWord[]; index: number } | null {
  let inside: { distance: number; words: OcrWord[]; index: number } | null = null;
  let under: { distance: number; words: OcrWord[]; index: number } | null = null;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  for (const line of lines) {
    line.words.forEach((word, index) => {
      const middleX = word.x + word.w / 2;
      const middleY = word.y + word.h / 2;
      if (middleX >= box.x && middleX <= right && middleY >= box.y && middleY <= bottom) {
        const distance = Math.hypot(middleX - x, middleY - y);
        if (!inside || distance < inside.distance) inside = { distance, words: line.words, index };
        return;
      }
      const gap = word.y - bottom;
      if (middleX >= box.x && middleX <= right && gap >= -word.h / 2 && gap < Math.max(box.h, 2))
        if (!under || gap < under.distance) under = { distance: gap, words: line.words, index };
    });
  }
  return inside ?? under;
}

/** The words next to each other around one: a label, not the whole line it sits in. */
function phraseAround(words: OcrWord[], index: number): string | null {
  const close = (left: OcrWord | undefined, right: OcrWord | undefined) =>
    Boolean(left && right && right.x - (left.x + left.w) < Math.max(left.h * 1.4, 1.2));
  let from = index;
  while (from > 0 && close(words[from - 1], words[from])) from -= 1;
  let to = index;
  while (to < words.length - 1 && close(words[to], words[to + 1])) to += 1;
  const text = words
    .slice(from, to + 1)
    .map((word) => word.text)
    .join(" ")
    .trim();
  if (text.length > 60 || !/\p{L}{2}/u.test(text)) return null;
  return text;
}
