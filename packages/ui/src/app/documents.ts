import {
  ENGLISH,
  parseGuide,
  parseStep,
  type Guide,
  type GuideStep,
  type StepWording,
} from "@amluto-steps/core";

import type { EditorDoc } from "../editor/document";
import { sortSteps } from "../editor/document";

export type { GuideRef } from "../library-bridge";

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
