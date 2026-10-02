import type { Guide, GuideStep, GuideText, RichText, StepText } from "./guide.ts";
import { DEFAULT_LANGUAGE } from "./languages.ts";
import { DEFAULT_TONE, wordStepIn, type Tone } from "./step-text/phrase.ts";

/**
 * A guide in any of Steps' languages (docs/spec/03-data-and-sharing.md#languages,
 * 01/10/2026). Each guide has a main language, which its own fields hold. Other languages hold
 * only what someone wrote in them (`translations`); a recorded step's wording is worked out in
 * that language from what was recorded, unless it was changed by hand; anything else shows the
 * main language and counts as not written yet.
 */

/** The language a guide's own fields are in: English for guides from before languages. */
export const mainLanguage = (guide: Pick<Guide, "language">): string =>
  guide.language ?? DEFAULT_LANGUAGE;

export const toneOf = (guide: Pick<Guide, "tone">): Tone => guide.tone ?? DEFAULT_TONE;

/** Where a text shown in a language comes from. */
export type TextSource =
  /** The main language's own field. */
  | "main"
  /** Written in that language by someone. */
  | "written"
  /** A recorded step's wording, worked out in that language. */
  | "worded"
  /** Not written in that language yet: the main language shows. */
  | "missing";

export type GuideField = keyof GuideText;
export type StepField = keyof StepText;

/** A text not written in a language yet: the guide's own (`stepId` null) or a step's. */
export interface MissingText {
  stepId: string | null;
  field: GuideField | StepField;
}

/** Whether rich text holds any words (an empty note needs no translation). */
export const hasWords = (rich: RichText | null | undefined): boolean =>
  Boolean(rich) &&
  (Boolean(rich?.text?.trim()) || (rich?.content ?? []).some((node) => hasWords(node)));

const has = <T extends object>(text: T | undefined, field: keyof T) =>
  text !== undefined && Object.prototype.hasOwnProperty.call(text, field);

/** A guide's title, description, intro and outro in `language`, and where each came from. */
export function guideIn(
  guide: Guide,
  language: string,
): { guide: Guide; sources: Record<GuideField, TextSource> } {
  if (language === mainLanguage(guide))
    return {
      guide,
      sources: { title: "main", description: "main", intro: "main", outro: "main" },
    };
  const text = guide.translations?.[language];
  const pick = <K extends GuideField>(field: K, empty: boolean): [Guide[K], TextSource] =>
    has(text, field)
      ? [(text as GuideText)[field] as Guide[K], "written"]
      : [guide[field], empty ? "main" : "missing"];
  const [title, titleFrom] = pick("title", !guide.title.trim());
  const [description, descriptionFrom] = pick("description", !guide.description.trim());
  const [intro, introFrom] = pick("intro", !hasWords(guide.intro));
  const [outro, outroFrom] = pick("outro", !hasWords(guide.outro));
  return {
    guide: { ...guide, title, description, intro, outro },
    sources: { title: titleFrom, description: descriptionFrom, intro: introFrom, outro: outroFrom },
  };
}

/** A step's words, notes, alt text and block in `language`, and where each came from. */
export function stepIn(
  step: GuideStep,
  language: string,
  guide: Pick<Guide, "language" | "tone">,
): { step: GuideStep; sources: Partial<Record<StepField, TextSource>> } {
  if (language === mainLanguage(guide)) return { step, sources: {} };
  const text = step.translations?.[language];
  const sources: Partial<Record<StepField, TextSource>> = {};
  const localized: GuideStep = { ...step };

  if (step.kind !== "block") {
    if (has(text, "actionText")) {
      localized.actionText = text?.actionText ?? "";
      sources.actionText = "written";
    } else {
      const worded = step.textEdited ? null : wordStepIn(step, language, toneOf(guide));
      if (worded !== null) {
        localized.actionText = worded;
        sources.actionText = "worded";
      } else sources.actionText = step.actionText.trim() ? "missing" : "main";
    }
  }
  if (has(text, "notes")) {
    localized.notes = text?.notes ?? null;
    sources.notes = "written";
  } else sources.notes = hasWords(step.notes) ? "missing" : "main";
  if (has(text, "altText")) {
    localized.altText = text?.altText ?? null;
    sources.altText = "written";
  } else sources.altText = step.altText?.trim() ? "missing" : "main";
  if (step.block) {
    const block = { ...step.block };
    if (has(text, "heading")) {
      block.heading = text?.heading ?? "";
      sources.heading = "written";
    } else sources.heading = step.block.heading.trim() ? "missing" : "main";
    if (has(text, "body")) {
      block.body = text?.body ?? null;
      sources.body = "written";
    } else sources.body = hasWords(step.block.body) ? "missing" : "main";
    localized.block = block;
  }
  return { step: localized, sources };
}

/**
 * A whole guide in `language`, as exports and the editor's "Showing" switch use it, with the texts
 * not written in it yet (in the guide's order: its own first, then each step's).
 */
export function docIn<D extends { guide: Guide; steps: GuideStep[] }>(
  doc: D,
  language: string,
): { doc: D; missing: MissingText[] } {
  const own = guideIn(doc.guide, language);
  const missing: MissingText[] = [];
  for (const field of ["title", "description", "intro", "outro"] as const)
    if (own.sources[field] === "missing") missing.push({ stepId: null, field });
  const steps = doc.steps.map((step) => {
    const shown = stepIn(step, language, doc.guide);
    for (const [field, source] of Object.entries(shown.sources))
      if (source === "missing") missing.push({ stepId: step.id, field: field as StepField });
    return shown.step;
  });
  return { doc: { ...doc, guide: own.guide, steps }, missing };
}

/** The languages a guide has anything written in, besides its main one. */
export function writtenLanguages(doc: { guide: Guide; steps: GuideStep[] }): string[] {
  const found = new Set(Object.keys(doc.guide.translations ?? {}));
  for (const step of doc.steps)
    for (const language of Object.keys(step.translations ?? {})) found.add(language);
  found.delete(mainLanguage(doc.guide));
  return [...found].sort();
}

/** A step with `patch` written in `language` (not the main one: that's the step's own fields). */
export function writeStepText(step: GuideStep, language: string, patch: StepText): GuideStep {
  const current = step.translations?.[language] ?? {};
  return {
    ...step,
    translations: { ...step.translations, [language]: { ...current, ...patch } },
  };
}

/** A guide with `patch` written in `language` (not its main one). */
export function writeGuideText(guide: Guide, language: string, patch: GuideText): Guide {
  const current = guide.translations?.[language] ?? {};
  return {
    ...guide,
    translations: { ...guide.translations, [language]: { ...current, ...patch } },
  };
}
