import type { OcrLine, Point } from "@amluto-steps/core";

export type { Point };

/** An area of a screenshot, in percentages of it. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of the recorder bridge that reads a screenshot's words (cut from it, 06/10/2026):
 * Windows OCR or Tesseract on the desktop, cached in app data; the page's own text in Steps for
 * Chrome. Words whose centre is under a `blurred` area are left out, and out of its cache. The
 * desktop reads the area round `at` (the click) again, enlarged and with its contrast raised,
 * after taking out the text caret a click in a text box leaves there (#19); Steps for Chrome
 * has the page's text already and doesn't need to, and answers "unavailable" for a screenshot it
 * kept no words for. Failing counts as unavailable too (the desktop fails without a language).
 */
export interface TextReader {
  readText(image: Uint8Array, blurred?: Area[], at?: Point): Promise<Words>;
  clearTextCache(): Promise<void>;
}

/**
 * A screenshot's words, or "unavailable" when they couldn't be read (no text recognition, no
 * language for it, the screenshot didn't load, or in Steps for Chrome none were kept for it).
 * Kept apart from "no words": a screenshot that couldn't be read was never checked for personal
 * data, so it can't be called clear.
 */
export type Words = OcrLine[] | "unavailable";

/**
 * What words are asked for: a step's screenshot, its blur and its click mark (a step itself will
 * do).
 */
export interface StepPicture {
  media?: { id: string | null } | null;
  redactions: readonly Area[];
  highlight?: Area | null;
}

/** Where a step was clicked: the middle of its click mark, or nowhere without one. */
export const clickPointOf = (mark: Area | null | undefined): Point | undefined =>
  mark ? { x: mark.x + mark.w / 2, y: mark.y + mark.h / 2 } : undefined;

/** The words on a step's screenshot under its blur (docs/spec/03-data-and-sharing.md#ocr-cache). */
export interface ScreenWords {
  wordsOf(step: StepPicture): Promise<Words>;
}

/** A data URL's bytes, for sending a screenshot to be read. */
const dataUrlBytes = (dataUrl: string): Uint8Array => {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/**
 * Screen words for the screenshots `loadImage` loads: one guide's or one recording's, since media
 * ids are only unique within one ("click-12" is in many recordings).
 *
 * Answers are kept in memory per screenshot and blur, in front of the desktop app's disk cache,
 * so the editor, Blur all and Find & Blur don't load and send the same screenshot again. Two
 * steps can share a screenshot with different blur, and words under one step's blur must still
 * count for the other, so the blur is part of the key. Asking again while a read is under way
 * waits for it. "Unavailable" isn't kept: the screenshot may sync, or a language be installed.
 *
 * The words round a step's click are read closer up (#19), so the click is part of the key too:
 * steps sharing a screenshot but clicked in different places each get their own reading.
 */
export function screenWords(
  reader: TextReader | undefined,
  loadImage: (mediaId: string) => Promise<string>,
): ScreenWords {
  const known = new Map<string, Promise<Words>>();
  const read = async (mediaId: string, blurred: Area[], at?: Point): Promise<Words> => {
    if (!reader) return "unavailable";
    try {
      return await reader.readText(dataUrlBytes(await loadImage(mediaId)), blurred, at);
    } catch {
      return "unavailable";
    }
  };
  return {
    async wordsOf(step) {
      const mediaId = step.media?.id;
      if (!mediaId) return [];
      // Only the areas count: a suggested blur hides the same words as a drawn one.
      const blurred = step.redactions.map(({ x, y, w, h }) => ({ x, y, w, h }));
      const at = clickPointOf(step.highlight);
      const key = `${mediaId}|${JSON.stringify(blurred)}|${at ? `${at.x},${at.y}` : ""}`;
      const asked = known.get(key);
      if (asked) return asked;
      const reading = read(mediaId, blurred, at);
      known.set(key, reading);
      const words = await reading;
      if (words === "unavailable") known.delete(key);
      return words;
    },
  };
}
