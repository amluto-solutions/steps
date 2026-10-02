/**
 * Which characters a font has (its `cmap` table), so a PDF in Japanese, Greek or Polish is set in
 * a font that can show it (docs/spec/05-export.md#languages). Word and the web page leave that to
 * the reader's PC, which falls back by itself; a PDF carries its fonts, so it must be right.
 */

const u16 = (view: DataView, at: number) => view.getUint16(at);
const u32 = (view: DataView, at: number) => view.getUint32(at);

/** The code points a TrueType font maps (formats 4 and 12, Unicode subtables), or null if unread. */
export function fontCodePoints(bytes: Uint8Array): Set<number> | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = u16(view, 4);
    let cmap = -1;
    for (let index = 0; index < tables; index += 1) {
      const record = 12 + index * 16;
      if (String.fromCharCode(...bytes.subarray(record, record + 4)) === "cmap")
        cmap = u32(view, record + 8);
    }
    if (cmap < 0) return null;
    const subtables = u16(view, cmap + 2);
    const offsets: number[] = [];
    for (let index = 0; index < subtables; index += 1) {
      const record = cmap + 4 + index * 8;
      const platform = u16(view, record);
      const encoding = u16(view, record + 2);
      // Unicode (platform 0), or Windows' Unicode BMP (3, 1) and full repertoire (3, 10).
      if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))
        offsets.push(cmap + u32(view, record + 4));
    }
    const points = new Set<number>();
    for (const at of offsets) {
      const format = u16(view, at);
      if (format === 4) {
        const segments = u16(view, at + 6) / 2;
        const ends = at + 14;
        const starts = ends + segments * 2 + 2;
        for (let index = 0; index < segments; index += 1) {
          const end = u16(view, ends + index * 2);
          const start = u16(view, starts + index * 2);
          // 0xFFFF ends the table; it maps nothing.
          for (let point = start; point <= end && point !== 0xffff; point += 1) points.add(point);
        }
      } else if (format === 12) {
        const groups = u32(view, at + 12);
        for (let index = 0; index < groups; index += 1) {
          const group = at + 16 + index * 12;
          const start = u32(view, group);
          const end = Math.min(u32(view, group + 4), start + 0x30000);
          for (let point = start; point <= end; point += 1) points.add(point);
        }
      }
    }
    return points.size > 0 ? points : null;
  } catch {
    return null;
  }
}

/** The characters of `text` a font must have: everything past plain ASCII, once each. */
export function charactersOf(text: string): number[] {
  const found = new Set<number>();
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    // Plain ASCII is in every font; joiners and selectors don't need glyphs of their own.
    if (point > 0x7e && !(point >= 0xfe00 && point <= 0xfe0f) && point !== 0x200d) found.add(point);
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
