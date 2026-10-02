import type { GuideStep } from "@amluto-steps/core";

import type { Change, EditorDoc, Edit } from "./document";
import type { Stamp } from "./edits";

/** One "Tidy guide" suggestion (docs/spec/04-editor.md#tidy-guide). */
export interface TidySuggestion {
  id: string;
  kind: "mergeClickIntoTyping" | "removeDoubleClick" | "removeOpenApp" | "removeRedirect";
  /** The steps it touches, for showing in the list. */
  stepIds: string[];
  changes: Change[];
}

/** Clicks this close together on the same thing are one click, not two. */
const DOUBLE_CLICK_MS = 1500;
/** "Go to" steps this close together, with nothing between, are one link passing through redirects. */
const REDIRECT_MS = 10_000;

const time = (step: GuideStep) => Date.parse(step.capturedAt);
const sameTarget = (left: GuideStep, right: GuideStep) =>
  left.textParts.target !== "" &&
  left.textParts.target.toLowerCase() === right.textParts.target.toLowerCase();
const isAppSwitch = (step: GuideStep) => step.action === "appswitch";

/**
 * Suggestions for a recorded guide, each independent and each one undo step when applied. Only
 * steps nobody has reworded are touched, so hand edits are never tidied away.
 */
export function tidySuggestions(doc: EditorDoc, stamp: Stamp): TidySuggestion[] {
  const suggestions: TidySuggestion[] = [];
  const at = new Date(stamp.at).toISOString();
  const steps = doc.steps.filter((step) => step.kind === "interaction");
  for (let index = 0; index < steps.length - 1; index += 1) {
    const step = steps[index];
    const next = steps[index + 1];
    if (!step || !next || step.textEdited || next.textEdited) continue;

    // A click into a field, then typing into that field: one step, "Type … in …".
    if (step.action === "click" && next.action === "input" && sameTarget(step, next)) {
      // Everything drawn on a screenshot travels with it: keeping the click's picture without its
      // blur would export what the user hid.
      const picture = next.media ? next : step;
      const merged: GuideStep = {
        ...next,
        media: picture.media,
        highlight: picture.highlight,
        crop: picture.crop,
        redactions: picture.redactions,
        annotations: picture.annotations,
        altText: next.altText ?? step.altText,
        notes: next.notes ?? step.notes,
        updatedAt: at,
        updatedBy: stamp.by,
      };
      suggestions.push({
        id: `merge:${step.id}`,
        kind: "mergeClickIntoTyping",
        stepIds: [step.id, next.id],
        changes: [
          { kind: "step", id: step.id, before: step, after: null },
          { kind: "step", id: next.id, before: next, after: merged },
        ],
      });
      index += 1;
      continue;
    }

    // The same click twice in quick succession.
    if (
      step.action === "click" &&
      next.action === "click" &&
      step.actionText === next.actionText &&
      Math.abs(time(next) - time(step)) <= DOUBLE_CLICK_MS
    ) {
      suggestions.push({
        id: `double:${next.id}`,
        kind: "removeDoubleClick",
        stepIds: [next.id],
        changes: [{ kind: "step", id: next.id, before: next, after: null }],
      });
      index += 1;
      continue;
    }

    // "Go to" one site and straight on to another in the same browser, with nothing done between:
    // a link passing through a link checker or sign-in page. Only where it ended up matters.
    if (
      step.action === "navigation" &&
      next.action === "navigation" &&
      step.context.app?.toLowerCase() === next.context.app?.toLowerCase() &&
      Math.abs(time(next) - time(step)) <= REDIRECT_MS
    ) {
      suggestions.push({
        id: `redirect:${step.id}`,
        kind: "removeRedirect",
        stepIds: [step.id],
        changes: [{ kind: "step", id: step.id, before: step, after: null }],
      });
      continue;
    }

    // `Open "<app>"` straight before a click in that app says nothing the click doesn't.
    if (
      isAppSwitch(step) &&
      !isAppSwitch(next) &&
      step.context.app !== null &&
      step.context.app.toLowerCase() === next.context.app?.toLowerCase()
    ) {
      suggestions.push({
        id: `open:${step.id}`,
        kind: "removeOpenApp",
        stepIds: [step.id],
        changes: [{ kind: "step", id: step.id, before: step, after: null }],
      });
    }
  }
  return suggestions;
}

/** The chosen suggestions as a single edit, so one Undo takes them all back. */
export function applySuggestions(chosen: TidySuggestion[], stamp: Stamp): Edit | null {
  const changes = chosen.flatMap((suggestion) => suggestion.changes);
  if (changes.length === 0) return null;
  return { label: "tidy guide", changes, at: stamp.at };
}
