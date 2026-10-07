import {
  describeCommand,
  mainLanguage,
  phraseFor,
  renderPhrase,
  toneOf,
  escapeRegExp,
  mergeCode,
  keyBetween,
  spreadKeys,
  withoutTypedValue,
  type Block,
  type Guide,
  type GuideStep,
  type RichText,
  type StepCode,
  type StepTarget,
} from "@amluto-steps/core";

import type { Change, EditorDoc, Edit } from "./document";

/** Who made an edit and when, stamped onto every file it touches. */
export interface Stamp {
  at: number;
  by: string;
}

const iso = (stamp: Stamp) => new Date(stamp.at).toISOString();

const touched = (step: GuideStep, stamp: Stamp): GuideStep => ({
  ...step,
  updatedAt: iso(stamp),
  updatedBy: stamp.by,
});

const findStep = (doc: EditorDoc, id: string) => doc.steps.find((step) => step.id === id) ?? null;

/** The guide's language and tone, for wording a step again (docs/spec/04-editor.md#language-and-tone). */
const wordingOf = (doc: EditorDoc) => ({
  language: mainLanguage(doc.guide),
  tone: toneOf(doc.guide),
});

/** A typing step's words, in the guide's language and tone, or undefined if nothing names it. */
const typingWords = (doc: EditorDoc, target: StepTarget): string | undefined => {
  const phrase = phraseFor("input", target);
  const { language, tone } = wordingOf(doc);
  return phrase && renderPhrase(phrase, language, tone);
};

const edit = (label: string, changes: Change[], stamp: Stamp, coalesceKey?: string): Edit =>
  coalesceKey === undefined
    ? { label, changes, at: stamp.at }
    : { label, changes, at: stamp.at, coalesceKey };

const stepChange = (before: GuideStep | null, after: GuideStep | null): Change => ({
  kind: "step",
  id: (after ?? before)?.id ?? "",
  before,
  after,
});

/** Any field change on one step (highlight, annotations, blur, crop, alt text…). */
export function updateStep(
  doc: EditorDoc,
  id: string,
  patch: Partial<Omit<GuideStep, "id" | "sortKey">>,
  label: string,
  stamp: Stamp,
  coalesceKey?: string,
): Edit | null {
  const before = findStep(doc, id);
  if (!before) return null;
  return edit(
    label,
    [stepChange(before, touched({ ...before, ...patch }, stamp))],
    stamp,
    coalesceKey,
  );
}

/** Rewording by hand marks the step so "Reword all steps" leaves it alone. */
/**
 * Why a recorded step asks to be checked, so the editor names that one reason (F031).
 * `checkName`: a click named from its screenshot's words, which text recognition may misread.
 */
export type ReviewReason = "unnamed" | "checkName" | "missed" | "typing" | "code";

export function reviewReason(step: GuideStep): ReviewReason | null {
  if (!step.reviewRequired) return null;
  if (step.textParts.kind === "warning") return "missed";
  if (["command", "code", "formula"].includes(step.action)) return "code";
  if (step.action === "type") return "typing";
  if (step.action === "click" && step.naming?.source === "screen") return "checkName";
  return "unnamed";
}

/**
 * The wording, written by hand. A click that couldn't be named, or whose name was read from the
 * screenshot, has been named by the person now, so it no longer asks to be checked.
 */
export const setStepText = (doc: EditorDoc, id: string, text: string, stamp: Stamp) => {
  const step = findStep(doc, id);
  const reason = step && reviewReason(step);
  const named = reason === "unnamed" || reason === "checkName" ? { reviewRequired: false } : {};
  return updateStep(
    doc,
    id,
    { actionText: text, textEdited: true, ...named },
    "edit step text",
    stamp,
    `text:${id}`,
  );
};

/** "Looks right": the person has checked a flagged step. */
export const markChecked = (doc: EditorDoc, id: string, stamp: Stamp) =>
  updateStep(doc, id, { reviewRequired: false }, "mark step checked", stamp);

/**
 * A code step's code, language or output (docs/spec/04-editor.md#code-steps). Changing a
 * command's language rewords it ("Run in Command Prompt") unless the wording was edited by hand.
 */
export function setStepCode(
  doc: EditorDoc,
  id: string,
  patch: Partial<StepCode>,
  label: string,
  stamp: Stamp,
  coalesceKey?: string,
): Edit | null {
  const step = findStep(doc, id);
  if (!step?.code) return null;
  const code = { ...step.code, ...patch };
  const reword = step.action === "command" && !step.textEdited && patch.language !== undefined;
  return updateStep(
    doc,
    id,
    reword ? { code, actionText: describeCommand(code.language, wordingOf(doc)) } : { code },
    label,
    stamp,
    coalesceKey,
  );
}

/** "Remove" on a command's output: it leaves the step for good. */
export const removeStepOutput = (doc: EditorDoc, id: string, label: string, stamp: Stamp) =>
  setStepCode(doc, id, { output: null, outputShortened: false }, label, stamp);

export const setStepNotes = (doc: EditorDoc, id: string, notes: RichText | null, stamp: Stamp) =>
  updateStep(doc, id, { notes }, "edit note", stamp, `notes:${id}`);

/**
 * The per-step "Show typed value" toggle (decision D2). Generated wording is rebuilt from the
 * parts. Hand-edited wording is kept, except that hiding takes the value out of it ("…" in its
 * place), so a hidden value never stays in the wording; showing asks first in the UI.
 */
export function setShowValue(
  doc: EditorDoc,
  id: string,
  show: boolean,
  stamp: Stamp,
  replaceEditedText = false,
): Edit | null {
  const step = findStep(doc, id);
  if (!step?.textParts.value) return null;
  const patch: Partial<GuideStep> = { showValue: show };
  if (!step.textEdited || replaceEditedText) {
    const target = (step.target ?? {}) as StepTarget;
    // A field with no name has no wording to rebuild from; the value is then taken out of the
    // wording it has, so hiding never leaves it there.
    patch.actionText =
      typingWords(doc, { ...target, value: show ? step.textParts.value : undefined }) ??
      (show ? step.actionText : withoutTypedValue(step.actionText, step.textParts.value));
    patch.textEdited = false;
  } else if (!show) {
    patch.actionText = withoutTypedValue(step.actionText, step.textParts.value);
  }
  // Hidden from the step's wording in every language it's written in, not only the main one.
  if (!show && step.translations) {
    const value = step.textParts.value;
    patch.translations = Object.fromEntries(
      Object.entries(step.translations).map(([language, words]) => [
        language,
        words.actionText === undefined
          ? words
          : { ...words, actionText: withoutTypedValue(words.actionText, value) },
      ]),
    );
  }
  return updateStep(doc, id, patch, show ? "show typed value" : "hide typed value", stamp);
}

/**
 * Whether switching a value on or off may rebuild the step's wording: hiding never does (the
 * value is only taken out of it), and showing replaces hand-edited wording only when `ask` says
 * yes. The editor and the review before export both follow this (docs/spec/04-editor.md#typed-values).
 */
export const rebuildsWording = async (
  step: GuideStep,
  show: boolean,
  ask: () => Promise<boolean>,
): Promise<boolean> => show && (!step.textEdited || (await ask()));

/** "Remove typed value": deletes the value from the step for good. */
export function removeTypedValue(doc: EditorDoc, id: string, stamp: Stamp): Edit | null {
  const step = findStep(doc, id);
  if (!step?.textParts.value) return null;
  const parts = { ...step.textParts };
  delete parts.value;
  const target = (step.target ?? {}) as StepTarget;
  const actionText = step.textEdited
    ? withoutTypedValue(step.actionText, step.textParts.value)
    : (typingWords(doc, { ...target, value: undefined }) ??
      withoutTypedValue(step.actionText, step.textParts.value));
  return updateStep(
    doc,
    id,
    { textParts: parts, showValue: false, actionText },
    "remove typed value",
    stamp,
  );
}

/**
 * "What was typed" (04/10/2026): the typed value changed by hand, for a typo, a made-up example
 * instead of real data, or a "Type" step that recorded none. Generated wording is rebuilt with
 * it; hand-edited wording has the old value swapped for the new where it's there as typed. A new
 * value on a step that had none is shown, since the person just wrote it. Emptying it removes
 * the value, as "Remove the typed value for good" does.
 */
export function setTypedValue(
  doc: EditorDoc,
  id: string,
  value: string,
  stamp: Stamp,
): Edit | null {
  const step = findStep(doc, id);
  if (!step || step.action !== "input") return null;
  if (!value.trim()) return removeTypedValue(doc, id, stamp);
  const old = step.textParts.value;
  if (value === old) return null;
  const show = old === undefined ? true : step.showValue;
  const swap = (text: string) => (old ? text.split(old).join(value) : text);
  const patch: Partial<GuideStep> = { textParts: { ...step.textParts, value }, showValue: show };
  if (show) {
    const target = (step.target ?? {}) as StepTarget;
    patch.actionText = step.textEdited
      ? swap(step.actionText)
      : (typingWords(doc, { ...target, value }) ?? swap(step.actionText));
    if (step.translations)
      patch.translations = Object.fromEntries(
        Object.entries(step.translations).map(([language, words]) => [
          language,
          words.actionText === undefined ? words : { ...words, actionText: swap(words.actionText) },
        ]),
      );
  }
  return updateStep(doc, id, patch, "edit typed value", stamp, `value:${id}`);
}

/** "Hide all typed values" / "Show all typed values" on the guide. */
export function setAllValues(doc: EditorDoc, show: boolean, stamp: Stamp): Edit | null {
  const changes: Change[] = [];
  let working = doc;
  for (const step of doc.steps) {
    if (!step.textParts.value || step.showValue === show) continue;
    const single = setShowValue(working, step.id, show, stamp);
    if (!single) continue;
    changes.push(...single.changes);
    const after = single.changes[0];
    if (after?.kind === "step" && after.after) {
      const updated = after.after;
      working = {
        ...working,
        steps: working.steps.map((item) => (item.id === updated.id ? updated : item)),
      };
    }
  }
  if (changes.length === 0) return null;
  return edit(show ? "show all typed values" : "hide all typed values", changes, stamp);
}

export function deleteSteps(doc: EditorDoc, ids: string[], stamp: Stamp): Edit | null {
  const changes = ids
    .map((id) => findStep(doc, id))
    .filter((step): step is GuideStep => step !== null)
    .map((step) => stepChange(step, null));
  if (changes.length === 0) return null;
  return edit(changes.length === 1 ? "delete step" : "delete steps", changes, stamp);
}

/**
 * A key for a new position. When there is no room between two keys (rare), every step is given a
 * fresh evenly spread key in the same edit, so undo still restores the old order in one go.
 */
function placeAt(
  doc: EditorDoc,
  index: number,
  movingId: string | null,
  stamp: Stamp,
): { key: string; renumbered: Change[] } {
  const others = doc.steps.filter((step) => step.id !== movingId);
  const before = others[index - 1]?.sortKey ?? null;
  const after = others[index]?.sortKey ?? null;
  const key = keyBetween(before, after);
  if (key !== null) return { key, renumbered: [] };
  const keys = spreadKeys(others.length + 1);
  const renumbered: Change[] = [];
  others.forEach((step, position) => {
    const slot = position < index ? position : position + 1;
    const next = keys[slot] ?? step.sortKey;
    if (next !== step.sortKey)
      renumbered.push(stepChange(step, touched({ ...step, sortKey: next }, stamp)));
  });
  return { key: keys[index] ?? "i", renumbered };
}

/** Moves a step to `toIndex` in the list without it. Only that step's file changes. */
export function moveStep(doc: EditorDoc, id: string, toIndex: number, stamp: Stamp): Edit | null {
  const step = findStep(doc, id);
  const from = doc.steps.findIndex((item) => item.id === id);
  if (!step || from === toIndex) return null;
  const bounded = Math.max(0, Math.min(doc.steps.length - 1, toIndex));
  if (bounded === from) return null;
  const { key, renumbered } = placeAt(doc, bounded, id, stamp);
  return edit(
    "move step",
    [...renumbered, stepChange(step, touched({ ...step, sortKey: key }, stamp))],
    stamp,
  );
}

/** Inserts `step` at `index` (its sort key is assigned here). */
export function insertStepAt(
  doc: EditorDoc,
  step: GuideStep,
  index: number,
  label: string,
  stamp: Stamp,
): Edit {
  const { key, renumbered } = placeAt(
    doc,
    Math.max(0, Math.min(doc.steps.length, index)),
    null,
    stamp,
  );
  return edit(
    label,
    [...renumbered, stepChange(null, touched({ ...step, sortKey: key }, stamp))],
    stamp,
  );
}

export function duplicateStep(
  doc: EditorDoc,
  id: string,
  newId: string,
  stamp: Stamp,
): Edit | null {
  const step = findStep(doc, id);
  if (!step) return null;
  const index = doc.steps.findIndex((item) => item.id === id);
  return insertStepAt(doc, { ...step, id: newId }, index + 1, "duplicate step", stamp);
}

/** An empty step to fill in by hand, e.g. for something the recording couldn't see. */
export function blankStep(id: string, stamp: Stamp): GuideStep {
  return {
    id,
    sortKey: "i",
    kind: "interaction",
    action: "manual",
    actionText: "",
    textParts: { verb: "", target: "", kind: "manual" },
    showValue: false,
    textEdited: true,
    notes: null,
    altText: null,
    context: { app: null, windowTitle: "" },
    target: null,
    media: null,
    highlight: null,
    crop: null,
    redactions: [],
    annotations: [],
    block: null,
    capturedAt: iso(stamp),
    updatedAt: iso(stamp),
    updatedBy: stamp.by,
    formatVersion: 1,
  };
}

/** An unnumbered commentary block between steps (docs/spec/04-editor.md#commentary-blocks). */
export function blockStep(id: string, type: Block["type"], stamp: Stamp): GuideStep {
  return {
    ...blankStep(id, stamp),
    kind: "block",
    action: "block",
    textParts: { verb: "", target: "", kind: "block" },
    block: { type, heading: "", body: null },
  };
}

/** Split: a copy of the step after it, with the same screenshot and empty wording to fill in. */
export function splitStep(doc: EditorDoc, id: string, newId: string, stamp: Stamp): Edit | null {
  const step = findStep(doc, id);
  if (!step || step.kind !== "interaction") return null;
  const index = doc.steps.findIndex((item) => item.id === id);
  const copy: GuideStep = {
    ...step,
    id: newId,
    actionText: "",
    textEdited: true,
    notes: null,
    annotations: [],
  };
  return insertStepAt(doc, copy, index + 1, "split step", stamp);
}

/** Merge: the step absorbs the next one's wording and notes; the next one is removed. */
export function mergeWithNext(doc: EditorDoc, id: string, stamp: Stamp): Edit | null {
  const index = doc.steps.findIndex((item) => item.id === id);
  const step = doc.steps[index];
  const next = doc.steps[index + 1];
  if (!step || !next || step.kind !== "interaction" || next.kind !== "interaction") return null;
  // Two commands (or pieces of code) become one script, under this step's wording.
  if (step.code && next.code) {
    const merged: GuideStep = {
      ...step,
      code: mergeCode([step.code, next.code]),
      notes: mergeNotes(step.notes, next.notes),
    };
    return edit(
      "merge steps",
      [stepChange(step, touched(merged, stamp)), stepChange(next, null)],
      stamp,
    );
  }
  // A hidden value stays hidden: the merged step keeps only this step's value and toggle.
  const wording = (item: GuideStep) =>
    item.showValue && item === step
      ? item.actionText
      : withoutTypedValue(item.actionText, item.textParts.value);
  const text = [wording(step), wording(next)].filter(Boolean).join(", then ");
  const notes = mergeNotes(step.notes, next.notes);
  return edit(
    "merge steps",
    [
      stepChange(
        step,
        touched(
          { ...step, actionText: text, textEdited: true, notes, code: step.code ?? next.code },
          stamp,
        ),
      ),
      stepChange(next, null),
    ],
    stamp,
  );
}

const mergeNotes = (first: RichText | null, second: RichText | null): RichText | null => {
  if (!first) return second;
  if (!second) return first;
  return { type: "doc", content: [...(first.content ?? []), ...(second.content ?? [])] };
};

/** Guide details: title, description, intro, outro, tags, owner, review-by date. */
export function updateGuide(
  doc: EditorDoc,
  patch: Partial<Omit<Guide, "id">>,
  label: string,
  stamp: Stamp,
  coalesceKey?: string,
): Edit {
  const after: Guide = { ...doc.guide, ...patch, updatedAt: iso(stamp), updatedBy: stamp.by };
  return edit(label, [{ kind: "guide", before: doc.guide, after }], stamp, coalesceKey);
}

/** Every text node of a note, replaced; the structure (lists, links, headings) is kept. */
function replaceInRichText(
  node: RichText | null,
  pattern: RegExp,
  replacement: string,
): RichText | null {
  if (!node) return node;
  return {
    ...node,
    ...(node.text !== undefined ? { text: node.text.replace(pattern, replacement) } : {}),
    ...(node.content
      ? {
          content: node.content.map(
            (child) => replaceInRichText(child, pattern, replacement) ?? child,
          ),
        }
      : {}),
  };
}

const richTextHas = (node: RichText | null, pattern: RegExp): boolean =>
  !!node &&
  ((node.text !== undefined && new RegExp(pattern.source, "i").test(node.text)) ||
    (node.content ?? []).some((child) => richTextHas(child, pattern)));

/** Steps whose wording, notes or block text contain `term` (Find & Blur also searches text). */
export function stepsWithText(doc: EditorDoc, term: string): GuideStep[] {
  const needle = term.trim();
  if (!needle) return [];
  const pattern = new RegExp(escapeRegExp(needle), "i");
  return doc.steps.filter(
    (step) =>
      pattern.test(step.actionText) ||
      richTextHas(step.notes, pattern) ||
      (!!step.code && (pattern.test(step.code.text) || pattern.test(step.code.output ?? ""))) ||
      (step.block !== null &&
        (pattern.test(step.block.heading) || richTextHas(step.block.body, pattern))),
  );
}

/**
 * Find & Blur's "Replace": `term` becomes `replacement` in step wording, notes and block text,
 * ignoring case, as one undoable edit. Reworded steps are marked as edited by hand.
 */
export function replaceText(
  doc: EditorDoc,
  term: string,
  replacement: string,
  stamp: Stamp,
): Edit | null {
  const needle = term.trim();
  if (!needle) return null;
  const pattern = new RegExp(escapeRegExp(needle), "gi");
  const changes = stepsWithText(doc, needle).map((step) => {
    const actionText = step.actionText.replace(pattern, replacement);
    const next: GuideStep = {
      ...step,
      actionText,
      textEdited: step.textEdited || actionText !== step.actionText,
      notes: replaceInRichText(step.notes, pattern, replacement),
      ...(step.code
        ? {
            code: {
              ...step.code,
              text: step.code.text.replace(pattern, replacement),
              output: step.code.output?.replace(pattern, replacement) ?? null,
            },
          }
        : {}),
      block: step.block
        ? {
            ...step.block,
            heading: step.block.heading.replace(pattern, replacement),
            body: replaceInRichText(step.block.body, pattern, replacement),
          }
        : null,
    };
    return stepChange(step, touched(next, stamp));
  });
  return changes.length ? edit("replace text", changes, stamp) : null;
}
