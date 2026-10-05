import { describe, expect, it } from "vitest";
import type { Guide, GuideStep } from "@amluto-steps/core";

import {
  applyChanges,
  emptyHistory,
  recordEdit,
  redo,
  undo,
  type Edit,
  type EditorDoc,
} from "./document";
import {
  blankStep,
  blockStep,
  deleteSteps,
  duplicateStep,
  insertStepAt,
  mergeWithNext,
  moveStep,
  removeStepOutput,
  removeTypedValue,
  replaceText,
  stepsWithText,
  setAllValues,
  setShowValue,
  setTypedValue,
  setStepCode,
  setStepNotes,
  setStepText,
  splitStep,
  updateGuide,
  updateStep,
  type Stamp,
} from "./edits";

const stamp = (at = 1_790_000_000_000): Stamp => ({ at, by: "Robin" });

const guide: Guide = {
  id: "g1",
  title: "Add a supplier",
  description: "",
  intro: null,
  outro: null,
  brandProfileId: null,
  tags: [],
  owner: "Robin",
  reviewBy: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  createdBy: "Robin",
  updatedAt: "2026-09-25T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
};

const step = (id: string, sortKey: string, text: string): GuideStep => ({
  ...blankStep(id, stamp(0)),
  sortKey,
  action: "click",
  actionText: text,
  textEdited: false,
});

const typed: GuideStep = {
  ...step("s4", "0000000004", 'Type "Acme Ltd"'),
  action: "input",
  textParts: { verb: "input", target: "Customer name", kind: "field", value: "Acme Ltd" },
  showValue: true,
  target: { labelText: "Customer name", tagName: "input" },
};

const doc = (): EditorDoc => ({
  guide,
  steps: [
    step("s1", "0000000001", "Click One"),
    step("s2", "0000000002", "Click Two"),
    step("s3", "0000000003", "Click Three"),
    typed,
  ],
});

const texts = (value: EditorDoc) => value.steps.map((item) => item.actionText);

/** Every edit must round-trip: do then undo gives back exactly what was there. */
const roundTrips = (original: EditorDoc, made: Edit | null) => {
  expect(made).not.toBeNull();
  if (!made) return original;
  const done = applyChanges(original, made.changes, "do");
  expect(applyChanges(done, made.changes, "undo")).toEqual(original);
  return done;
};

describe("editor edits", () => {
  it("are all undoable", () => {
    const original = doc();
    const edits: (Edit | null)[] = [
      setStepText(original, "s1", "Click the green One", stamp()),
      setStepNotes(original, "s2", { type: "doc", content: [] }, stamp()),
      deleteSteps(original, ["s1", "s3"], stamp()),
      duplicateStep(original, "s2", "s2-copy", stamp()),
      moveStep(original, "s1", 3, stamp()),
      moveStep(original, "s4", 0, stamp()),
      insertStepAt(original, blankStep("new", stamp()), 2, "add step", stamp()),
      insertStepAt(original, blockStep("tip", "tip", stamp()), 0, "add tip", stamp()),
      splitStep(original, "s2", "s2b", stamp()),
      mergeWithNext(original, "s1", stamp()),
      setShowValue(original, "s4", false, stamp()),
      removeTypedValue(original, "s4", stamp()),
      setAllValues(original, false, stamp()),
      updateStep(
        original,
        "s1",
        { annotations: [{ type: "arrow", from: [1, 2], to: [3, 4] }] },
        "add arrow",
        stamp(),
      ),
      updateGuide(original, { title: "New title", tags: ["Finance"] }, "rename", stamp()),
    ];
    for (const made of edits) roundTrips(original, made);
  });

  it("move a step by rewriting only that step's file", () => {
    const original = doc();
    const made = moveStep(original, "s1", 2, stamp());
    expect(made?.changes).toHaveLength(1);
    const moved = roundTrips(original, made);
    expect(moved.steps.map((item) => item.id)).toEqual(["s2", "s3", "s1", "s4"]);
  });

  it("renumber everything when two keys leave no room, in one undoable edit", () => {
    const tight: EditorDoc = {
      guide,
      steps: [step("a", "1", "A"), step("b", "10", "B"), step("c", "2", "C")],
    };
    const made = moveStep(tight, "c", 1, stamp());
    const moved = roundTrips(tight, made);
    expect(moved.steps.map((item) => item.id)).toEqual(["a", "c", "b"]);
  });

  it("delete steps and bring them back with undo", () => {
    const original = doc();
    const made = deleteSteps(original, ["s2"], stamp());
    const after = roundTrips(original, made);
    expect(after.steps.map((item) => item.id)).toEqual(["s1", "s3", "s4"]);
  });

  it("rebuild typed-value wording unless it was edited by hand", () => {
    const original = doc();
    const hidden = roundTrips(original, setShowValue(original, "s4", false, stamp()));
    const hiddenStep = hidden.steps.find((item) => item.id === "s4");
    expect(hiddenStep?.showValue).toBe(false);
    expect(hiddenStep?.actionText).not.toContain("Acme");
    expect(hiddenStep?.textParts.value).toBe("Acme Ltd");

    const edited = roundTrips(original, setStepText(original, "s4", "Type the name", stamp()));
    const keep = roundTrips(edited, setShowValue(edited, "s4", false, stamp()));
    expect(keep.steps.find((item) => item.id === "s4")?.actionText).toBe("Type the name");
  });

  it("change what was typed, in generated and hand-edited wording (04/10/2026)", () => {
    const original = doc();
    const changed = roundTrips(original, setTypedValue(original, "s4", "Example Ltd", stamp()));
    const after = changed.steps.find((item) => item.id === "s4");
    expect(after?.textParts.value).toBe("Example Ltd");
    expect(after?.actionText).toContain("Example Ltd");
    expect(after?.actionText).not.toContain("Acme");

    const edited = roundTrips(
      original,
      setStepText(original, "s4", 'Enter "Acme Ltd" as the customer', stamp()),
    );
    const swapped = roundTrips(edited, setTypedValue(edited, "s4", "Example Ltd", stamp()));
    expect(swapped.steps.find((item) => item.id === "s4")?.actionText).toBe(
      'Enter "Example Ltd" as the customer',
    );
    // Emptied, the value is removed; the same value again is no edit.
    const removed = roundTrips(original, setTypedValue(original, "s4", "  ", stamp()));
    expect(removed.steps.find((item) => item.id === "s4")?.textParts.value).toBeUndefined();
    expect(setTypedValue(original, "s4", "Acme Ltd", stamp())).toBeNull();
    // A typing step that recorded nothing gets the value, shown.
    const added = roundTrips(removed, setTypedValue(removed, "s4", "Contoso", stamp()));
    const step4 = added.steps.find((item) => item.id === "s4");
    expect([step4?.showValue, step4?.actionText.includes("Contoso")]).toEqual([true, true]);
    // Only typing steps have one.
    expect(setTypedValue(original, "s1", "x", stamp())).toBeNull();
  });

  it("hide a typed value from the step's wording in every language, and offer standard wording (F028)", () => {
    const original = doc();
    const german = {
      ...original,
      steps: original.steps.map((item) =>
        item.id === "s4"
          ? { ...item, translations: { de: { actionText: "„Acme Ltd“ eingeben" } } }
          : item,
      ),
    };
    const hidden = roundTrips(german, setShowValue(german, "s4", false, stamp()));
    expect(hidden.steps.find((item) => item.id === "s4")?.translations?.de?.actionText).toBe(
      "„…“ eingeben",
    );
    // Edited wording the value can't be found in: the standard wording, when chosen.
    const edited = roundTrips(original, setStepText(original, "s4", "Type the client", stamp()));
    const standard = roundTrips(edited, setShowValue(edited, "s4", false, stamp(), true));
    const after = standard.steps.find((item) => item.id === "s4");
    expect(after?.textEdited).toBe(false);
    expect(after?.actionText).not.toContain("client");
  });

  it("hide a typed value even in a field with no name to rebuild the wording from", () => {
    const unnamed: GuideStep = {
      ...step("s9", "0000000009", 'Type "secret plan"'),
      textParts: { verb: "input", target: "", kind: "field", value: "secret plan" },
      showValue: true,
      target: { tagName: "input" },
    };
    const start = { ...doc(), steps: [unnamed] };
    const hidden = roundTrips(start, setShowValue(start, "s9", false, stamp()));
    expect(hidden.steps[0]?.actionText).not.toContain("secret");
    const removed = roundTrips(start, removeTypedValue(start, "s9", stamp()));
    expect(removed.steps[0]?.actionText).not.toContain("secret");
  });

  it("remove a typed value for good", () => {
    const original = doc();
    const removed = roundTrips(original, removeTypedValue(original, "s4", stamp()));
    const after = removed.steps.find((item) => item.id === "s4");
    expect(after?.textParts.value).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("Acme");
  });

  it("merge a step with the next one", () => {
    const original = doc();
    const merged = roundTrips(original, mergeWithNext(original, "s1", stamp()));
    expect(texts(merged)).toEqual(["Click One, then Click Two", "Click Three", 'Type "Acme Ltd"']);
  });

  describe("never leave a hidden value in hand-edited wording", () => {
    const edited = () => {
      const original = doc();
      return roundTrips(
        original,
        setStepText(original, "s4", "Enter ACME LTD as the customer", stamp()),
      );
    };
    const s4 = (value: EditorDoc) => value.steps.find((item) => item.id === "s4");

    it("when hiding one value", () => {
      const start = edited();
      const hidden = roundTrips(start, setShowValue(start, "s4", false, stamp()));
      expect(s4(hidden)?.actionText).toBe("Enter … as the customer");
      expect(s4(hidden)?.textEdited).toBe(true);
    });

    it("when hiding all values", () => {
      const start = edited();
      const hidden = roundTrips(start, setAllValues(start, false, stamp()));
      expect(s4(hidden)?.actionText).toBe("Enter … as the customer");
    });

    it("when removing the value", () => {
      const start = edited();
      const removed = roundTrips(start, removeTypedValue(start, "s4", stamp()));
      expect(JSON.stringify(s4(removed))).not.toMatch(/acme/i);
    });

    it("when merging into the step before", () => {
      const original = doc();
      const hidden = roundTrips(original, setShowValue(original, "s4", false, stamp()));
      const reworded = roundTrips(hidden, setStepText(hidden, "s4", "Type Acme Ltd", stamp()));
      const merged = roundTrips(reworded, mergeWithNext(reworded, "s3", stamp()));
      expect(texts(merged).join(" ")).not.toMatch(/acme/i);
    });
  });
});

describe("history", () => {
  it("joins quick typing into one undo step and undoes back to the start", () => {
    let current = doc();
    let history = emptyHistory();
    for (const [offset, text] of ["C", "Cl", "Cli"].entries()) {
      const made = setStepText(current, "s1", text, stamp(1000 + offset * 200));
      if (!made) throw new Error("no edit");
      current = applyChanges(current, made.changes, "do");
      history = recordEdit(history, made);
    }
    expect(history.past).toHaveLength(1);
    const undone = undo(current, history);
    expect(undone?.doc).toEqual(doc());
    expect(undone?.changes).toHaveLength(1);
    const redone = undone && redo(undone.doc, undone.history);
    expect(redone?.doc).toEqual(current);
  });

  it("keeps separate undo steps for pauses and for different fields", () => {
    let history = emptyHistory();
    const original = doc();
    const first = setStepText(original, "s1", "A", stamp(0));
    const later = setStepText(original, "s1", "B", stamp(5000));
    const other = setStepText(original, "s2", "C", stamp(5100));
    if (!first || !later || !other) throw new Error("no edit");
    history = recordEdit(recordEdit(recordEdit(history, first), later), other);
    expect(history.past).toHaveLength(3);
  });

  it("clears redo after a new edit", () => {
    const original = doc();
    const made = deleteSteps(original, ["s1"], stamp());
    if (!made) throw new Error("no edit");
    const history = recordEdit(emptyHistory(), made);
    const undone = undo(applyChanges(original, made.changes, "do"), history);
    if (!undone) throw new Error("no undo");
    const again = setStepText(undone.doc, "s2", "x", stamp(9999));
    if (!again) throw new Error("no edit");
    expect(recordEdit(undone.history, again).future).toHaveLength(0);
  });
});

describe("find and replace in text", () => {
  it("finds a term in wording, notes and blocks, and replaces it as one undoable edit", () => {
    const original: EditorDoc = {
      guide,
      steps: [
        step("s1", "1", "Open the ACME portal"),
        {
          ...step("s2", "2", "Click Save"),
          notes: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Acme staff only", marks: [{ type: "bold" }] }],
              },
            ],
          },
        },
        {
          ...blockStep("b", "tip", stamp()),
          sortKey: "3",
          block: { type: "tip", heading: "Acme tip", body: null },
        },
        step("s4", "4", "Click Close"),
      ],
    };
    expect(stepsWithText(original, "acme").map((item) => item.id)).toEqual(["s1", "s2", "b"]);
    const replaced = roundTrips(original, replaceText(original, "acme", "the client", stamp()));
    expect(texts(replaced)[0]).toBe("Open the the client portal");
    expect(replaced.steps[0]?.textEdited).toBe(true);
    expect(JSON.stringify(replaced)).not.toMatch(/acme/i);
    // Formatting in notes is kept.
    expect(JSON.stringify(replaced.steps[1]?.notes)).toContain('"bold"');
    expect(replaceText(original, "  ", "x", stamp())).toBeNull();
    expect(replaceText(original, "nowhere", "x", stamp())).toBeNull();
  });
});

describe("code steps (docs/spec/04-editor.md#code-steps)", () => {
  const command = (id: string, sortKey: string, text: string, output: string | null = null) => ({
    ...step(id, sortKey, "Run in PowerShell"),
    action: "command",
    code: { text, language: "powershell" as const, output, outputShortened: false },
  });
  const doc = (): EditorDoc => ({
    guide,
    steps: [
      command("c1", "a", "cd C:\\Temp", "done"),
      command("c2", "b", "Get-ChildItem -Filter secret*", "a.txt"),
    ],
  });
  // Every edit here must also undo cleanly.
  const after = (edit: Edit | null, from = doc()) => roundTrips(from, edit);

  it("rewords a command when its language changes, unless the wording was edited", () => {
    const changed = after(setStepCode(doc(), "c1", { language: "cmd" }, "edit code", stamp()));
    expect(changed.steps[0]?.actionText).toBe("Run in Command Prompt");
    const edited: EditorDoc = {
      ...doc(),
      steps: doc().steps.map((item) => ({ ...item, textEdited: true })),
    };
    const kept = after(
      setStepCode(edited, "c1", { language: "cmd" }, "edit code", stamp()),
      edited,
    );
    expect(kept.steps[0]?.actionText).toBe("Run in PowerShell");
    expect(kept.steps[0]?.code?.language).toBe("cmd");
  });

  it("removes output for good, and merges two commands into one script", () => {
    const removed = after(removeStepOutput(doc(), "c1", "remove output", stamp()));
    expect(removed.steps[0]?.code?.output).toBeNull();
    const merged = after(mergeWithNext(doc(), "c1", stamp()));
    expect(merged.steps).toHaveLength(1);
    expect(merged.steps[0]?.actionText).toBe("Run in PowerShell");
    expect(merged.steps[0]?.code?.text).toBe("cd C:\\Temp\nGet-ChildItem -Filter secret*");
    expect(merged.steps[0]?.code?.output).toBe("done\na.txt");
  });

  it("are found and replaced by Find & Blur, code and output alike", () => {
    expect(stepsWithText(doc(), "a.txt").map((item) => item.id)).toEqual(["c2"]);
    const replaced = after(replaceText(doc(), "secret", "report", stamp()));
    expect(replaced.steps[1]?.code?.text).toBe("Get-ChildItem -Filter report*");
  });
});
