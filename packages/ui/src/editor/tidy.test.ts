import { describe, expect, it } from "vitest";
import type { Guide, GuideStep } from "@amluto-steps/core";

import { applyChanges, type EditorDoc } from "./document";
import { blankStep } from "./edits";
import { applySuggestions, tidySuggestions } from "./tidy";

const stamp = { at: 1_790_000_000_000, by: "Robin" };
const guide = { id: "g" } as Guide;

const step = (id: string, sortKey: string, patch: Partial<GuideStep>): GuideStep => ({
  ...blankStep(id, stamp),
  sortKey,
  textEdited: false,
  capturedAt: "2026-09-25T10:00:00.000Z",
  ...patch,
});

const click = (
  id: string,
  key: string,
  target: string,
  at = "2026-09-25T10:00:00.000Z",
  app = "chrome.exe",
) =>
  step(id, key, {
    action: "click",
    actionText: `Click "${target}"`,
    textParts: { verb: "click", target, kind: "button" },
    capturedAt: at,
    context: { app, windowTitle: "" },
    media: { id: `m-${id}`, width: 100, height: 100, scale: 1, captureRect: null },
  });

describe("Tidy guide", () => {
  it("merges a click into a field with the typing that follows it", () => {
    const doc: EditorDoc = {
      guide,
      steps: [
        click("c", "a", "Customer name"),
        step("t", "b", {
          action: "input",
          actionText: 'Type "Acme" in "Customer name"',
          textParts: { verb: "input", target: "Customer name", kind: "field", value: "Acme" },
        }),
      ],
    };
    const [suggestion] = tidySuggestions(doc, stamp);
    expect(suggestion?.kind).toBe("mergeClickIntoTyping");
    const tidied = applyChanges(doc, suggestion?.changes ?? [], "do");
    expect(tidied.steps.map((item) => item.id)).toEqual(["t"]);
    // The typing step takes the click's screenshot, since it had none.
    expect(tidied.steps[0]?.media?.id).toBe("m-c");
  });

  it("keeps the blur, crop and marks that belong to the screenshot it keeps", () => {
    const blurred = {
      ...click("c", "a", "Card number"),
      redactions: [{ x: 10, y: 10, w: 20, h: 5, source: "manual" as const }],
      crop: { x: 0, y: 0, w: 50, h: 50, source: "manual" as const },
      annotations: [{ type: "label" as const, x: 5, y: 5, text: "Here" }],
      highlight: { shape: "box" as const, x: 1, y: 1, w: 2, h: 2 },
    };
    const doc: EditorDoc = {
      guide,
      steps: [
        blurred,
        step("t", "b", {
          action: "input",
          actionText: 'Type "••••1234" in "Card number"',
          textParts: { verb: "input", target: "Card number", kind: "field", value: "••••1234" },
        }),
      ],
    };
    const [suggestion] = tidySuggestions(doc, stamp);
    const [merged] = applyChanges(doc, suggestion?.changes ?? [], "do").steps;
    expect(merged?.media?.id).toBe("m-c");
    expect(merged?.redactions).toEqual(blurred.redactions);
    expect(merged?.crop).toEqual(blurred.crop);
    expect(merged?.annotations).toEqual(blurred.annotations);
    expect(merged?.highlight).toEqual(blurred.highlight);
  });

  it("removes a repeated click, but not the same click much later", () => {
    const doc: EditorDoc = {
      guide,
      steps: [
        click("a", "a", "Save", "2026-09-25T10:00:00.000Z"),
        click("b", "b", "Save", "2026-09-25T10:00:00.800Z"),
        click("c", "c", "Save", "2026-09-25T10:05:00.000Z"),
      ],
    };
    const suggestions = tidySuggestions(doc, stamp);
    expect(suggestions.map((item) => item.stepIds)).toEqual([["b"]]);
  });

  it("keeps strokes drawn one after another on a canvas: each is its own (#73)", () => {
    const stroke = (id: string, at: string) =>
      step(id, id, {
        action: "click",
        actionText: "Draw on the canvas",
        textParts: { verb: "draw", target: "Using Pencil tool on Canvas", kind: "canvas" },
        capturedAt: at,
        context: { app: "mspaint.exe", windowTitle: "Untitled - Paint" },
      });
    const doc: EditorDoc = {
      guide,
      steps: [stroke("a", "2026-09-25T10:00:00.000Z"), stroke("b", "2026-09-25T10:00:00.700Z")],
    };
    expect(tidySuggestions(doc, stamp)).toEqual([]);
  });

  it("drops an Open app step straight before a click in that app", () => {
    const doc: EditorDoc = {
      guide,
      steps: [
        step("o", "a", {
          action: "appswitch",
          actionText: 'Open "Excel"',
          context: { app: "EXCEL.EXE", windowTitle: "" },
        }),
        click("c", "b", "Save", undefined, "excel.exe"),
      ],
    };
    expect(tidySuggestions(doc, stamp).map((item) => item.kind)).toEqual(["removeOpenApp"]);
  });

  it("removes an Open step followed straight away by another Open", () => {
    const open = (id: string, key: string, app: string, exe: string) =>
      step(id, key, {
        action: "appswitch",
        actionText: `Open "${app}"`,
        context: { app: exe, windowTitle: "" },
      });
    const doc: EditorDoc = {
      guide,
      steps: [
        click("c", "a", "D2", undefined, "excel.exe"),
        // The 10/10/2026 Excel guide: RustDesk came forward by itself, then Excel again.
        open("r", "b", "RustDesk Remote Desktop", "rustdesk.exe"),
        open("e", "c", "Microsoft Excel", "EXCEL.EXE"),
        click("d", "d", "Save", undefined, "notepad.exe"),
      ],
    };
    expect(tidySuggestions(doc, stamp).map((item) => [item.kind, item.stepIds])).toEqual([
      ["removeOpenBeforeOpen", ["r"]],
    ]);
    // With a click in the second app after it, that "Open" goes too: the click shows it.
    const clickedIn: EditorDoc = {
      guide,
      steps: [...doc.steps.slice(0, 3), click("d", "d", "Save", undefined, "excel.exe")],
    };
    expect(tidySuggestions(clickedIn, stamp).map((item) => [item.kind, item.stepIds])).toEqual([
      ["removeOpenBeforeOpen", ["r"]],
      ["removeOpenApp", ["e"]],
    ]);
  });

  it("leaves an Open step alone when something was done before the next Open", () => {
    const open = (id: string, key: string, exe: string) =>
      step(id, key, {
        action: "appswitch",
        actionText: `Open "${exe}"`,
        context: { app: exe, windowTitle: "" },
      });
    const doc: EditorDoc = {
      guide,
      steps: [
        open("w", "a", "winword.exe"),
        click("c", "b", "Save", undefined, "notepad.exe"),
        open("e", "c", "excel.exe"),
        click("d", "d", "Copy", undefined, "notepad.exe"),
      ],
    };
    expect(tidySuggestions(doc, stamp)).toEqual([]);
  });

  it("keeps only where a link ended up, not the sites it passed through", () => {
    const goTo = (id: string, key: string, site: string, at: string) =>
      step(id, key, {
        action: "navigation",
        actionText: `Go to "${site}"`,
        capturedAt: at,
        context: { app: "msedge.exe", windowTitle: "" },
      });
    const doc: EditorDoc = {
      guide,
      steps: [
        click("c", "a", "Open the report"),
        goTo("n1", "b", "safelinks.test", "2026-09-25T10:00:01.000Z"),
        goTo("n2", "c", "login.test", "2026-09-25T10:00:02.500Z"),
        goTo("n3", "d", "portal.test", "2026-09-25T10:00:04.000Z"),
        // Much later: a separate visit, kept.
        goTo("n4", "e", "news.test", "2026-09-25T10:05:00.000Z"),
      ],
    };
    const found = tidySuggestions(doc, stamp);
    expect(found.map((item) => [item.kind, item.stepIds[0]])).toEqual([
      ["removeRedirect", "n1"],
      ["removeRedirect", "n2"],
    ]);
  });

  it("leaves reworded steps alone, and applies everything as one undo step", () => {
    const doc: EditorDoc = {
      guide,
      steps: [
        { ...click("a", "a", "Save"), textEdited: true },
        click("b", "b", "Save"),
        click("c", "c", "Next"),
        click("d", "d", "Next"),
      ],
    };
    const suggestions = tidySuggestions(doc, stamp);
    expect(suggestions.map((item) => item.stepIds)).toEqual([["d"]]);
    const edit = applySuggestions(suggestions, stamp);
    expect(edit?.changes).toHaveLength(1);
    const tidied = applyChanges(doc, edit?.changes ?? [], "do");
    expect(applyChanges(tidied, edit?.changes ?? [], "undo")).toEqual(doc);
  });
});
