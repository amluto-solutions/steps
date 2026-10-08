import type { TFunction } from "i18next";
import type { Block, GuideStep } from "@amluto-steps/core";

import type { MenuEntry, MenuItem } from "../components/Menu";
import {
  blankStep,
  blockStep,
  duplicateStep,
  duplicateSteps,
  insertStepAt,
  mergeWithNext,
  moveStep,
  moveStepsBy,
  splitStep,
} from "./edits";
import type { Selection } from "./StepRail";
import type { GuideEditor } from "./useGuideEditor";

/** What the step and Add menus need of the editor (docs/spec/04-editor.md). */
export interface MenuEditor {
  /** The guide's steps as they are now. */
  steps: readonly GuideStep[];
  /** Who new steps are stamped as made by. */
  author: string;
  t: TFunction;
  /** Makes an edit through the undo layer. */
  apply: GuideEditor["apply"];
  /** Shows a step: a step just added is selected. */
  select: (selection: Selection) => void;
  /** Deletes steps, with the editor's Undo toast and its moving to a neighbour. */
  remove: (ids: string[]) => void;
  /**
   * The steps picked to act on together (08/10/2026), in any order; empty, or two or more. A
   * picked step's Duplicate, Move up, Move down and Delete act on all of them.
   */
  group: readonly string[];
  /**
   * Starts a recording whose steps go in after the step at `index` (-1 for first) when it stops
   * (docs/spec/04-editor.md#record-steps-here): Record steps here, Record steps after, and
   * Re-record these steps for several selected, which records after the last of them and leaves
   * them as they are. Absent while the guide can't be recorded into (read-only, or a recording
   * is running).
   */
  recordAfter?: ((index: number) => void) | undefined;
}

let idCounter = 0;
/** An id for a step made in the editor, unique within this session and across sessions. */
export const newId = (prefix: string) => {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
};

/** Puts `step` after the one at `index` (-1 for first) as one undo step, and selects it. */
export function insertAfter(editor: MenuEditor, step: GuideStep, index: number, label: string) {
  editor.apply((current, stamp) => insertStepAt(current, step, index + 1, label, stamp));
  editor.select({ kind: "step", id: step.id });
}

/**
 * The step menu's keyboard shortcuts (08/10/2026), shown beside each entry. They work while
 * a step is selected and the focus isn't in text or another control that takes the keys
 * (`stepShortcut`, called by the editor).
 */
export const STEP_KEYS = {
  duplicate: "Ctrl + D",
  split: "Ctrl + Shift + D",
  merge: "Ctrl + J",
  moveUp: "Alt + ↑",
  moveDown: "Alt + ↓",
  addStepAfter: "Ctrl + Enter",
  addTipAfter: "Ctrl + Shift + Enter",
  delete: "Delete",
} as const;

/** The keys of a key press as `STEP_KEYS` writes them; Cmd counts as Ctrl. */
export function pressedKeys(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): string {
  const arrows: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓" };
  const key = arrows[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return [
    event.ctrlKey || event.metaKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    key,
  ]
    .filter(Boolean)
    .join(" + ");
}

/**
 * Runs the entry of `step`'s menu whose shortcut is `event`'s keys, if it's there and enabled.
 * True when one ran.
 */
export function stepShortcut(
  editor: MenuEditor,
  step: GuideStep,
  index: number,
  event: Parameters<typeof pressedKeys>[0],
): boolean {
  const keys = pressedKeys(event);
  const entry = stepMenu(editor, step, index).find(
    (item): item is MenuItem => typeof item === "object" && "keys" in item && item.keys === keys,
  );
  if (!entry || entry.disabled) return false;
  entry.onSelect();
  return true;
}

/**
 * The picked steps `step` is one of, as places in the guide, or null when it's on its own: the
 * group's Duplicate, Move up, Move down and Delete act on all of them.
 */
function groupOf(editor: MenuEditor, step: GuideStep) {
  if (editor.group.length < 2 || !editor.group.includes(step.id)) return null;
  const ids = editor.group;
  const places = editor.steps.flatMap((item, place) => (ids.includes(item.id) ? [place] : []));
  return {
    ids,
    /** Where the last of them is: Re-record these steps records after it. */
    last: places.at(-1) ?? -1,
    // Already at the top or the bottom: the picked steps fill those places.
    atTop: places.every((place, nth) => place === nth),
    atBottom: places.every((place, nth) => place === editor.steps.length - places.length + nth),
  };
}

/** The entries of a step's menu that act on all the picked steps, for the bar above the list. */
export function groupActions(editor: MenuEditor, step: GuideStep, index: number): MenuItem[] {
  const shared: string[] = [
    STEP_KEYS.moveUp,
    STEP_KEYS.moveDown,
    STEP_KEYS.duplicate,
    STEP_KEYS.delete,
  ];
  const entries = stepMenu(editor, step, index).filter(
    (item): item is MenuItem => typeof item === "object" && "onSelect" in item,
  );
  return [
    ...entries
      .filter((item) => item.keys !== undefined && shared.includes(item.keys))
      .sort((a, b) => shared.indexOf(a.keys ?? "") - shared.indexOf(b.keys ?? "")),
    // Re-record these steps, when the guide can be recorded into.
    ...entries.filter((item) => item.icon === "record"),
  ];
}

/** A step's or block's menu in the steps list, `index` being where it is in the guide. */
export function stepMenu(editor: MenuEditor, step: GuideStep, index: number): MenuEntry[] {
  const { t, apply } = editor;
  const made = () => ({ at: Date.now(), by: editor.author });
  const group = groupOf(editor, step);
  return [
    {
      label: t("editor.menu.duplicate"),
      icon: "copy",
      keys: STEP_KEYS.duplicate,
      onSelect: () =>
        apply((current, stamp) =>
          group
            ? duplicateSteps(current, group.ids, () => newId("step"), stamp)
            : duplicateStep(current, step.id, newId("step"), stamp),
        ),
    },
    ...(step.kind === "interaction"
      ? [
          {
            label: t("editor.menu.split"),
            icon: "split" as const,
            note: t("editor.menu.splitNote"),
            keys: STEP_KEYS.split,
            onSelect: () =>
              apply((current, stamp) => splitStep(current, step.id, newId("step"), stamp)),
          },
          {
            label: t("editor.menu.merge"),
            icon: "merge" as const,
            keys: STEP_KEYS.merge,
            disabled: editor.steps[index + 1]?.kind !== "interaction",
            onSelect: () => apply((current, stamp) => mergeWithNext(current, step.id, stamp)),
          },
        ]
      : []),
    "divider",
    {
      label: t("editor.menu.moveUp"),
      icon: "up",
      keys: STEP_KEYS.moveUp,
      disabled: group ? group.atTop : index === 0,
      onSelect: () =>
        apply((current, stamp) =>
          group
            ? moveStepsBy(current, group.ids, -1, stamp)
            : moveStep(current, step.id, index - 1, stamp),
        ),
    },
    {
      label: t("editor.menu.moveDown"),
      icon: "down",
      keys: STEP_KEYS.moveDown,
      disabled: group ? group.atBottom : index === editor.steps.length - 1,
      onSelect: () =>
        apply((current, stamp) =>
          group
            ? moveStepsBy(current, group.ids, 1, stamp)
            : moveStep(current, step.id, index + 1, stamp),
        ),
    },
    "divider",
    {
      label: t("editor.menu.addStepAfter"),
      icon: "plus",
      keys: STEP_KEYS.addStepAfter,
      onSelect: () =>
        insertAfter(editor, blankStep(newId("step"), made()), index, t("editor.undo.addStep")),
    },
    {
      label: t("editor.menu.addTipAfter"),
      icon: "info",
      keys: STEP_KEYS.addTipAfter,
      onSelect: () =>
        insertAfter(
          editor,
          blockStep(newId("block"), "tip", made()),
          index,
          t("editor.undo.addBlock"),
        ),
    },
    ...(editor.recordAfter
      ? [
          {
            // For several picked: new steps after the last of them, which stay as they are.
            label: group ? t("editor.group.rerecord") : t("editor.menu.recordAfter"),
            icon: "record" as const,
            onSelect: () => editor.recordAfter?.(group ? group.last : index),
          },
        ]
      : []),
    "divider",
    {
      label: t("editor.menu.delete"),
      icon: "trash",
      danger: true,
      keys: STEP_KEYS.delete,
      onSelect: () => editor.remove(group ? [...group.ids] : [step.id]),
    },
  ];
}

/**
 * Where the Add menu puts a new item: after the selected step; with the guide details or intro
 * selected it goes first, and only the outro sends it to the end.
 */
const addAfter = (steps: readonly GuideStep[], selection: Selection) => {
  if (selection.kind === "step") {
    const index = steps.findIndex((item) => item.id === selection.id);
    if (index >= 0) return index;
  }
  return selection.kind === "outro" ? steps.length - 1 : -1;
};

/**
 * The Add menu under the steps list: a blank step, a step from a picture, steps recorded here,
 * and the blocks.
 */
export function addMenu(
  editor: MenuEditor,
  selection: Selection,
  images: { canImport: boolean; pick: () => void },
): MenuEntry[] {
  const { t } = editor;
  const at = addAfter(editor.steps, selection);
  const made = () => ({ at: Date.now(), by: editor.author });
  const addBlock = (type: Block["type"]) =>
    insertAfter(editor, blockStep(newId("block"), type, made()), at, t("editor.undo.addBlock"));
  return [
    {
      label: t("editor.menu.blankStep"),
      icon: "plus",
      note: t("editor.menu.blankStepNote"),
      onSelect: () =>
        insertAfter(editor, blankStep(newId("step"), made()), at, t("editor.undo.addStep")),
    },
    {
      label: t("editor.menu.image"),
      icon: "image",
      note: images.canImport ? t("editor.menu.imageNote") : t("editor.saveFirstForImages"),
      disabled: !images.canImport,
      onSelect: images.pick,
    },
    ...(editor.recordAfter
      ? [
          {
            label: t("editor.menu.recordHere"),
            icon: "record" as const,
            note: t("editor.menu.recordHereNote"),
            onSelect: () => editor.recordAfter?.(at),
          },
        ]
      : []),
    { heading: t("editor.menu.blocks") },
    { label: t("editor.block.header"), icon: "text", onSelect: () => addBlock("header") },
    { label: t("editor.block.text"), icon: "note", onSelect: () => addBlock("text") },
    { label: t("editor.block.callout"), icon: "info", onSelect: () => addBlock("callout") },
    { label: t("editor.block.tip"), icon: "info", onSelect: () => addBlock("tip") },
    { label: t("editor.block.warning"), icon: "warning", onSelect: () => addBlock("warning") },
    { label: t("editor.block.alert"), icon: "warning", onSelect: () => addBlock("alert") },
  ];
}
