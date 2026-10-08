import { describe, expect, it } from "vitest";

import { applyChanges, emptyHistory, recordEdit, undo, type EditorDoc } from "./document";
import { blankStep, insertStepsAt, type Stamp } from "./edits";
import { insertionIndex, withNewIds } from "./record-here";

const stamp: Stamp = { at: Date.parse("2026-10-08T10:00:00.000Z"), by: "Robin" };
const step = (id: string, sortKey: string, media: string | null = null) => ({
  ...blankStep(id, stamp),
  sortKey,
  actionText: id,
  media: media ? { id: media, width: 100, height: 100, scale: 1, captureRect: null } : null,
});

const guide: EditorDoc = {
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
    createdAt: "2026-10-08T10:00:00.000Z",
    createdBy: "Robin",
    updatedAt: "2026-10-08T10:00:00.000Z",
    updatedBy: "Robin",
    formatVersion: 1,
  },
  steps: [step("s1", "a", "click-1"), step("s2", "b", "click-2"), step("s3", "c")],
};

describe("Record steps here", () => {
  it("gives recorded steps and their screenshots new ids, a shared screenshot copied once", () => {
    let next = 0;
    const newId = (prefix: string) => `${prefix}-${(next += 1)}`;
    const recorded = [
      step("capture-1", "i", "click-1"),
      // Typing borrows the screenshot before it.
      step("capture-2", "i", "click-1"),
      step("capture-3", "i"),
    ];
    const { steps, media } = withNewIds(recorded, newId);
    expect(media).toEqual([{ mediaId: "click-1", newMediaId: "image-1" }]);
    expect(steps.map((item) => [item.id, item.media?.id ?? null])).toEqual([
      ["step-2", "image-1"],
      ["step-3", "image-1"],
      ["step-4", null],
    ]);
    // The recording's own steps are left as they were.
    expect(recorded[0]?.id).toBe("capture-1");
  });

  it("goes after the chosen step, or where it was if it has gone", () => {
    expect(insertionIndex(guide.steps, { afterId: "s2", afterIndex: 1 })).toBe(1);
    expect(insertionIndex(guide.steps, { afterId: null, afterIndex: -1 })).toBe(-1);
    // Deleted while recording: where it was.
    expect(insertionIndex(guide.steps, { afterId: "gone", afterIndex: 1 })).toBe(1);
    expect(insertionIndex(guide.steps.slice(0, 1), { afterId: "gone", afterIndex: 2 })).toBe(0);
  });

  it("inserts the steps in order as one edit, which one Undo takes back", () => {
    const recorded = [step("n1", "i"), step("n2", "i"), step("n3", "i")];
    const made = insertStepsAt(guide, recorded, 1, "add recorded steps", stamp);
    if (!made) throw new Error("nothing inserted");
    const after = applyChanges(guide, made.changes, "do");
    expect(after.steps.map((item) => item.id)).toEqual(["s1", "n1", "n2", "n3", "s2", "s3"]);
    // Only the new steps' files are written; the guide's own stay as they are.
    expect(made.changes.map((change) => (change.kind === "step" ? change.id : "guide"))).toEqual([
      "n1",
      "n2",
      "n3",
    ]);

    const stepped = undo(after, recordEdit(emptyHistory(), made));
    expect(stepped?.label).toBe("add recorded steps");
    expect(stepped?.doc.steps.map((item) => item.id)).toEqual(["s1", "s2", "s3"]);
    expect(insertStepsAt(guide, [], 1, "add recorded steps", stamp)).toBeNull();
  });

  it("makes room when the steps around are too close for new places between them", () => {
    const tight: EditorDoc = { ...guide, steps: [step("s1", "a"), step("s2", "a0")] };
    const made = insertStepsAt(tight, [step("n1", "i"), step("n2", "i")], 1, "add", stamp);
    if (!made) throw new Error("nothing inserted");
    expect(applyChanges(tight, made.changes, "do").steps.map((item) => item.id)).toEqual([
      "s1",
      "n1",
      "n2",
      "s2",
    ]);
  });
});
