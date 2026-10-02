import {
  ENGLISH,
  compareSortKeys,
  parseGuide,
  parseStep,
  type Guide,
  type GuideStep,
  type RecordedStep,
  type StepWording,
} from "@amluto-steps/core";

import type { EditorDoc } from "../editor/document";
import { sortSteps } from "../editor/document";
import { captureSequenceOf } from "../recorded-step";

/** A guide in a library: the two ids always travel together. */
export interface GuideRef {
  libraryId: string;
  guideId: string;
}

/** Steps from several sources (recovered facts, saved steps, live ones), once each, in order. */
export const mergeRecordedSteps = (...groups: RecordedStep[][]): RecordedStep[] => {
  const byId = new Map<string, RecordedStep>();
  for (const group of groups) for (const step of group) byId.set(step.id, step);
  return [...byId.values()].sort(
    (left, right) =>
      compareSortKeys(left.sortKey, right.sortKey) || compareSortKeys(left.id, right.id),
  );
};

/** The steps "Start again" kept: those captured after the restart point. */
export const afterRestart = <T extends { id: string }>(steps: T[], restart: number | null) =>
  restart === null
    ? steps
    : steps.filter((step) => (captureSequenceOf(step.id) ?? Number.MAX_SAFE_INTEGER) > restart);

/** Reads a guide and its steps, leaving out step files that fail the schema (logged, not fatal). */
export function toDoc(raw: { guide: unknown; steps: unknown[] }): EditorDoc {
  const guide = parseGuide(raw.guide);
  const steps: GuideStep[] = [];
  for (const value of raw.steps) {
    try {
      steps.push(parseStep(value));
    } catch (problem) {
      console.error("A step file did not match the format and was left out.", problem);
    }
  }
  return { guide, steps: sortSteps(steps) };
}

/**
 * A new guide for a recording, owned and created by the person who recorded it, in the language
 * and tone its steps were worded in.
 */
export function newGuide(
  id: string,
  title: string,
  author: string,
  wording: StepWording = ENGLISH,
): Guide {
  const now = new Date().toISOString();
  return {
    id,
    title,
    description: "",
    intro: null,
    outro: null,
    brandProfileId: null,
    tags: [],
    owner: author,
    reviewBy: null,
    createdAt: now,
    createdBy: author,
    updatedAt: now,
    updatedBy: author,
    language: wording.language,
    tone: wording.tone,
    formatVersion: 1,
  };
}
