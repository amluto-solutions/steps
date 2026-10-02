import { foldForSearch, withoutTypedValue } from "@amluto-steps/core";

/**
 * Searching guides' wording, as the desktop does (`library/src/search.rs`): a guide matches when
 * every word of the query is somewhere in its card (title, tags, owner) or its wording, and the
 * first word the card doesn't explain says where it was found.
 */

export interface SearchHit {
  guideId: string;
  foundIn: { stepNumber: number | null; snippet: string } | null;
}

export interface Passage {
  stepNumber: number | null;
  text: string;
}

type Json = Record<string, unknown>;

const MAX_QUERY_WORDS = 12;
const SNIPPET_LENGTH = 90;
const SNIPPET_LEAD = 30;

export const queryWords = (query: string) =>
  query.split(/\s+/).filter(Boolean).slice(0, MAX_QUERY_WORDS).map(foldForSearch);

const str = (value: unknown) => (typeof value === "string" ? value : "");
const obj = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

/** Every `text` in a rich-text document, depth first, joined with spaces. */
export function richText(node: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown) => {
    const record = obj(value);
    if (typeof record.text === "string") parts.push(record.text);
    if (Array.isArray(record.content)) record.content.forEach(walk);
  };
  walk(node);
  return parts.join(" ");
}

export const cardText = (guide: Json) =>
  foldForSearch(
    `${str(guide.title)} ${(Array.isArray(guide.tags) ? guide.tags.filter((tag) => typeof tag === "string") : []).join(" ")} ${str(guide.owner)}`,
  );

/** A step's wording as people see it: a hidden typed value is left out. */
function visibleWording(step: Json, wording = str(step.actionText)): string {
  const value = obj(step.textParts).value;
  return step.showValue !== true && typeof value === "string"
    ? withoutTypedValue(wording, value)
    : wording;
}

function passages(guide: Json, steps: Json[]): Passage[] {
  const found: Passage[] = [];
  const push = (stepNumber: number | null, text: string) => {
    if (text.trim()) found.push({ stepNumber, text });
  };
  push(null, str(guide.description));
  push(null, richText(guide.intro));
  let number = 0;
  for (const step of steps) {
    if (step.kind === "interaction") {
      number += 1;
      push(number, visibleWording(step));
      push(number, richText(step.notes));
      push(number, str(obj(step.code).text));
    } else if (typeof step.block === "object" && step.block !== null) {
      const block = obj(step.block);
      push(null, str(block.heading));
      push(null, richText(block.body));
    }
  }
  push(null, richText(guide.outro));
  // The words written in other languages, after the main language's so a snippet prefers it
  // (docs/spec/04-editor.md#languages): a German search finds the German.
  for (const words of translations(guide)) {
    push(null, str(words.title));
    push(null, str(words.description));
    push(null, richText(words.intro));
    push(null, richText(words.outro));
  }
  number = 0;
  for (const step of steps) {
    const interaction = step.kind === "interaction";
    if (interaction) number += 1;
    for (const words of translations(step)) {
      // A hidden typed value is left out of every language's wording, as of the main one.
      push(interaction ? number : null, visibleWording(step, str(words.actionText)));
      push(interaction ? number : null, richText(words.notes));
      push(interaction ? number : null, str(words.heading));
      push(interaction ? number : null, richText(words.body));
    }
  }
  return found;
}

/** A guide's or step's words in other languages, by language code in a fixed order. */
const translations = (value: Json): Json[] =>
  Object.entries(obj(value.translations))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, words]) => obj(words));

const flatten = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** Up to 90 characters around the match, with "…" where text was cut. */
export function snippet(text: string, word: string): string {
  const flat = flatten(text);
  const points = Array.from(flat);
  if (points.length <= SNIPPET_LENGTH) return flat;
  const at = foldForSearch(flat).indexOf(word);
  const centre = at < 0 ? 0 : Array.from(flat.slice(0, at)).length;
  let start = Math.max(centre - SNIPPET_LEAD, 0);
  const end = Math.min(start + SNIPPET_LENGTH, points.length);
  start = Math.max(end - SNIPPET_LENGTH, 0);
  const cut = points.slice(start, end).join("").trim();
  return `${start > 0 ? "…" : ""}${cut}${end < points.length ? "…" : ""}`;
}

/** What a search looks through in one guide: kept by a shared library while its files are unchanged. */
export interface SearchText {
  /** The card's title, tags and owner, lower case. */
  card: string;
  passages: Passage[];
  /** The card and every passage, lower case. */
  everything: string;
}

export function searchText(guide: Json, steps: Json[]): SearchText {
  const card = cardText(guide);
  const found = passages(guide, steps);
  return {
    card,
    passages: found,
    everything: [card, ...found.map((passage) => foldForSearch(passage.text))].join("\n"),
  };
}

/** Whether a guide's wording matches, and where; null when it doesn't. */
export function matchText(guideId: string, text: SearchText, words: string[]): SearchHit | null {
  if (words.length === 0) return null;
  if (!words.every((word) => text.everything.includes(word))) return null;
  const word = words.find((each) => !text.card.includes(each));
  if (word === undefined) return { guideId, foundIn: null };
  const passage = text.passages.find((each) => foldForSearch(flatten(each.text)).includes(word));
  return {
    guideId,
    foundIn: passage
      ? { stepNumber: passage.stepNumber, snippet: snippet(passage.text, word) }
      : null,
  };
}

/** Whether a guide matches, and where; null when it doesn't. */
export const searchGuide = (guideId: string, guide: Json, steps: Json[], words: string[]) =>
  words.length === 0 ? null : matchText(guideId, searchText(guide, steps), words);
