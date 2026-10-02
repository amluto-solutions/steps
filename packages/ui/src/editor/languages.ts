import {
  mainLanguage,
  toneOf,
  wordStepIn,
  writeGuideText,
  writeStepText,
  type Block,
  type Guide,
  type GuideStep,
  type GuideText,
  type RichText,
  type StepText,
  type Tone,
} from "@amluto-steps/core";

import type { Change, Edit, EditorDoc } from "./document";
import { setStepNotes, setStepText, updateGuide, updateStep, type Stamp } from "./edits";

/**
 * Editing in the language the editor is showing (docs/spec/04-editor.md#languages): in the guide's
 * main language an edit changes the guide's own fields, as it always has; in any other it writes
 * that language's words beside them, leaving the main language as it was.
 */

const isMain = (doc: EditorDoc, language: string) => language === mainLanguage(doc.guide);

/** `record` without `key` (a language's words, or one of them). */
const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

const stepNamed = (doc: EditorDoc, id: string) => doc.steps.find((step) => step.id === id) ?? null;

/** Writes `patch` as a step's words in `language` (not the main one). */
const writeStep = (
  doc: EditorDoc,
  id: string,
  language: string,
  patch: StepText,
  label: string,
  stamp: Stamp,
  coalesceKey: string,
): Edit | null => {
  const step = stepNamed(doc, id);
  if (!step) return null;
  return updateStep(
    doc,
    id,
    { translations: writeStepText(step, language, patch).translations },
    label,
    stamp,
    `${coalesceKey}:${language}`,
  );
};

/** A step's wording, in the language shown. */
export const setStepTextIn = (
  doc: EditorDoc,
  id: string,
  text: string,
  language: string,
  stamp: Stamp,
): Edit | null =>
  isMain(doc, language)
    ? setStepText(doc, id, text, stamp)
    : writeStep(doc, id, language, { actionText: text }, "edit step text", stamp, `text:${id}`);

/** A step's notes, in the language shown. */
export const setStepNotesIn = (
  doc: EditorDoc,
  id: string,
  notes: RichText | null,
  language: string,
  stamp: Stamp,
): Edit | null =>
  isMain(doc, language)
    ? setStepNotes(doc, id, notes, stamp)
    : writeStep(doc, id, language, { notes }, "edit note", stamp, `notes:${id}`);

/** A step's alt text, in the language shown. */
export const setAltTextIn = (
  doc: EditorDoc,
  id: string,
  altText: string | null,
  language: string,
  label: string,
  stamp: Stamp,
): Edit | null =>
  isMain(doc, language)
    ? updateStep(doc, id, { altText }, label, stamp, `alt:${id}`)
    : writeStep(doc, id, language, { altText }, label, stamp, `alt:${id}`);

/** A block's heading and body, in the language shown (its kind is the same in every language). */
export function setBlockIn(
  doc: EditorDoc,
  id: string,
  block: Block,
  language: string,
  label: string,
  stamp: Stamp,
  coalesceKey: string,
): Edit | null {
  if (isMain(doc, language)) return updateStep(doc, id, { block }, label, stamp, coalesceKey);
  const step = stepNamed(doc, id);
  if (!step?.block) return null;
  // A change of kind (a note to a warning, say) is the block's own, whatever language is shown.
  if (block.type !== step.block.type)
    return updateStep(doc, id, { block: { ...step.block, type: block.type } }, label, stamp);
  return writeStep(
    doc,
    id,
    language,
    { heading: block.heading, body: block.body },
    label,
    stamp,
    coalesceKey,
  );
}

/** The guide's title, description, intro or outro, in the language shown. */
export function updateGuideIn(
  doc: EditorDoc,
  patch: GuideText,
  language: string,
  label: string,
  stamp: Stamp,
  coalesceKey?: string,
): Edit {
  if (isMain(doc, language)) {
    const own: Partial<Omit<Guide, "id">> = {};
    if (patch.title !== undefined) own.title = patch.title;
    if (patch.description !== undefined) own.description = patch.description;
    if (patch.intro !== undefined) own.intro = patch.intro;
    if (patch.outro !== undefined) own.outro = patch.outro;
    return updateGuide(doc, own, label, stamp, coalesceKey);
  }
  return updateGuide(
    doc,
    { translations: writeGuideText(doc.guide, language, patch).translations },
    label,
    stamp,
    coalesceKey && `${coalesceKey}:${language}`,
  );
}

// ----- Language and tone: rewording the whole guide -----

/** What changing a guide's language or tone does to one step. */
export interface Rewording {
  step: GuideStep;
  /** Its words now, and after. */
  before: string;
  after: string;
  /**
   * `change`: worked out afresh; `same`: already reads that way; `edited`: changed by hand, so
   * left alone unless chosen; `none`: nothing to reword (a block, a picture, a blank step).
   */
  status: "change" | "same" | "edited" | "none";
}

/** Every step's words in `language` and `tone`, for the Language and tone preview. */
export function rewordings(doc: EditorDoc, language: string, tone: Tone): Rewording[] {
  return doc.steps.map((step) => {
    const before = step.actionText;
    const worded = step.kind === "block" ? null : wordStepIn(step, language, tone);
    if (worded === null) return { step, before, after: before, status: "none" };
    if (step.textEdited) return { step, before, after: worded, status: "edited" };
    return { step, before, after: worded, status: worded === before ? "same" : "change" };
  });
}

/**
 * Changes a guide's main language or tone (or both) and rewords the steps chosen, as one edit
 * (docs/spec/04-editor.md#language-and-tone). A step changed by hand that's chosen loses its
 * "changed by hand" mark, as its words are worked out again.
 *
 * Changing the main language swaps the guide's own words with that language's, where someone wrote
 * them: they become the main words, and the old main words are kept as the old language's, so
 * nothing written is lost and switching back restores it.
 */
export function changeLanguageAndTone(
  doc: EditorDoc,
  language: string,
  tone: Tone,
  reword: ReadonlySet<string>,
  stamp: Stamp,
): Edit | null {
  const fromLanguage = mainLanguage(doc.guide);
  const switching = language !== fromLanguage;
  if (!switching && tone === toneOf(doc.guide) && reword.size === 0) return null;
  const changes: Change[] = [];
  const at = new Date(stamp.at).toISOString();

  const guide = switching ? swapGuide(doc, fromLanguage, language) : { ...doc.guide };
  changes.push({
    kind: "guide",
    before: doc.guide,
    after: { ...guide, language, tone, updatedAt: at, updatedBy: stamp.by },
  });

  for (const step of doc.steps) {
    let after = switching ? swapStep(step, fromLanguage, language) : step;
    if (reword.has(step.id)) {
      const worded = wordStepIn(step, language, tone);
      if (worded !== null) {
        after = { ...after, actionText: worded, textEdited: false };
        // Its words are worked out in every language now, so a written one would hide them.
        const own = after.translations?.[language];
        if (own?.actionText !== undefined)
          after = {
            ...after,
            translations: {
              ...after.translations,
              [language]: without(own as Record<string, unknown>, "actionText") as StepText,
            },
          };
      }
    }
    if (after !== step)
      changes.push({
        kind: "step",
        id: step.id,
        before: step,
        after: { ...after, updatedAt: at, updatedBy: stamp.by },
      });
  }
  return { label: "language and tone", changes, at: stamp.at };
}

/**
 * Only what was written in `to` changes places: each such field's main words move under `from`, and
 * `to`'s become the main ones. A field `to` never had stays as it is, with nothing moved, so words
 * are never filed under a language they aren't in.
 */
const has = (text: object | undefined, field: string) =>
  text !== undefined && Object.prototype.hasOwnProperty.call(text, field);

/** Merges `ours` into `from`'s words and drops `to`'s, which have become the main ones. */
function swapped<T extends object>(
  translations: Record<string, T> | undefined,
  from: string,
  to: string,
  ours: T,
): Record<string, T> {
  const kept = { ...translations };
  if (Object.keys(ours).length > 0) kept[from] = { ...kept[from], ...ours } as T;
  return without(kept, to);
}

/** The guide's title, description, intro and outro, swapped where `to` has its own. */
function swapGuide(doc: EditorDoc, from: string, to: string): Guide {
  const guide = doc.guide;
  const theirs = guide.translations?.[to];
  if (!theirs) return guide;
  const next: Guide = { ...guide };
  const ours: GuideText = {};
  if (has(theirs, "title") && theirs.title !== undefined) {
    ours.title = guide.title;
    next.title = theirs.title;
  }
  if (has(theirs, "description") && theirs.description !== undefined) {
    ours.description = guide.description;
    next.description = theirs.description;
  }
  if (has(theirs, "intro")) {
    ours.intro = guide.intro;
    next.intro = theirs.intro ?? null;
  }
  if (has(theirs, "outro")) {
    ours.outro = guide.outro;
    next.outro = theirs.outro ?? null;
  }
  next.translations = swapped(guide.translations, from, to, ours);
  return next;
}

/** A step's words, notes, alt text and block, swapped where `to` has its own. */
function swapStep(step: GuideStep, from: string, to: string): GuideStep {
  const theirs = step.translations?.[to];
  if (!theirs) return step;
  const next: GuideStep = { ...step };
  const ours: StepText = {};
  if (theirs.actionText !== undefined) {
    // Words worked out from what was recorded aren't kept: they're worked out in any language.
    if (step.textEdited) ours.actionText = step.actionText;
    next.actionText = theirs.actionText;
    next.textEdited = true;
  }
  if (has(theirs, "notes")) {
    ours.notes = step.notes;
    next.notes = theirs.notes ?? null;
  }
  if (has(theirs, "altText")) {
    ours.altText = step.altText;
    next.altText = theirs.altText ?? null;
  }
  if (step.block) {
    const block = { ...step.block };
    if (theirs.heading !== undefined) {
      ours.heading = step.block.heading;
      block.heading = theirs.heading;
    }
    if (has(theirs, "body")) {
      ours.body = step.block.body;
      block.body = theirs.body ?? null;
    }
    next.block = block;
  }
  next.translations = swapped(step.translations, from, to, ours);
  return next;
}
