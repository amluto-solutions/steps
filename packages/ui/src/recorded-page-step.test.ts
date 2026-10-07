import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECORDING_SETTINGS,
  ENGLISH,
  parseStep,
  recordingFactSchema,
  wordStepIn,
  type ClickNaming,
  type RecordedStep,
  type RecordingFact,
  type StepWording,
} from "@amluto-steps/core";
import table from "../../core/src/step-text/click-naming.cases.json";
import { factToStep as makeStep, orderRecordedSteps } from "./recorded-step";

const wording = ENGLISH;

/** Every step these tests make, to check below that each words itself again from its facts. */
const made: RecordedStep[] = [];
const factToStep = (fact: RecordingFact, words: StepWording) => {
  const step = makeStep(fact, words, DEFAULT_RECORDING_SETTINGS);
  if (step) made.push(step);
  return step;
};

const page = {
  tabId: 7,
  title: "Invoices - Finance portal",
  origin: "https://finance.example.test",
};

const fact = (sequence: number, record: RecordingFact["record"]): RecordingFact =>
  recordingFactSchema.parse({ sessionId: "s1", recordedAt: 1_790_000_000_000, sequence, record });

const click = (
  sequence: number,
  tickMs: number,
  target: Record<string, string> | null,
  title = page.title,
) =>
  fact(sequence, {
    kind: "pageClick",
    id: sequence,
    tickMs,
    page: { ...page, title },
    capture: { image: `shot-${sequence}.webp`, width: 1920, height: 1080, scale: 1 },
    target,
    clickPct: { x: 50, y: 25 },
    elementPct: { x: 45, y: 22, w: 10, h: 6 },
  });

describe("steps from web pages (the Chrome edition)", () => {
  it("words a click from the page's own facts, with its screenshot and highlight", () => {
    const step = factToStep(click(1, 100, { tagName: "BUTTON", innerText: "Approve" }), wording);
    expect(step).toMatchObject({
      actionText: 'Click "Approve"',
      textParts: { verb: "click", target: "Approve", kind: "button" },
      context: { app: null, windowTitle: "Invoices - Finance portal" },
      media: { id: "shot-1", width: 1920, height: 1080, captureRect: null },
      highlight: { shape: "circle" },
      target: { tagName: "BUTTON", innerText: "Approve" },
    });
    expect(step?.reviewRequired).toBeFalsy();
    // It's a valid guide step as it stands.
    expect(() => parseStep(step)).not.toThrow();
  });

  it("keeps its naming, named by the page", () => {
    const step = factToStep(click(1, 100, { tagName: "BUTTON", innerText: "Approve" }), wording);
    expect(step?.naming).toEqual({
      name: "Approve",
      kind: "button",
      source: "page",
      needsReview: false,
    });
  });

  it("falls back to the page's title when nothing names what was clicked, and flags it", () => {
    const step = factToStep(click(1, 100, { tagName: "DIV" }), wording);
    expect(step).toMatchObject({
      actionText: 'Click in "Invoices - Finance portal"',
      reviewRequired: true,
      naming: { name: "Invoices - Finance portal", source: "window", needsReview: true },
    });
  });

  it("words typing with and without its value", () => {
    const typed = (value: string | null) =>
      factToStep(
        fact(2, {
          kind: "pageInput",
          tickMs: 200,
          page,
          target: { tagName: "INPUT", labelText: "Supplier" },
          value,
          withheld: value === null ? "sensitive" : null,
        }),
        wording,
      );
    expect(typed("Acme Ltd")).toMatchObject({
      actionText: 'Type "Acme Ltd" in "Supplier" field',
      showValue: true,
      textParts: { value: "Acme Ltd" },
    });
    expect(typed(null)).toMatchObject({ actionText: 'Type in "Supplier" field', showValue: false });
  });

  it("names a site visited by its origin only", () => {
    const step = factToStep(
      fact(3, {
        kind: "pageNavigation",
        tickMs: 300,
        page,
        origin: "https://finance.example.test",
      }),
      wording,
    );
    expect(step?.actionText).toBe('Go to "https://finance.example.test"');
  });

  it("refuses a page fact that carries a full address or an unknown fact", () => {
    expect(() =>
      fact(3, { kind: "pageNavigation", tickMs: 1, page, origin: "https://x.test/secret?token=1" }),
    ).toThrow();
    expect(() =>
      recordingFactSchema.parse({
        sessionId: "s1",
        recordedAt: 1,
        sequence: 1,
        record: {
          kind: "pageInput",
          tickMs: 1,
          page,
          target: { script: "x" },
          value: null,
          withheld: null,
        },
      }),
    ).toThrow();
  });

  it("puts typing before the click that ended it, not before a click in the same field", () => {
    const field = { tagName: "INPUT", labelText: "Supplier" };
    const facts = [
      click(1, 100, field),
      click(2, 900, { tagName: "BUTTON", innerText: "Save" }),
      fact(3, {
        kind: "pageInput",
        tickMs: 1000,
        page,
        target: field,
        value: "Acme",
        withheld: null,
      }),
    ];
    const steps = facts.map((each) => factToStep(each, wording)).filter((step) => step !== null);
    const ordered = orderRecordedSteps(steps, facts).map((step) => step.actionText);
    expect(ordered).toEqual([
      'Click "Supplier" field',
      'Type "Acme" in "Supplier" field',
      'Click "Save"',
    ]);
  });
});

interface Case {
  case: string;
  evidence: {
    element: Record<string, unknown> | null;
    window: { title: string };
    page?: Record<string, string>;
  };
  naming: ClickNaming;
  text: string;
}

/** What UI Automation reports for an element that tells it nothing (the table leaves these out). */
const BLANK = {
  controlType: "Pane",
  localizedControlType: "",
  name: "",
  automationId: "",
  helpText: "",
  ariaRole: "",
  ariaProperties: "",
  className: "",
  frameworkId: "",
  isPassword: false,
  labeledBy: null,
  bounds: null,
  ancestors: [],
  sensitive: false,
};

/** The same click as the desktop records it, told what the element was through the link. */
const desktopClick = (sequence: number, { element, window, page: target }: Case["evidence"]) =>
  fact(sequence, {
    kind: "click",
    id: sequence,
    tickMs: 100,
    button: "left",
    injected: false,
    x: 1,
    y: 1,
    window: {
      title: window.title,
      exe: "msedge.exe",
      pid: 40,
      frame: { left: 0, top: 0, right: 100, bottom: 100 },
      elevation: "notElevated",
      remoteSession: false,
    },
    element: element && { ...BLANK, ...element },
    elementPct: null,
    uia: { status: "ok", ms: 1, retried: false, error: null },
    screenshotMs: 1,
    queueDelayMs: 0,
    capture: {
      mode: "window",
      rect: { left: 0, top: 0, right: 100, bottom: 100 },
      monitor: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      width: 100,
      height: 100,
      image: `click-${sequence}.webp`,
    },
    clickPct: { x: 50, y: 25 },
    ...(target ? { page: { target } } : {}),
  });

// Every case in the naming table with page facts is a click Steps for Chrome records too, from the
// page facts alone and the tab's title; the desktop hears the same facts through the extension
// link (docs/spec/02-capture.md#click-naming).
const pageCases = (table.cases as Case[]).filter((entry) => entry.evidence.page !== undefined);

describe("Steps for Chrome and the desktop name a page click the same way", () => {
  it("has page cases to compare", () => expect(pageCases.length).toBeGreaterThan(3));

  it.each(pageCases.map((entry) => [entry.case, entry] as const))("%s", (_, entry) => {
    const inChrome = factToStep(
      click(1, 100, entry.evidence.page ?? null, entry.evidence.window.title),
      wording,
    );
    const onDesktop = factToStep(desktopClick(2, entry.evidence), wording);
    for (const step of [inChrome, onDesktop]) {
      expect(step?.naming).toEqual(entry.naming);
      expect(step?.actionText).toBe(entry.text);
      expect(step?.reviewRequired ?? false).toBe(entry.naming.needsReview);
    }
    // And reworded into another language and tone.
    expect(inChrome && wordStepIn(inChrome, "de", "formal")).toBe(
      onDesktop && wordStepIn(onDesktop, "de", "formal"),
    );
  });
});

// Rewording a guide (Language and tone, docs/spec/04-editor.md#language-and-tone) works the words
// out again from what each step stored: in English and the casual tone, that must give back exactly
// what was recorded.
describe("every recorded step words itself again from its facts", () => {
  it("gives back its words in English, casual", () => {
    expect(made.length).toBeGreaterThan(5);
    for (const step of made)
      expect({ id: step.id, words: wordStepIn(step, "en", "casual") }).toEqual({
        id: step.id,
        words: step.actionText,
      });
  });
});
