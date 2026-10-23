/**
 * Emoji in a PDF (docs/spec/05-export.md#emoji). A PDF carries its fonts, and no text font it
 * uses has emoji, so 🎉 printed as an empty box with `\x00` in its text layer (#89). Each emoji is
 * drawn from a monochrome emoji font instead, a run of its own in the text: pdfkit embeds only the
 * glyphs used, and keeps each one's characters, so the text layer reads the real emoji.
 */

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

const TEXT_SELECTOR = 0xfe0e;
const EMOJI_SELECTOR = 0xfe0f;
const JOINER = 0x200d;
const KEYCAP = 0x20e3;

const isRegionalIndicator = (point: number) => point >= 0x1f1e6 && point <= 0x1f1ff;
const isSkinTone = (point: number) => point >= 0x1f3fb && point <= 0x1f3ff;
/** The tag characters of a subdivision flag (🏴 England). */
const isTag = (point: number) => point >= 0xe0020 && point <= 0xe007f;
const isKeycapBase = (point: number) =>
  (point >= 0x30 && point <= 0x39) || point === 0x23 || point === 0x2a;
const isPictographic = (point: number) => PICTOGRAPHIC.test(String.fromCodePoint(point));

/**
 * Whether a character is part of an emoji: a pictograph, or a flag letter, skin tone, keycap or
 * tag. Plain ASCII never is (a keycap's digit only counts beside its keycap mark).
 */
export const isEmojiPoint = (point: number): boolean =>
  point > 0x7e &&
  (isPictographic(point) ||
    isRegionalIndicator(point) ||
    isSkinTone(point) ||
    isTag(point) ||
    point === KEYCAP);

/** A run of text: plain, or one emoji (its characters together, as one picture). */
export interface TextRun {
  text: string;
  emoji: boolean;
}

/** An emoji as typed: its first character, and whether it asks to be drawn as an emoji. */
export interface EmojiCluster {
  base: number;
  /** An emoji selector, a sequence (joined, skin tone, flag, keycap) or an emoji by default. */
  presentation: boolean;
}

/**
 * `text` in runs, each emoji its own: `drawn` says whether an emoji goes to the emoji font (one
 * that doesn't stays in the text around it). Text with no emoji drawn is one run, unchanged.
 */
export function emojiRuns(text: string, drawn: (cluster: EmojiCluster) => boolean): TextRun[] {
  const points = Array.from(text, (character) => character.codePointAt(0) ?? 0);
  const runs: TextRun[] = [];
  let plain = "";
  let index = 0;
  while (index < points.length) {
    const point = points[index] ?? 0;
    const next = points[index + 1];
    const keycap =
      isKeycapBase(point) &&
      (next === KEYCAP || (next === EMOJI_SELECTOR && points[index + 2] === KEYCAP));
    if (!keycap && !isPictographic(point) && !isRegionalIndicator(point)) {
      plain += String.fromCodePoint(point);
      index += 1;
      continue;
    }
    // The emoji's whole sequence: a flag's two letters, then selectors, skin tones, a keycap
    // mark, tags, and further pictographs joined on.
    let end = index + 1;
    let sequence = keycap;
    if (isRegionalIndicator(point) && isRegionalIndicator(points[end] ?? 0)) {
      end += 1;
      sequence = true;
    }
    let textSelector = false;
    let emojiSelector = false;
    for (;;) {
      const following = points[end] ?? 0;
      if (following === TEXT_SELECTOR) textSelector = true;
      else if (following === EMOJI_SELECTOR) emojiSelector = true;
      else if (following === KEYCAP || isSkinTone(following) || isTag(following)) sequence = true;
      else if (following === JOINER && isPictographic(points[end + 1] ?? 0)) {
        sequence = true;
        end += 1;
      } else break;
      end += 1;
    }
    const cluster = String.fromCodePoint(...points.slice(index, end));
    const presentation =
      !textSelector &&
      (emojiSelector ||
        sequence ||
        isRegionalIndicator(point) ||
        EMOJI_PRESENTATION.test(String.fromCodePoint(point)));
    if (drawn({ base: point, presentation })) {
      if (plain) runs.push({ text: plain, emoji: false });
      plain = "";
      runs.push({ text: cluster, emoji: true });
    } else plain += cluster;
    index = end;
  }
  if (plain || runs.length === 0) runs.push({ text: plain, emoji: false });
  return runs;
}

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decides which emoji go to the emoji font, given the text font they sit in. */
export type EmojiChoice = (cluster: EmojiCluster, family: string) => boolean;

/**
 * A PDF definition's content with each emoji `choose` picks in the emoji font, `font` (a pdfmake
 * family). Each text's family is followed as pdfmake does (its own `font`, its style's, or the
 * one around it), so a symbol only the heading font lacks is drawn from the emoji font only in
 * headings. `found` counts the emoji put in the emoji font.
 */
export function withEmojiFont(
  content: unknown,
  options: {
    choose: EmojiChoice;
    font: string;
    family: string;
    styles: Record<string, { font?: string | undefined } | undefined>;
  },
): { content: unknown; found: number } {
  let found = 0;
  const familyOf = (node: Node, around: string): string => {
    if (typeof node.font === "string") return node.font;
    const styles = Array.isArray(node.style) ? node.style : [node.style];
    let family = around;
    for (const style of styles)
      if (typeof style === "string") family = options.styles[style]?.font ?? family;
    return family;
  };
  /** One text's runs as pdfmake text items, each keeping `fields` (bold, a link…). */
  const items = (text: string, family: string, fields: Node): Node[] | null => {
    const runs = emojiRuns(text, (cluster) => options.choose(cluster, family));
    if (runs.length === 1 && !runs[0]?.emoji) return null;
    return runs.map((run) => {
      if (run.emoji) found += 1;
      return { ...fields, text: run.text, ...(run.emoji ? { font: options.font } : {}) };
    });
  };
  /**
   * A node's `text`: a string becomes items when it holds an emoji; an item becomes several
   * beside it (pdfmake drops an item's own fields when its text is a list).
   */
  const text = (value: unknown, family: string): unknown => {
    if (typeof value === "string") return items(value, family, {}) ?? value;
    if (!Array.isArray(value)) return value;
    return value.flatMap((item): unknown[] => {
      if (typeof item === "string") return items(item, family, {}) ?? [item];
      if (!isNode(item)) return [item];
      const inner = familyOf(item, family);
      if (typeof item.text === "string") return items(item.text, inner, item) ?? [item];
      return [{ ...item, text: text(item.text, inner) }];
    });
  };
  const walk = (value: unknown, family: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, family));
    if (typeof value === "string") {
      const split = items(value, family, {});
      return split ? { text: split } : value;
    }
    if (!isNode(value)) return value;
    const inner = familyOf(value, family);
    const node: Node = { ...value };
    if ("text" in node) node.text = text(node.text, inner);
    for (const list of ["stack", "columns", "ul", "ol"])
      if (Array.isArray(node[list])) node[list] = walk(node[list], inner);
    if (isNode(node.table) && Array.isArray(node.table.body))
      node.table = {
        ...node.table,
        body: (node.table.body as unknown[][]).map((row) => row.map((cell) => walk(cell, inner))),
      };
    return node;
  };
  return { content: walk(content, options.family), found };
}
