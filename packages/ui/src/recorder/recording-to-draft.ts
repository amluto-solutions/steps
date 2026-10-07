import {
  compareSortKeys,
  parseStep,
  type Box,
  type GuideStep,
  type RecordedStep,
  type RecordingFact,
  type RecordingSettings,
  type StepWording,
} from "@amluto-steps/core";

import { sortSteps } from "../editor/document";
import {
  applyDrags,
  borrowScreenshots,
  captureSequenceOf,
  captureStepId,
  dropReplacedValues,
  dropTrailingOpens,
  factToStep,
  orderRecordedSteps,
} from "../recorded-step";
import type { ScreenWords } from "../screen-words";
import { nameFromScreen } from "./screen-names";

/** A recording as its journal and the window showing it hold it. */
export interface RecordingData {
  /** The recorder's facts: the journal's, and any more the window showing it has seen. */
  facts: readonly RecordingFact[];
  /**
   * Steps journalled as the recording ran: each fact's step as it was built live, the shortcuts
   * shown with the popup (which have no step of their own in the facts), and the author.
   */
  saved: readonly RecordedStep[];
  /**
   * Steps that reached this window another way (the shortcut popup's) and may not be journalled
   * yet. Never steps a window built from facts: those are made here, from the facts.
   */
  live: readonly RecordedStep[];
  /** "Start again": steps captured at or before this sequence are left out. */
  restart: number | null;
  /** The recording's own wording and settings, saved with it when it started. */
  wording: StepWording;
  settings: RecordingSettings;
  /**
   * The words on each step's screenshot, which name the clicks nothing else named; null while
   * recording, when reading them would slow every click.
   */
  words: ScreenWords | null;
}

/** A recording's steps, in order, and how many were left out as unreadable. */
export interface DraftSteps {
  steps: GuideStep[];
  skipped: number;
}

/** Steps from several sources, once each (a later source's copy wins), in sort-key order. */
const merged = (...groups: (readonly RecordedStep[])[]): RecordedStep[] => {
  const byId = new Map<string, RecordedStep>();
  for (const group of groups) for (const step of group) byId.set(step.id, step);
  return [...byId.values()].sort(
    (left, right) =>
      compareSortKeys(left.sortKey, right.sortKey) || compareSortKeys(left.id, right.id),
  );
};

/** The steps "Start again" kept: those captured after the restart point, and any not captured. */
const afterRestart = (steps: RecordedStep[], restart: number | null) =>
  restart === null
    ? steps
    : steps.filter((step) => (captureSequenceOf(step.id) ?? Number.MAX_SAFE_INTEGER) > restart);

/**
 * A recording's steps (docs/spec/02-capture.md#recording-to-draft): the steps shown while it
 * records, and the draft it opens as, both come from here, so the two can't disagree.
 *
 * The passes run in one order, each needing the one before: every fact's step merged with the
 * journalled and live ones, after "Start again"; a field's value a later read replaced dropped;
 * a drag in place of the click it began with; steps journalled late put back where they happened;
 * "Open" steps trailing the end dropped; typing given the screenshot before it; then clicks
 * nothing named are named from their screenshots' words. A step that doesn't fit the format (say,
 * from before a limit existed) is left out and counted, rather than stopping the whole recording
 * from opening.
 */
export async function recordingToDraft(recording: RecordingData): Promise<DraftSteps> {
  const { facts, wording, settings, words } = recording;
  const fromFacts = facts
    .map((fact) => factToStep(fact, wording, settings))
    .filter((step): step is RecordedStep => step !== null);
  const all = afterRestart(merged(fromFacts, recording.saved, recording.live), recording.restart);
  const placed = orderRecordedSteps(applyDrags(dropReplacedValues(all, facts), facts), facts);
  const steps: GuideStep[] = [];
  let skipped = 0;
  for (const step of borrowScreenshots(dropTrailingOpens(placed))) {
    try {
      steps.push(parseStep(step));
    } catch {
      skipped += 1;
    }
  }
  // Each click's element outline, so an unnamed icon is named by its own label (07/10/2026).
  const outlines = new Map<string, Box>();
  for (const fact of facts)
    if (fact.record.kind === "click" && fact.record.elementPct)
      outlines.set(captureStepId(fact.sequence), fact.record.elementPct);
  const named = words ? await nameFromScreen(steps, words, wording, outlines) : steps;
  return { steps: sortSteps(named), skipped };
}
