import { parseGuide, parseStep, type GuideStep } from "@amluto-steps/core";
import { describe, expect, it } from "vitest";

import { applyChanges, type EditorDoc } from "./document";
import {
  changeLanguageAndTone,
  rewordings,
  setBlockIn,
  setStepNotesIn,
  setStepTextIn,
  updateGuideIn,
} from "./languages";

const stamp = { at: Date.parse("2026-10-01T12:00:00Z"), by: "Robin" };
const rich = (text: string) => ({
  type: "doc" as const,
  content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
});

const step = (id: string, extra: Record<string, unknown> = {}): GuideStep =>
  parseStep({
    id,
    sortKey: id,
    kind: "interaction",
    action: "click",
    actionText: 'Click "Save"',
    textParts: { verb: "click", target: "Save", kind: "button" },
    showValue: false,
    context: { app: null, windowTitle: "Suppliers" },
    target: { tagName: "BUTTON", innerText: "Save" },
    media: null,
    highlight: null,
    capturedAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    formatVersion: 1,
    ...extra,
  });

const doc = (): EditorDoc => ({
  guide: parseGuide({
    id: "g1",
    title: "Add a supplier",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    formatVersion: 1,
  }),
  steps: [
    step("a"),
    step("b", { textEdited: true, actionText: "Save it", notes: rich("Check first") }),
    step("c", {
      kind: "block",
      action: "block",
      actionText: "",
      textParts: { verb: "", target: "", kind: "block" },
      target: null,
      block: { type: "callout", heading: "Note", body: rich("Ask finance") },
    }),
  ],
});

const apply = (current: EditorDoc, edit: ReturnType<typeof setStepTextIn>) =>
  edit ? applyChanges(current, edit.changes, "do") : current;

describe("editing in the language shown", () => {
  it("changes the guide's own words in its main language, as always", () => {
    const after = apply(doc(), setStepTextIn(doc(), "a", "Press Save", "en", stamp));
    expect(after.steps[0]).toMatchObject({ actionText: "Press Save", textEdited: true });
    expect(after.steps[0]?.translations).toBeUndefined();
  });

  it("writes another language's words beside them, leaving the main language as it was", () => {
    let current = doc();
    current = apply(current, setStepTextIn(current, "b", "Speichern", "de", stamp));
    current = apply(current, setStepNotesIn(current, "b", rich("Erst prüfen"), "de", stamp));
    const block = current.steps[2]?.block;
    if (!block) throw new Error("no block");
    current = apply(
      current,
      setBlockIn(current, "c", { ...block, heading: "Hinweis" }, "de", "edit block", stamp, "h:c"),
    );
    // Changing a block's kind is the block's own, whatever language is shown.
    current = apply(
      current,
      setBlockIn(current, "c", { ...block, type: "warning" }, "de", "edit block", stamp, "t:c"),
    );
    const edited = updateGuideIn(current, { title: "Lieferant anlegen" }, "de", "title", stamp);
    current = applyChanges(current, edited.changes, "do");

    expect(current.steps[1]).toMatchObject({
      actionText: "Save it",
      notes: rich("Check first"),
      translations: { de: { actionText: "Speichern", notes: rich("Erst prüfen") } },
    });
    expect(current.steps[2]?.block).toMatchObject({ type: "warning", heading: "Note" });
    expect(current.steps[2]?.translations?.de).toMatchObject({ heading: "Hinweis" });
    expect(current.guide).toMatchObject({
      title: "Add a supplier",
      translations: { de: { title: "Lieferant anlegen" } },
    });
  });
});

describe("Language and tone", () => {
  it("previews each step: reworded, already so, changed by hand, or nothing to reword", () => {
    const preview = rewordings(doc(), "en", "plain");
    expect(preview.map((item) => [item.status, item.after])).toEqual([
      ["change", 'Select the "Save" button'],
      ["edited", 'Select the "Save" button'],
      ["none", ""],
    ]);
    expect(rewordings(doc(), "en", "casual")[0]?.status).toBe("same");
  });

  it("rewords the steps chosen and remembers the tone, as one edit that Undo reverses", () => {
    const before = doc();
    const edit = changeLanguageAndTone(before, "en", "formal", new Set(["a", "b"]), stamp);
    if (!edit) throw new Error("no edit");
    const after = applyChanges(before, edit.changes, "do");
    expect(after.guide.tone).toBe("formal");
    expect(after.steps[0]?.actionText).toBe('Click the "Save" button.');
    // Chosen though changed by hand: worded afresh, and no longer marked.
    expect(after.steps[1]).toMatchObject({
      actionText: 'Click the "Save" button.',
      textEdited: false,
    });
    expect(applyChanges(after, edit.changes, "undo")).toEqual(before);
    expect(changeLanguageAndTone(before, "en", "casual", new Set(), stamp)).toBeNull();
  });

  it("swaps the main words with the new language's, keeping the old ones, and back again", () => {
    let current = doc();
    current = apply(current, setStepTextIn(current, "b", "Speichern", "de", stamp));
    current = applyChanges(
      current,
      updateGuideIn(current, { title: "Lieferant anlegen" }, "de", "title", stamp).changes,
      "do",
    );
    const toGerman = changeLanguageAndTone(current, "de", "casual", new Set(), stamp);
    if (!toGerman) throw new Error("no edit");
    const german = applyChanges(current, toGerman.changes, "do");
    expect(german.guide).toMatchObject({
      language: "de",
      title: "Lieferant anlegen",
      translations: { en: { title: "Add a supplier" } },
    });
    expect(german.steps[1]).toMatchObject({
      actionText: "Speichern",
      textEdited: true,
      translations: { en: { actionText: "Save it" } },
    });
    // Its notes were never written in German: they stay where they are, filed under nothing new.
    expect(german.steps[1]?.notes).toEqual(rich("Check first"));
    expect(german.steps[1]?.translations?.en?.notes).toBeUndefined();
    // The block wasn't written in German, so its English words stay as the main ones.
    expect(german.steps[2]?.block?.heading).toBe("Note");

    const back = changeLanguageAndTone(german, "en", "casual", new Set(), stamp);
    if (!back) throw new Error("no edit");
    const english = applyChanges(german, back.changes, "do");
    expect(english.guide.title).toBe("Add a supplier");
    expect(english.guide.translations?.de?.title).toBe("Lieferant anlegen");
    expect(english.steps[1]).toMatchObject({
      actionText: "Save it",
      notes: rich("Check first"),
      translations: { de: { actionText: "Speichern" } },
    });
    expect(english.steps[1]?.translations?.de?.notes).toBeUndefined();
  });
});
