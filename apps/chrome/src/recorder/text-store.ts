import type { OcrLine } from "@amluto-steps/core";
import type { Words } from "@amluto-steps/ui";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * The words each screenshot showed, kept in this browser only, the Chrome edition's version of
 * the desktop's OCR cache (docs/spec/03-data-and-sharing.md#ocr-cache). An entry is found by the
 * screenshot's SHA-256, so a guide's screenshot finds its words wherever it's stored. One changed
 * by a burned-in blur or a crop has other bytes, and its words are unavailable: never read, so
 * never checked for personal data, which isn't the same as a page with no words. Text under a
 * blur is dropped for good, and an entry not used for 30 days is deleted.
 */

interface TextDb extends DBSchema {
  texts: {
    key: string;
    value: { key: string; lines: OcrLine[]; usedAt: number };
    indexes: { usedAt: number };
  };
}

export type TextDatabase = IDBPDatabase<TextDb>;

export const openTextStore = (name = "steps-page-text") =>
  openDB<TextDb>(name, 1, {
    upgrade(db) {
      db.createObjectStore("texts", { keyPath: "key" }).createIndex("usedAt", "usedAt");
    },
  });

/** How long words are kept after last being used. */
export const KEEP_TEXT_MS = 30 * 24 * 60 * 60 * 1000;

/** A blurred area, as percentages of the image. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A word whose centre is under a blur isn't kept, as on the desktop. */
export function withoutBlurred(lines: OcrLine[], areas: readonly Area[]): OcrLine[] {
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

export async function imageKey(image: Blob | Uint8Array): Promise<string> {
  const bytes = image instanceof Blob ? await image.arrayBuffer() : new Uint8Array(image);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function textStore(db: TextDatabase, now: () => number = Date.now) {
  return {
    /** The words a screenshot showed as it was taken (none is an answer too, and is kept). */
    async keep(image: Blob, lines: OcrLine[]) {
      await db.put("texts", { key: await imageKey(image), lines, usedAt: now() });
    },

    /**
     * A screenshot's words, less any under `blurred` (which are then dropped for good), or
     * "unavailable" for a screenshot this browser kept none for.
     */
    async read(image: Uint8Array, blurred: readonly Area[] = []): Promise<Words> {
      const key = await imageKey(image);
      const found = await db.get("texts", key);
      if (!found) return "unavailable";
      const lines = withoutBlurred(found.lines, blurred);
      await db.put("texts", { key, lines, usedAt: now() });
      return lines;
    },

    clear: () => db.clear("texts"),

    /** Deletes words not used for 30 days. */
    async prune() {
      const tx = db.transaction("texts", "readwrite");
      let cursor = await tx.store
        .index("usedAt")
        .openCursor(IDBKeyRange.upperBound(now() - KEEP_TEXT_MS));
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    },
  };
}

export type TextStore = ReturnType<typeof textStore>;
