import type { TFunction } from "i18next";
import type { Block, GuideStep } from "@amluto-steps/core";

import type { MenuEntry } from "../components/Menu";
import {
  blankStep,
  blockStep,
  duplicateStep,
  insertStepAt,
  mergeWithNext,
  moveStep,
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

/** A step's or block's menu in the steps list, `index` being where it is in the guide. */
export function stepMenu(editor: MenuEditor, step: GuideStep, index: number): MenuEntry[] {
  const { t, apply } = editor;
  const made = () => ({ at: Date.now(), by: editor.author });
  return [
    {
      label: t("editor.menu.duplicate"),
      icon: "copy",
      onSelect: () =>
        apply((current, stamp) => duplicateStep(current, step.id, newId("step"), stamp)),
    },
    ...(step.kind === "interaction"
      ? [
          {
            label: t("editor.menu.split"),
            icon: "split" as const,
            note: t("editor.menu.splitNote"),
            onSelect: () =>
              apply((current, stamp) => splitStep(current, step.id, newId("step"), stamp)),
          },
          {
            label: t("editor.menu.merge"),
            icon: "merge" as const,
            disabled: editor.steps[index + 1]?.kind !== "interaction",
            onSelect: () => apply((current, stamp) => mergeWithNext(current, step.id, stamp)),
          },
        ]
      : []),
    "divider",
    {
      label: t("editor.menu.moveUp"),
      icon: "up",
      disabled: index === 0,
      onSelect: () => apply((current, stamp) => moveStep(current, step.id, index - 1, stamp)),
    },
    {
      label: t("editor.menu.moveDown"),
      icon: "down",
      disabled: index === editor.steps.length - 1,
      onSelect: () => apply((current, stamp) => moveStep(current, step.id, index + 1, stamp)),
    },
    "divider",
    {
      label: t("editor.menu.addStepAfter"),
      icon: "plus",
      onSelect: () =>
        insertAfter(editor, blankStep(newId("step"), made()), index, t("editor.undo.addStep")),
    },
    {
      label: t("editor.menu.addTipAfter"),
      icon: "info",
      onSelect: () =>
        insertAfter(
          editor,
          blockStep(newId("block"), "tip", made()),
          index,
          t("editor.undo.addBlock"),
        ),
    },
    "divider",
    {
      label: t("editor.menu.delete"),
      icon: "trash",
      danger: true,
      trailing: t("editor.deleteKey"),
      onSelect: () => editor.remove([step.id]),
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

/** The Add menu under the steps list: a blank step, a step from a picture, and the blocks. */
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
    { heading: t("editor.menu.blocks") },
    { label: t("editor.block.header"), icon: "text", onSelect: () => addBlock("header") },
    { label: t("editor.block.text"), icon: "note", onSelect: () => addBlock("text") },
    { label: t("editor.block.callout"), icon: "info", onSelect: () => addBlock("callout") },
    { label: t("editor.block.tip"), icon: "info", onSelect: () => addBlock("tip") },
    { label: t("editor.block.warning"), icon: "warning", onSelect: () => addBlock("warning") },
    { label: t("editor.block.alert"), icon: "warning", onSelect: () => addBlock("alert") },
  ];
}
