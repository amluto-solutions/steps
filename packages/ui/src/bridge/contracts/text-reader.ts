import type { OcrLine } from "@amluto-steps/core";
import { describe, expect, it } from "vitest";

import type { TextReader } from "../../screen-words";
import type { Subject } from "./subject";

/** The words on the contract's readable screenshot: an email beside its label, and a total. */
export const SCREEN_WORDS: OcrLine[] = [
  {
    words: [
      { text: "Email", x: 10, y: 10, w: 5, h: 2 },
      { text: "sam@example.com", x: 16, y: 10, w: 15, h: 2 },
    ],
  },
  { words: [{ text: "Total", x: 10, y: 20, w: 5, h: 2 }] },
];

export interface TextReaderSubject extends Subject<TextReader> {
  /** A screenshot the edition has `SCREEN_WORDS` for: recognised, or kept as the page showed. */
  readable: Uint8Array;
  /** One it has no words for: recognition failed, or none were kept for it. */
  unreadable: Uint8Array;
}

const texts = (lines: OcrLine[] | "unavailable") =>
  lines === "unavailable" ? lines : lines.flatMap((line) => line.words.map((word) => word.text));

/** What the screen words module (editor, export review, draft naming) relies on. */
export function textReaderContract(
  edition: string,
  make: () => TextReaderSubject | Promise<TextReaderSubject>,
) {
  describe(`${edition}: reading a screenshot's words`, () => {
    it("reads them, leaving out any whose centre is under a blur", async () => {
      const { part, readable } = await make();
      expect(texts(await part.readText(readable))).toEqual(["Email", "sam@example.com", "Total"]);
      const blurred = await part.readText(readable.slice(), [{ x: 15, y: 9, w: 20, h: 4 }]);
      expect(texts(blurred)).toEqual(["Email", "Total"]);
    });

    it("says unavailable for a screenshot it can't read, never that it has no words", async () => {
      const { part, unreadable } = await make();
      // Failing counts as unavailable, as the screen words module takes it.
      const words = await part.readText(unreadable).catch(() => "unavailable" as const);
      expect(words).toBe("unavailable");
    });

    it("clears what it kept", async () => {
      const { part } = await make();
      await part.clearTextCache();
    });
  });
}
