/**
 * Which characters a font has (its `cmap` table), so a PDF in Japanese, Greek or Polish is set in
 * a font that can show it (docs/spec/05-export.md#languages). Word and the web page leave that to
 * the reader's PC, which falls back by itself; a PDF carries its fonts, so it must be right.
 */

import { isEmojiPoint, sfntCodePoints } from "@amluto-steps/export";

/** The code points a TrueType font maps (formats 4 and 12, Unicode subtables), or null if unread. */
export const fontCodePoints = sfntCodePoints;

/**
 * The characters of `text` a font must have: everything past plain ASCII, once each, except
 * emoji, which the PDF draws from its emoji font when the text font lacks them
 * (docs/spec/05-export.md#emoji).
 */
export function charactersOf(text: string): number[] {
  const found = new Set<number>();
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    // Plain ASCII is in every font; joiners and selectors don't need glyphs of their own.
    if (
      point > 0x7e &&
      !(point >= 0xfe00 && point <= 0xfe0f) &&
      point !== 0x200d &&
      !isEmojiPoint(point)
    )
      found.add(point);
  }
  return [...found];
}

/**
 * The bundled fallbacks (Inter and Jost, Latin subsets) as fontsource describes them: Latin-1
 * and a few signs. Read from their `unicode-range`, as the WOFF files themselves are compressed.
 */
const BUNDLED_LATIN: [number, number][] = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2212, 0x2212],
];

export const bundledCovers = (points: number[]) =>
  points.every((point) => BUNDLED_LATIN.some(([start, end]) => point >= start && point <= end));

/**
 * Fonts Windows (and common Linux desktops) have for each script, best first: tried in turn when
 * the brand's fonts can't show a guide's language.
 */
const GENERAL = ["Segoe UI", "Arial", "Noto Sans", "DejaVu Sans", "Liberation Sans"];
export const SCRIPT_FONTS: Partial<Record<string, string[]>> = {
  ja: ["Yu Gothic", "Meiryo", "MS Gothic", "Noto Sans CJK JP", "Noto Sans JP"],
  "zh-Hans": ["Microsoft YaHei", "DengXian", "SimHei", "Noto Sans CJK SC", "Noto Sans SC"],
  "zh-Hant": ["Microsoft JhengHei", "MingLiU", "Noto Sans CJK TC", "Noto Sans TC"],
  ko: ["Malgun Gothic", "Gulim", "Noto Sans CJK KR", "Noto Sans KR"],
};

/**
 * The fonts to try for `language`, its script's own first, then those of any script the text
 * itself uses: an English guide titled in Chinese needs a Chinese font (F050, 01/10/2026).
 */
export function fontsToTry(language: string, points: number[] = []): string[] {
  const has = (from: number, to: number) => points.some((point) => point >= from && point <= to);
  const scripts = [
    language,
    ...(has(0xac00, 0xd7af) || has(0x1100, 0x11ff) ? ["ko"] : []),
    ...(has(0x3040, 0x30ff) ? ["ja"] : []),
    ...(has(0x3400, 0x9fff) ? [language === "zh-Hant" ? "zh-Hant" : "zh-Hans", "ja"] : []),
  ];
  return [...new Set([...scripts.flatMap((code) => SCRIPT_FONTS[code] ?? []), ...GENERAL])];
}
