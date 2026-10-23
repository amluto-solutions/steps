import {
  namingOfStep,
  withScreenWords,
  wordStepIn,
  type GuideStep,
  type ScreenEvidence,
} from "@amluto-steps/core";

import { reviewReason } from "../editor/edits";
import { clickPointOf, type ScreenWords } from "../screen-words";
import type { StepWording } from "@amluto-steps/core";

/**
 * What a click's fact says about its screenshot: the clicked element's outline, whether the
 * window clicked had gone before the picture was taken, and the items of a menu it landed in.
 */
export type ClickScreen = Pick<
  ScreenEvidence,
  "element" | "windowGone" | "menuItems" | "menuShowing"
>;

/** The longest naming from screenshots may hold up a recording opening, in all. */
const BUDGET_MS = 8_000;

/**
 * Clicks the app didn't name, named from the words in their screenshot at the click
 * (01/10/2026): Windows Settings on some Windows builds tells UI Automation nothing (F016), and
 * many apps name icons poorly. The words go through the click naming module and the step stores
 * the naming, so rewording the guide keeps the name (06/10/2026: it used to turn back into
 * "Click in <window>"). Such a step still asks to be checked, as "check this name", since text
 * recognition misreads. One with no readable word near the click, or whose screenshot couldn't
 * be read, stays unnamed. Words under the step's blur never name it, nor do the words of a
 * screenshot taken after the window clicked had gone (F019, #48). On a menu whose items were
 * read as it opened, the words pick out the item, whose own name the step takes, needing no check
 * (#56); with no words to go by, a menu still showing as the button went down names it by the item
 * whose box holds the click (#106).
 */
export async function nameFromScreen(
  steps: GuideStep[],
  words: ScreenWords,
  wording: StepWording,
  /** What each click step's fact says about its screenshot, by step id. */
  screens: ReadonlyMap<string, ClickScreen> = new Map(),
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
    // A screenshot that couldn't be read has no words, but a menu still showing under the press
    // names the click by the item under it all the same (#106).
    const naming = withScreenWords(namingOfStep(step), {
      lines: lines === "unavailable" ? [] : lines,
      ...at,
      ...screens.get(step.id),
    });
    // Worded from the naming, as rewording will word it: a right-click stays one.
    const actionText =
      naming?.source === "screen" || naming?.source === "menu"
        ? wordStepIn({ ...step, naming }, wording.language, wording.tone)
        : null;
    named.push(
      naming && actionText
        ? {
            ...step,
            naming,
            actionText,
            textParts: { ...step.textParts, target: naming.name },
            reviewRequired: naming.needsReview,
          }
        : step,
    );
  }
  return named;
}
