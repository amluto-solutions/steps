import { phraseFor, renderPhrase } from "./phrase.ts";
import type { StepAction, StepTarget } from "./types.ts";

/**
 * The words a step reads (docs/spec/02-capture.md#step-wording), from what was done and the facts
 * about the element it was done to: `Click "Save"`, `Type "Acme" in "Customer" field`,
 * `Press "Ctrl+S"`. This is the English casual wording Steps has always written; other languages
 * and tones go through the phrase they share (`phrase.ts`).
 */

export { QUOTE_LIMIT, shorten } from "./phrase.ts";

/**
 * A step's words, or undefined when nothing names what was done (the recorder then words it
 * from the window or the screenshot). `typed` is free typing with no field; `keys` a combination.
 */
export function wordStep(
  action: StepAction,
  target?: StepTarget | null,
  typed?: string | null,
  keys?: string | null,
): string | undefined {
  const phrase = phraseFor(action, target, typed, keys);
  return phrase && renderPhrase(phrase, "en", "casual");
}
