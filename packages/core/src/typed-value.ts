import type { GuideStep } from "./guide.ts";
import { shorten } from "./step-text/wording.ts";

/** What a hidden typed value becomes in wording someone wrote by hand. */
export const HIDDEN_VALUE = "…";

/** Text as a pattern that matches it literally. */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quotation marks a value can sit between in wording, in any of Steps' languages. */
const QUOTES = `"“”„«»「」『』'`;
/** A value this long is also found by its start, in case the rest was edited (F028). */
const PREFIX_FROM = 24;
const PREFIX_CHARS = 20;

/** A value as a pattern: literal, except any run of spaces or line breaks matches any other. */
const flexible = (text: string) => escapeRegExp(text).replace(/\s+/g, "\\s+");

/**
 * A typed value wherever it appears in wording, in any case: in full, or shortened the way
 * generated wording shortens a long value ("its first 80 characters..."), with its spaces and
 * line breaks as they come. It must stand on its own, not inside a longer word, so hiding the
 * value "e" leaves "Customer name" alone. A long value is also found by its first 20 characters,
 * up to the quotation mark or line end after them: its wording may have been edited since, as
 * Find & Replace did to a file path (F028, 01/10/2026).
 */
function valuePattern(value: string | undefined): RegExp | null {
  const needle = value?.trim();
  if (!needle) return null;
  const shortened = shorten(needle);
  const forms = shortened === needle ? [needle] : [shortened, needle];
  const whole = `(?:${forms.map(flexible).join("|")})(?![\\p{L}\\p{N}])`;
  const start = [...needle].slice(0, PREFIX_CHARS).join("");
  const prefix =
    [...needle].length >= PREFIX_FROM ? `|${flexible(start)}[^${escapeRegExp(QUOTES)}\\r\\n]*` : "";
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${whole}${prefix})`, "giu");
}

/**
 * Takes a typed value out of a piece of wording, leaving "…" in its place
 * (docs/spec/04-editor.md, typed values). Used when a value is hidden or removed from
 * hand-edited wording, and by every export as the last safeguard.
 */
export function withoutTypedValue(text: string, value: string | undefined): string {
  const pattern = valuePattern(value);
  return pattern ? text.replace(pattern, HIDDEN_VALUE) : text;
}

/** Whether a step's wording contains its typed value (e.g. after the wording was edited). */
export function typedValueInText(step: Pick<GuideStep, "actionText" | "textParts">): boolean {
  return valuePattern(step.textParts.value)?.test(step.actionText) ?? false;
}

/**
 * The wording a reader may see: a typed value only when the step's "Show typed value" is on.
 * Exports use this, so a hidden value can't reach a PDF, Word file, web page or the clipboard
 * even if it survived in hand-edited wording.
 */
export function visibleStepText(
  step: Pick<GuideStep, "actionText" | "textParts" | "showValue">,
): string {
  return step.showValue
    ? step.actionText
    : withoutTypedValue(step.actionText, step.textParts.value);
}
