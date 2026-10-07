import { describe, expect, it } from "vitest";
import { parseGuide, type GuideStep } from "@amluto-steps/core";

import { blankStep } from "../editor/edits";
import { changeLanguageAndTone } from "../editor/languages";
import { applyChanges } from "../editor/document";
import { screenWords } from "../screen-words";
import { fakeScreenshot, fakeTextReader } from "../bridge/screen-words-fake";
import { nameFromScreen } from "./screen-names";

/** A click the recording named only by its window, as the recorder stores one. */
const unnamed = (id: string, mediaId = `m-${id}`): GuideStep => ({
  ...blankStep(id, { at: 0, by: "Robin" }),
  kind: "interaction",
  action: "click",
  actionText: 'Click in "Settings"',
  textParts: { verb: "click", target: "Settings", kind: "window" },
  textEdited: false,
  context: { app: "SystemSettings.exe", windowTitle: "Settings" },
  naming: { name: "Settings", kind: "other", source: "window", needsReview: true },
  reviewRequired: true,
  media: { id: mediaId, width: 100, height: 100, scale: 1, captureRect: null },
  highlight: { shape: "circle", x: 9, y: 25, w: 2, h: 2 },
});
const wording = { language: "en", tone: "casual" } as const;
const system = [{ words: [{ text: "System", x: 8, y: 25, w: 6, h: 2 }] }];
const wordsOf = (lines: Parameters<typeof fakeTextReader>[0]) =>
  screenWords(fakeTextReader(lines), async (id) => fakeScreenshot(id));

describe("naming clicks from their screenshots (F016)", () => {
  it("names a click from the words at it, stored as read from the screen and to check", async () => {
    const [named, still] = await nameFromScreen(
      [unnamed("a"), unnamed("b", "empty")],
      wordsOf({ "m-a": system, empty: [] }),
      wording,
    );
    expect(named?.actionText).toBe('Click "System"');
    expect(named?.naming).toEqual({
      name: "System",
      kind: "other",
      source: "screen",
      needsReview: true,
    });
    expect(named?.reviewRequired).toBe(true);
    expect(still?.actionText).toBe('Click in "Settings"');
    expect(still?.naming?.source).toBe("window");
    expect(still?.reviewRequired).toBe(true);
  });

  it("names an unnamed icon by the label under its own outline (07/10/2026)", async () => {
    // A side-rail icon labelled underneath, with a button's label on the click's row.
    const rail = [
      { words: [{ text: "CREATE", x: 18.2, y: 26.3, w: 3.8, h: 2.2 }] },
      { words: [{ text: "Email", x: 9.2, y: 28.9, w: 2.2, h: 1.8 }] },
    ];
    const outlines = new Map([["a", { x: 8.3, y: 23.2, w: 3.9, h: 4.3 }]]);
    const [withOutline] = await nameFromScreen(
      [unnamed("a")],
      wordsOf({ "m-a": rail }),
      wording,
      outlines,
    );
    expect(withOutline?.actionText).toBe('Click "Email"');
    const [without] = await nameFromScreen([unnamed("a")], wordsOf({ "m-a": rail }), wording);
    expect(without?.actionText).toBe('Click "CREATE"');
  });

  it("keeps a right-click a right-click", async () => {
    const right = { ...unnamed("a"), textParts: { ...unnamed("a").textParts, verb: "rightClick" } };
    const [step] = await nameFromScreen([right], wordsOf({ "m-a": system }), wording);
    expect(step?.actionText).toBe('Right-click "System"');
  });

  it("leaves a click unnamed, to check, when its screenshot couldn't be read", async () => {
    const [step] = await nameFromScreen([unnamed("a")], wordsOf({ "m-a": "unavailable" }), wording);
    expect(step?.actionText).toBe('Click in "Settings"');
    expect(step?.reviewRequired).toBe(true);
  });

  it("never names a click from words under its step's blur", async () => {
    const blurred = {
      ...unnamed("a"),
      redactions: [{ x: 7, y: 24, w: 9, h: 4, source: "manual" as const }],
    };
    const [step] = await nameFromScreen([blurred], wordsOf({ "m-a": system }), wording);
    expect(step?.actionText).toBe('Click in "Settings"');
  });

  it("keeps the name when the guide is reworded into another language and tone", async () => {
    // The bug: rewording turned such a step back into "Click in <window>".
    const [named] = await nameFromScreen([unnamed("a")], wordsOf({ "m-a": system }), wording);
    if (!named) throw new Error("no step");
    const doc = {
      guide: parseGuide({
        id: "g1",
        title: "Settings",
        createdAt: "2026-10-06T10:00:00Z",
        updatedAt: "2026-10-06T10:00:00Z",
        formatVersion: 1,
      }),
      steps: [named],
    };
    const edit = changeLanguageAndTone(doc, "de", "formal", new Set(["a"]), { at: 1, by: "Robin" });
    if (!edit) throw new Error("no edit");
    const [german] = applyChanges(doc, edit.changes, "do").steps;
    expect(german?.actionText).toContain("System");
    expect(german?.actionText).not.toContain("Settings");
  });
});
