import { describe, expect, it } from "vitest";
import type { MenuEntry, MenuItem } from "../components/Menu";

import { initI18n } from "../i18n";
import { applyChanges, type EditorDoc } from "./document";
import { blankStep, blockStep, type Stamp } from "./edits";
import { addMenu, stepMenu, type MenuEditor } from "./step-menus";
import type { Selection } from "./StepRail";

const i18n = initI18n();

const stamp: Stamp = { at: Date.parse("2026-10-07T10:00:00.000Z"), by: "Robin" };
const step = (id: string, sortKey: string, actionText: string) => ({
  ...blankStep(id, stamp),
  sortKey,
  actionText,
});

const payroll: EditorDoc = {
  guide: {
    id: "g1",
    title: "Payroll run",
    description: "",
    intro: null,
    outro: null,
    brandProfileId: null,
    tags: [],
    owner: "Robin",
    reviewBy: null,
    createdAt: "2026-10-07T10:00:00.000Z",
    createdBy: "Robin",
    updatedAt: "2026-10-07T10:00:00.000Z",
    updatedBy: "Robin",
    formatVersion: 1,
  },
  steps: [
    step("s1", "0000000001", "Open payroll"),
    step("s2", "0000000002", "Choose the month"),
    step("s3", "0000000003", "Run it"),
  ],
};

/** An editor over `start` whose edits really change the guide, as the editor's undo layer does. */
function editorOver(start: EditorDoc) {
  let doc = start;
  const selected: Selection[] = [];
  const removed: string[][] = [];
  const editor: MenuEditor = {
    steps: doc.steps,
    author: "Robin",
    t: i18n.t,
    apply: (make) => {
      const edit = make(doc, stamp);
      if (edit) doc = applyChanges(doc, edit.changes, "do");
      return edit;
    },
    select: (selection) => selected.push(selection),
    remove: (ids) => removed.push(ids),
  };
  return {
    editor,
    selected,
    removed,
    /** The guide's steps by their words, a block by its type. */
    order: () => doc.steps.map((item) => item.block?.type ?? item.actionText),
    doc: () => doc,
  };
}

const item = (entries: MenuEntry[], label: string): MenuItem => {
  const found = entries.find(
    (entry): entry is MenuItem =>
      typeof entry === "object" && "label" in entry && entry.label === label,
  );
  if (!found) throw new Error(`no "${label}" in the menu`);
  return found;
};

const noImages = { canImport: false, pick: () => undefined };

describe("the Add menu", () => {
  it("puts a section heading straight after the selected step", () => {
    const { editor, order, selected } = editorOver(payroll);
    item(addMenu(editor, { kind: "step", id: "s2" }, noImages), "Section heading").onSelect();
    expect(order()).toEqual(["Open payroll", "Choose the month", "header", "Run it"]);
    expect(selected.at(-1)?.kind).toBe("step");
  });

  it.each([
    [{ kind: "details" }, ["tip", "Open payroll", "Choose the month", "Run it"]],
    [{ kind: "intro" }, ["tip", "Open payroll", "Choose the month", "Run it"]],
    [{ kind: "outro" }, ["Open payroll", "Choose the month", "Run it", "tip"]],
  ] as [Selection, string[]][])("from %o puts a tip where the spec says", (selection, after) => {
    const { editor, order } = editorOver(payroll);
    item(addMenu(editor, selection, noImages), "Tip (green)").onSelect();
    expect(order()).toEqual(after);
  });

  it("adds a blank step and shows it", () => {
    const { editor, doc, selected } = editorOver(payroll);
    item(addMenu(editor, { kind: "step", id: "s1" }, noImages), "Blank step").onSelect();
    const added = doc().steps[1];
    expect(added).toMatchObject({ kind: "interaction", actionText: "" });
    expect(selected.at(-1)).toEqual({ kind: "step", id: added?.id });
  });

  it("offers a step from a picture only where pictures can be imported", () => {
    const { editor } = editorOver(payroll);
    const unsaved = item(addMenu(editor, { kind: "details" }, noImages), "Step from a picture");
    expect(unsaved).toMatchObject({
      disabled: true,
      note: "Save the guide first to add your own images",
    });

    let picked = 0;
    const saved = item(
      addMenu(editor, { kind: "details" }, { canImport: true, pick: () => (picked += 1) }),
      "Step from a picture",
    );
    expect(saved.disabled).toBe(false);
    saved.onSelect();
    expect(picked).toBe(1);
  });
});

describe("a step's menu", () => {
  it("moves a step down, and can't move the last one further", () => {
    const { editor, order } = editorOver(payroll);
    const first = payroll.steps[0];
    const last = payroll.steps[2];
    if (!first || !last) throw new Error("no steps");
    item(stepMenu(editor, first, 0), "Move down").onSelect();
    expect(order()).toEqual(["Choose the month", "Open payroll", "Run it"]);
    expect(item(stepMenu(editor, first, 0), "Move up").disabled).toBe(true);
    expect(item(stepMenu(editor, last, 2), "Move down").disabled).toBe(true);
  });

  it("splits and merges only steps, and merges only into a following step", () => {
    const withTip: EditorDoc = {
      ...payroll,
      steps: [
        ...payroll.steps.slice(0, 2),
        { ...blockStep("b1", "tip", stamp), sortKey: "0000000004" },
      ],
    };
    const { editor } = editorOver(withTip);
    const [first, second, tip] = withTip.steps;
    if (!first || !second || !tip) throw new Error("no steps");
    expect(item(stepMenu(editor, first, 0), "Merge with the next step").disabled).toBe(false);
    expect(item(stepMenu(editor, second, 1), "Merge with the next step").disabled).toBe(true);
    const labels = stepMenu(editor, tip, 2).map((entry) =>
      typeof entry === "object" && "label" in entry ? entry.label : entry,
    );
    expect(labels).not.toContain("Split into two");
    expect(labels).not.toContain("Merge with the next step");
  });

  it("duplicates a step in place", () => {
    const { editor, order } = editorOver(payroll);
    const second = payroll.steps[1];
    if (!second) throw new Error("no steps");
    item(stepMenu(editor, second, 1), "Duplicate").onSelect();
    expect(order()).toEqual(["Open payroll", "Choose the month", "Choose the month", "Run it"]);
  });

  it("adds a tip after the step and shows it", () => {
    const { editor, order, selected, doc } = editorOver(payroll);
    const first = payroll.steps[0];
    if (!first) throw new Error("no steps");
    item(stepMenu(editor, first, 0), "Add a tip after").onSelect();
    expect(order()).toEqual(["Open payroll", "tip", "Choose the month", "Run it"]);
    expect(selected.at(-1)).toEqual({ kind: "step", id: doc().steps[1]?.id });
  });

  it("deletes through the editor, which offers Undo", () => {
    const { editor, removed, order } = editorOver(payroll);
    const third = payroll.steps[2];
    if (!third) throw new Error("no steps");
    item(stepMenu(editor, third, 2), "Delete").onSelect();
    expect(removed).toEqual([["s3"]]);
    // The editor deletes; the menu doesn't do it a second time.
    expect(order()).toHaveLength(3);
  });
});
