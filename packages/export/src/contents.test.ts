import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Guide, GuideStep } from "@amluto-steps/core";

import { wordAnchor, renderDocx } from "./docx";
import { buildRenderModel, headerCount, sectionsOf } from "./model";
import { pdfDefinition, renderPdf, sectionAnchor, stepAnchor, type PdfFonts } from "./pdf";

const guide: Guide = {
  id: "g1",
  title: "Add a supplier",
  description: "",
  intro: null,
  outro: null,
  brandProfileId: null,
  tags: [],
  owner: "Sam Owner",
  reviewBy: "2027-03-01",
  createdAt: "2026-09-20T10:00:00.000Z",
  createdBy: "Robin",
  updatedAt: "2026-09-29T10:00:00.000Z",
  updatedBy: "Jo",
  formatVersion: 1,
};

const step = (id: string, patch: Partial<GuideStep> = {}): GuideStep => ({
  id,
  sortKey: id,
  kind: "interaction",
  action: "click",
  actionText: `Click "${id}"`,
  textParts: { verb: "click", target: id, kind: "button" },
  showValue: false,
  textEdited: false,
  notes: null,
  altText: null,
  context: { app: null, windowTitle: "" },
  target: null,
  media: null,
  highlight: null,
  crop: null,
  redactions: [],
  annotations: [],
  block: null,
  capturedAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
  ...patch,
});

const header = (id: string, heading: string) =>
  step(id, { kind: "block", block: { type: "header", heading, body: null } });

const steps = [
  step("a"),
  header("h1", "Set up"),
  step("b"),
  step("c"),
  header("h2", "Pay"),
  step("d"),
];

const versions = [
  { createdAt: "2026-09-21T09:00:00.000Z", createdBy: "Robin", note: "First draft", stepCount: 3 },
  { createdAt: "2026-09-28T09:00:00.000Z", createdBy: "Jo", note: "Checked", stepCount: 4 },
];

const model = (contents: boolean, control: boolean) =>
  buildRenderModel(guide, steps, new Map(), {
    preparedBy: "Robin",
    now: new Date(2026, 8, 30),
    contents,
    documentControl: control ? { versions } : null,
  });

describe("the contents page", () => {
  it("lists each header's section with its steps, and the steps before the first", () => {
    expect(headerCount(steps)).toBe(2);
    expect(sectionsOf(model(true, false).items)).toEqual([
      { id: null, heading: "First steps", first: 1, last: 1, firstStepId: "a" },
      { id: "h1", heading: "Set up", first: 2, last: 3, firstStepId: "b" },
      { id: "h2", heading: "Pay", first: 4, last: 4, firstStepId: "d" },
    ]);
    // Without headers there are no sections to list.
    expect(sectionsOf(model(true, false).items.filter((item) => item.kind === "step"))).toEqual([]);
    expect(model(false, false).contents).toBeNull();
  });

  it("links each section to its heading in the PDF, with its page, before the guide's first page", () => {
    const content = JSON.stringify(
      pdfDefinition(model(true, false), { pageSize: "A4", orientation: "portrait" }).content,
    );
    expect(content).toContain('"text":"Contents"');
    expect(content).toContain(`"linkToDestination":"${sectionAnchor("h1")}"`);
    expect(content).toContain(`"pageReference":"${sectionAnchor("h2")}"`);
    // "First steps" has no heading, so it points at its first step.
    expect(content).toContain(`"pageReference":"${stepAnchor("a")}"`);
    expect(content).toContain(`"id":"${sectionAnchor("h1")}"`);
    expect(content).toContain('"text":"Steps 2–3"');
    expect(content).toContain('"pageBreak":"before"');
  });
});

describe("the document-control page", () => {
  it("has the guide's details and its versions, newest first", () => {
    const control = model(false, true).control;
    expect(control).toMatchObject({
      owner: "Sam Owner",
      created: "20/09/2026",
      createdBy: "Robin",
      updated: "29/09/2026",
      updatedBy: "Jo",
      reviewBy: "01/03/2027",
    });
    expect(control?.versions.map((version) => version.note)).toEqual(["Checked", "First draft"]);
    const content = JSON.stringify(
      pdfDefinition(model(false, true), { pageSize: "A4", orientation: "portrait" }).content,
    );
    expect(content).toContain('"text":"Document control"');
    expect(content).toContain('"text":"20/09/2026 by Robin"');
    expect(content).toContain('"text":"Version history"');
  });

  it("builds a real PDF with both pages, and links that work", async () => {
    const require = createRequire(import.meta.url);
    const font = (file: string) =>
      new Uint8Array(readFileSync(require.resolve(`@fontsource/inter/files/${file}`)));
    const regular = font("inter-latin-400-normal.woff");
    const bold = font("inter-latin-700-normal.woff");
    const fonts: PdfFonts = {
      heading: { normal: bold, bold },
      body: { normal: regular, bold, italics: regular, bolditalics: bold },
    };
    const options = { pageSize: "A4", orientation: "portrait" } as const;
    const pages = (bytes: Uint8Array) =>
      (
        Buffer.from(bytes)
          .toString("latin1")
          .match(/\/Type \/Page\b/g) ?? []
      ).length;
    const plain = await renderPdf(model(false, false), fonts, options, false);
    const both = await renderPdf(model(true, true), fonts, options, false);
    expect(pages(both)).toBe(pages(plain) + 1);
    const text = Buffer.from(both).toString("latin1");
    expect(text).toContain("/Subtype /Link");
    expect(text).toContain("/Dests");
  }, 30_000);

  it("puts both into Word, with the sections bookmarked and linked", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await renderDocx(model(true, true)));
    const document = (await zip.file("word/document.xml")?.async("string")) ?? "";
    expect(document).toContain("Document control");
    expect(document).toContain("Version history");
    expect(document).toContain("Sam Owner");
    expect(document).toContain(`w:name="${wordAnchor("h1")}"`);
    expect(document).toContain(`w:anchor="${wordAnchor("h2")}"`);
    expect(document).toContain("Steps 2–3");
    expect(document).toContain('w:type="page"');
    expect(wordAnchor("a".repeat(60))).toHaveLength(40);
  }, 30_000);
});
