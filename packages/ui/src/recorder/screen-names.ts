import {
  namingOfStep,
  withScreenWords,
  wordStepIn,
  type Box,
  type GuideStep,
} from "@amluto-steps/core";

import { reviewReason } from "../editor/edits";
import { clickPointOf, type ScreenWords } from "../screen-words";
import type { StepWording } from "@amluto-steps/core";

/** The longest naming from screenshots may hold up a recording opening, in all. */
const BUDGET_MS = 8_000;

/**
 * Clicks the app didn't name, named from the words in their screenshot at the click
 * (01/10/2026): Windows Settings on some Windows builds tells UI Automation nothing (F016), and
 * many apps name icons poorly. The words go through the click naming module and the step stores
 * the naming, so rewording the guide keeps the name (06/10/2026: it used to turn back into
 * "Click in <window>"). Such a step still asks to be checked, as "check this name", since text
 * recognition misreads. One with no readable word near the click, or whose screenshot couldn't
 * be read, stays unnamed. Words under the step's blur never name it.
 */
export async function nameFromScreen(
  steps: GuideStep[],
  words: ScreenWords,
  wording: StepWording,
  /** Each click step's element outline (from its fact), by step id. */
  outlines: ReadonlyMap<string, Box> = new Map(),
): Promise<GuideStep[]> {
  const started = Date.now();
  const named: GuideStep[] = [];
  for (const step of steps) {
    const mediaId = step.media?.id;
    const at = clickPointOf(step.highlight);
    if (
      Date.now() - started > BUDGET_MS ||
      step.action !== "click" ||
      reviewReason(step) !== "unnamed" ||
      !mediaId ||
      !at
    ) {
      named.push(step);
      continue;
    }
    const lines = await words.wordsOf(step);
    const naming =
      lines === "unavailable"
        ? null
        : withScreenWords(namingOfStep(step), { lines, ...at, element: outlines.get(step.id) });
    // Worded from the naming, as rewording will word it: a right-click stays one.
    const actionText =
      naming?.source === "screen"
        ? wordStepIn({ ...step, naming }, wording.language, wording.tone)
        : null;
    named.push(
      naming && actionText
        ? {
            ...step,
            naming,
            actionText,
            textParts: { ...step.textParts, target: naming.name },
            reviewRequired: true,
          }
        : step,
    );
  }
  return named;
}
