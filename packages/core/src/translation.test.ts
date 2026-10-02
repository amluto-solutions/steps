import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseGuide, parseStep, type GuideStep } from "./guide.ts";
import { en } from "./step-text/phrasebooks/en.ts";
import { PHRASEBOOKS } from "./step-text/phrasebooks/index.ts";
import {
  docIn,
  guideIn,
  hasWords,
  mainLanguage,
  stepIn,
  writeGuideText,
  writeStepText,
  writtenLanguages,
} from "./translation.ts";

const rich = (text: string) => ({
  type: "doc" as const,
  content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
});

const guide = parseGuide({
  id: "g1",
  title: "Add a supplier",
  description: "For the finance team",
  intro: rich("Before you start"),
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  formatVersion: 1,
});

const click = (id: string, extra: Record<string, unknown> = {}): GuideStep =>
  parseStep({
    id,
    sortKey: "a0",
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

// A stand-in German phrasebook: the real ones are written later, from the English.
beforeAll(() => {
  PHRASEBOOKS.de = {
    ...en,
    casual: { ...en.casual, click: { other: "Klicke auf „{name}“" } },
    formal: {
      ...en.formal,
      click: { button: "Klicken Sie auf die Schaltfläche „{name}“.", other: "x" },
    },
  };
});
afterAll(() => {
  delete PHRASEBOOKS.de;
});

describe("a guide in another language", () => {
  it("is itself in its main language, English when it says none", () => {
    expect(mainLanguage(guide)).toBe("en");
    expect(guideIn(guide, "en").guide).toBe(guide);
    expect(stepIn(click("s1"), "en", guide).step.actionText).toBe('Click "Save"');
  });

  it("shows what was written in a language, and the main language where nothing was", () => {
    const german = writeGuideText(guide, "de", { title: "Lieferanten anlegen" });
    const shown = guideIn(german, "de");
    expect(shown.guide.title).toBe("Lieferanten anlegen");
    expect(shown.guide.description).toBe("For the finance team");
    expect(shown.sources).toEqual({
      title: "written",
      description: "missing",
      intro: "missing",
      // Nothing to translate.
      outro: "main",
    });
  });

  it("words a recorded step in the language, and keeps hand-written words for it", () => {
    expect(stepIn(click("s1"), "de", guide)).toMatchObject({
      step: { actionText: "Klicke auf „Save“" },
      sources: { actionText: "worded", notes: "main" },
    });
    expect(stepIn(click("s1"), "de", { language: "en", tone: "formal" }).step.actionText).toBe(
      "Klicken Sie auf die Schaltfläche „Save“.",
    );
    // Changed by hand: the words can't be worked out, so they're English until written in German.
    const edited = click("s2", {
      textEdited: true,
      actionText: "Save it",
      notes: rich("Check first"),
    });
    expect(stepIn(edited, "de", guide).sources).toMatchObject({
      actionText: "missing",
      notes: "missing",
    });
    const written = writeStepText(edited, "de", { actionText: "Speichern", notes: null });
    expect(stepIn(written, "de", guide)).toMatchObject({
      step: { actionText: "Speichern", notes: null },
      sources: { actionText: "written", notes: "written" },
    });
    // The main language is untouched.
    expect(written.actionText).toBe("Save it");
  });

  it("lists what's missing in the guide's order, and which languages have anything", () => {
    const steps = [
      click("s1"),
      click("s2", { textEdited: true, actionText: "Save it" }),
      writeStepText(click("s3", { altText: "The supplier form" }), "fr", {
        altText: "Le formulaire",
      }),
    ];
    const { missing, doc } = docIn({ guide, steps }, "de");
    expect(missing).toEqual([
      { stepId: null, field: "title" },
      { stepId: null, field: "description" },
      { stepId: null, field: "intro" },
      { stepId: "s2", field: "actionText" },
      { stepId: "s3", field: "altText" },
    ]);
    expect(doc.steps[0]?.actionText).toBe("Klicke auf „Save“");
    expect(writtenLanguages({ guide: writeGuideText(guide, "it", {}), steps })).toEqual([
      "fr",
      "it",
    ]);
  });

  it("keeps translations through the file format, for every language code shape", () => {
    const step = parseStep(
      writeStepText(writeStepText(click("s1"), "sr-Latn", { actionText: "Kliknite" }), "zh-Hant", {
        actionText: "按一下",
      }),
    );
    expect(step.translations).toEqual({
      "sr-Latn": { actionText: "Kliknite" },
      "zh-Hant": { actionText: "按一下" },
    });
    expect(() => parseStep({ ...click("s1"), translations: { "../x": {} } })).toThrow();
    expect(hasWords(rich(""))).toBe(false);
    expect(hasWords(rich("x"))).toBe(true);
  });
});
