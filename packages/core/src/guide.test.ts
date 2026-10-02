import { describe, expect, it } from "vitest";

import { guideStepSchema, parseGuide, parseStep, richTextSchema } from "./guide.ts";

const recordedStep = {
  id: "capture-3",
  sortKey: "0000000003",
  kind: "interaction",
  action: "click",
  actionText: 'Click "Save"',
  textParts: { verb: "click", target: "Save", kind: "button" },
  showValue: false,
  textEdited: false,
  notes: null,
  altText: null,
  context: { app: "msedge.exe", windowTitle: "Contacts" },
  target: null,
  media: { id: "click-3", width: 1920, height: 1080, scale: 1, captureRect: [0, 0, 1920, 1080] },
  highlight: { shape: "circle", x: 40, y: 50, w: 3.1, h: 5.5 },
  crop: null,
  redactions: [],
  annotations: [],
  block: null,
  capturedAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
};

const doc = (content: unknown[]) => ({ type: "doc", content });

describe("step files", () => {
  it("read a recorded step unchanged", () => {
    expect(parseStep(recordedStep)).toEqual(recordedStep);
  });

  it("fill fields older recordings didn't write", () => {
    const older: Record<string, unknown> = { ...recordedStep };
    delete older.crop;
    delete older.annotations;
    const step = parseStep(older);
    expect(step.crop).toBeNull();
    expect(step.annotations).toEqual([]);
  });

  it("drop unknown fields and refuse a newer format", () => {
    const step = parseStep({ ...recordedStep, secret: "x" });
    expect("secret" in step).toBe(false);
    expect(() => parseStep({ ...recordedStep, formatVersion: 2 })).toThrow(/newer version/);
  });

  it("keep annotations, blur and crop in percentages", () => {
    const step = guideStepSchema.parse({
      ...recordedStep,
      annotations: [
        { type: "arrow", from: [10, 10], to: [40, 50] },
        { type: "label", x: 20, y: 20, text: "Pick your team" },
        { type: "box", x: 1, y: 2, w: 3, h: 4 },
      ],
      redactions: [{ x: 1, y: 1, w: 10, h: 5, source: "manual" }],
      crop: { x: 0, y: 0, w: 50, h: 50, source: "manual" },
    });
    expect(step.annotations).toHaveLength(3);
    expect(() =>
      guideStepSchema.parse({ ...recordedStep, annotations: [{ type: "script", code: "x" }] }),
    ).toThrow();
  });
});

describe("rich text", () => {
  it("accepts the allowed nodes and marks", () => {
    const text = doc([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Before" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Bold", marks: [{ type: "bold" }] },
          {
            type: "text",
            text: "link",
            marks: [{ type: "link", attrs: { href: "https://amluto.com" } }],
          },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
          },
        ],
      },
    ]);
    expect(richTextSchema.parse(text)).toEqual(text);
  });

  it("refuses script links, unknown nodes and a missing document root", () => {
    const badLink = doc([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "x",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      },
    ]);
    expect(() => richTextSchema.parse(badLink)).toThrow();
    expect(() => richTextSchema.parse(doc([{ type: "image", attrs: { src: "x" } }]))).toThrow();
    expect(() => richTextSchema.parse({ type: "paragraph" })).toThrow();
  });

  it("drops attributes it doesn't know, such as link targets", () => {
    const parsed = richTextSchema.parse(
      doc([
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [{ type: "link", attrs: { href: "https://a.b", target: "_blank" } }],
            },
          ],
        },
      ]),
    );
    expect(JSON.stringify(parsed)).not.toContain("_blank");
  });
});

describe("guide files", () => {
  it("fill defaults for the fields a recording leaves out", () => {
    const guide = parseGuide({
      id: "session-1",
      title: "Add a supplier",
      createdAt: "2026-09-25T10:00:00.000Z",
      updatedAt: "2026-09-25T10:00:00.000Z",
      formatVersion: 1,
      stepCount: 4,
    });
    expect(guide.tags).toEqual([]);
    expect(guide.intro).toBeNull();
    expect("stepCount" in guide).toBe(false);
  });

  it("take only a language code as the language: it goes into exported pages' markup", () => {
    const file = (language: string) => ({
      id: "g1",
      title: "Add a supplier",
      createdAt: "2026-09-25T10:00:00.000Z",
      updatedAt: "2026-09-25T10:00:00.000Z",
      formatVersion: 1,
      language,
    });
    expect(parseGuide(file("pt-BR")).language).toBe("pt-BR");
    expect(parseGuide(file("sr-Latn")).language).toBe("sr-Latn");
    expect(() => parseGuide(file('en"><script>x'))).toThrow();
  });
});
