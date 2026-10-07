import type { OcrLine } from "@amluto-steps/core";

import type { Area, Point, TextReader } from "../screen-words";

/** A stand-in screenshot for the fake reader: a data URL carrying only its media id. */
export const fakeScreenshot = (mediaId: string) => `data:text/plain;base64,${btoa(mediaId)}`;

export interface FakeTextReader extends TextReader {
  /**
   * Each read, by the media id of the screenshot it was given, the blur sent with it and the
   * click it was read round.
   */
  readonly reads: { mediaId: string; blurred: Area[]; at: Point | undefined }[];
}

/**
 * The text reader for tests (the editor's, the export review's and draft naming's): the words on
 * each screenshot by media id, with "unavailable" for one it can't read (it fails, as the
 * desktop's OCR does without a language). Screenshots must come from `fakeScreenshot`. As in both
 * editions, a word whose centre is under a blur is left out.
 */
export function fakeTextReader(
  screens: Record<string, OcrLine[] | "unavailable">,
  others: OcrLine[] | "unavailable" = [],
): FakeTextReader {
  const reads: FakeTextReader["reads"] = [];
  return {
    reads,
    readText(image, blurred = [], at) {
      const mediaId = new TextDecoder().decode(image);
      reads.push({ mediaId, blurred, at });
      const found = screens[mediaId] ?? others;
      if (found === "unavailable") return Promise.reject(new Error("no text recognition"));
      return Promise.resolve(withoutBlurred(found, blurred));
    },
    clearTextCache: () => Promise.resolve(),
  };
}

function withoutBlurred(lines: OcrLine[], areas: Area[]): OcrLine[] {
  const hidden = (word: Area) => {
    const x = word.x + word.w / 2;
    const y = word.y + word.h / 2;
    return areas.some(
      (area) => x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h,
    );
  };
  return lines
    .map((line) => ({ words: line.words.filter((word) => !hidden(word)) }))
    .filter((line) => line.words.length > 0);
}
