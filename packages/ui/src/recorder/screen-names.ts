import { renderPhrase, textAtPoint, type GuideStep, type OcrLine } from "@amluto-steps/core";

import { reviewReason } from "../editor/edits";
import type { StepWording } from "@amluto-steps/core";

/** The longest naming from screenshots may hold up a recording opening, in all. */
const BUDGET_MS = 8_000;

/**
 * Clicks the app didn't name, named from the words in their screenshot at the click
 * (01/10/2026): Windows Settings on some Windows builds tells UI Automation nothing (F016), and
 * many apps name icons poorly. A step named this way no longer asks to be checked; one with no
 * readable word near the click still does.
 */
export async function nameFromScreen(
  steps: GuideStep[],
  read: (mediaId: string) => Promise<OcrLine[] | null>,
  wording: StepWording,
): Promise<GuideStep[]> {
  const started = Date.now();
  const named: GuideStep[] = [];
  for (const step of steps) {
    const mediaId = step.media?.id;
    const mark = step.highlight;
    if (
      Date.now() - started > BUDGET_MS ||
      step.action !== "click" ||
      reviewReason(step) !== "unnamed" ||
      !mediaId ||
      !mark
    ) {
      named.push(step);
      continue;
    }
    const lines = await read(mediaId).catch(() => null);
    const name = lines ? textAtPoint(lines, mark.x + mark.w / 2, mark.y + mark.h / 2) : null;
    named.push(
      name
        ? {
            ...step,
            actionText: renderPhrase(
              { key: "click", kind: "other", name },
              wording.language,
              wording.tone,
            ),
            textParts: { ...step.textParts, target: name },
            reviewRequired: false,
          }
        : step,
    );
  }
  return named;
}
