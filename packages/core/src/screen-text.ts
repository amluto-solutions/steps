import type { OcrLine, OcrWord } from "./privacy.ts";

/**
 * What a click was on, read from the screenshot's own words when the app didn't say
 * (01/10/2026): many apps don't give their buttons usable names.
 * The words under the click, or, for an icon, the label just to its right or just below it.
 * Points and boxes are percentages of the image.
 */
export function textAtPoint(lines: OcrLine[], x: number, y: number): string | null {
  const PAD = 0.6;
  const hit = (word: OcrWord) =>
    x >= word.x - PAD &&
    x <= word.x + word.w + PAD &&
    y >= word.y - PAD &&
    y <= word.y + word.h + PAD;
  for (const line of lines) {
    const index = line.words.findIndex(hit);
    if (index >= 0) return phraseAround(line.words, index);
  }
  // An icon with its label beside it (Settings' navigation, File Explorer's buttons).
  let best: { distance: number; words: OcrWord[]; index: number } | null = null;
  for (const line of lines) {
    line.words.forEach((word, index) => {
      const sameRow = y >= word.y - word.h * 0.6 && y <= word.y + word.h * 1.6;
      const right = word.x - x;
      if (sameRow && right > 0 && right < 12 && (!best || right < best.distance))
        best = { distance: right, words: line.words, index };
      const below = word.y - y;
      const centred = Math.abs(word.x + word.w / 2 - x) < Math.max(word.w, 3);
      if (centred && below > 0 && below < 5 && (!best || below < best.distance))
        best = { distance: below, words: line.words, index };
    });
  }
  const found = best as { words: OcrWord[]; index: number } | null;
  return found ? phraseAround(found.words, found.index) : null;
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
