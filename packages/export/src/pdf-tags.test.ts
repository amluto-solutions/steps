import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Guide, GuideStep, RichText } from "@amluto-steps/core";

import { AMLUTO_LOOK, buildRenderModel } from "./model";
import { renderPdf, type PdfFonts } from "./pdf";

/**
 * Tagged PDF (docs/spec/05-export.md#tagged-pdf), read back with pdf.js as a screen reader's
 * PDF reader would: the structure tree, and whether every word on every page is either in it or
 * marked as decoration.
 */

const require = createRequire(import.meta.url);
const font = (file: string) =>
  new Uint8Array(readFileSync(require.resolve(`@fontsource/inter/files/${file}`)));
const regular = font("inter-latin-400-normal.woff");
const bold = font("inter-latin-700-normal.woff");
const fonts: PdfFonts = {
  heading: { normal: bold, bold },
  body: {
    normal: regular,
    bold,
    italics: font("inter-latin-400-italic.woff"),
    bolditalics: font("inter-latin-700-italic.woff"),
  },
};

const guide: Guide = {
  id: "g1",
  title: "Pay a supplier",
  description: "How finance pays an approved invoice.",
  intro: {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "You need" }] },
      {
        type: "orderedList",
        attrs: { start: 1 },
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Access to " },
                  {
                    type: "text",
                    text: "Xero",
                    marks: [{ type: "link", attrs: { href: "https://example.com/xero" } }],
                  },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "The invoice" }] }],
          },
        ],
      },
    ],
  } as RichText,
  outro: null,
  brandProfileId: null,
  tags: [],
  owner: "Sam Owner",
  reviewBy: null,
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

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface StructNode {
  role?: string;
  alt?: string;
  lang?: string;
  children?: (StructNode | { type: string; id: string })[];
}

async function readBack(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const trees: StructNode[] = [];
  /** Words outside any marked content, which a screen reader would never be sure about. */
  const unmarked: string[] = [];
  /** Each marked-content id with the words in it, and the words marked as decoration. */
  const marked = new Map<string, string>();
  const decoration: string[] = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    trees.push((await page.getStructTree()) as StructNode);
    const content = await page.getTextContent({ includeMarkedContent: true });
    const stack: { id: string | null; tag: string }[] = [];
    for (const item of content.items as Record<string, unknown>[]) {
      if (item.type === "beginMarkedContentProps" || item.type === "beginMarkedContent")
        stack.push({ id: (item.id as string | null) ?? null, tag: String(item.tag) });
      else if (item.type === "endMarkedContent") stack.pop();
      else if (typeof item.str === "string" && item.str.trim()) {
        const current = stack.at(-1);
        if (!current) unmarked.push(item.str);
        else if (current.tag === "Artifact") decoration.push(item.str);
        else if (current.id) marked.set(current.id, `${marked.get(current.id) ?? ""}${item.str}`);
      }
    }
  }
  const metadata = await document.getMetadata();
  /** The structure, as "Role: words" in reading order, the words drawn inside each element. */
  const outline: string[] = [];
  const figures: string[] = [];
  const visit = (node: StructNode, depth: number) => {
    for (const child of node.children ?? []) {
      if ("role" in child && child.role) {
        const words = (child.children ?? [])
          .filter(
            (each): each is { type: string; id: string } =>
              "type" in each && each.type === "content",
          )
          .map((each) => marked.get(each.id) ?? "")
          .join(" ")
          .trim();
        outline.push(`${"  ".repeat(depth)}${child.role}${words ? `: ${words}` : ""}`);
        if (child.role === "Figure") figures.push(child.alt ?? "");
        visit(child, depth + 1);
      }
    }
  };
  // pdf.js gives each page's part of the tree, from the root: the root is listed once.
  for (const tree of trees) if (tree) visit(tree, 0);
  const seen = outline.filter((line) => line === "Document").length;
  if (seen > 1)
    for (let index = outline.length - 1; index > 0; index -= 1)
      if (outline[index] === "Document") outline.splice(index, 1);
  return { outline, figures, unmarked, decoration, metadata, pages: document.numPages };
}

describe("tagged PDF", () => {
  it("tags every word and picture as what it is, in reading order", async () => {
    const steps = [
      step("header", {
        kind: "block",
        action: "manual",
        block: { type: "header", heading: "Paying", body: null },
      }),
      step("open", {
        actionText: 'Click "Bills"',
        media: { id: "m1", width: 1600, height: 900, scale: 1, captureRect: null },
        notes: {
          type: "doc",
          content: [
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "Check the total" }] },
                  ],
                },
              ],
            },
          ],
        } as RichText,
      }),
      step("tip", {
        kind: "block",
        action: "manual",
        block: {
          type: "tip",
          heading: "",
          body: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Pay before Friday." }] },
            ],
          } as RichText,
        },
      }),
    ];
    const model = buildRenderModel(
      guide,
      steps,
      new Map([["open", { dataUrl: pixel, width: 1600, height: 900 }]]),
      {
        preparedBy: "Robin",
        now: new Date(2026, 8, 30),
        brand: AMLUTO_LOOK,
        contents: true,
        documentControl: {
          versions: [
            { createdAt: "2026-09-28T10:00:00.000Z", createdBy: "Jo", note: "First", stepCount: 1 },
          ],
        },
      },
    );
    const pdf = await renderPdf(model, fonts, { pageSize: "A4", orientation: "portrait" }, false);
    const { outline, figures, unmarked, decoration, metadata } = await readBack(pdf);
    const text = outline.join("\n");

    // Every word is in the structure or marked as decoration: none is left for a reader to guess.
    expect(unmarked).toEqual([]);
    // The page numbers and the footer are page furniture.
    // Two pages: steps follow on, sharing pages (F038).
    expect(decoration).toEqual([
      "Made with Steps",
      "Page 1 of 2",
      "Made with Steps",
      "Page 2 of 2",
    ]);

    expect(outline[0]).toBe("Document");
    expect(text).toContain("  H1: Pay a supplier");
    expect(text).toContain("  P: How finance pays an approved invoice.");
    // Document control: a table, its labels row headers, the history's first row column headers.
    expect(text).toMatch(
      /H2: Document control\n\s+Table\n\s+TR\n\s+TH: Title\n\s+TD: Pay a supplier/,
    );
    expect(text).toMatch(/H3: Version history\n\s+Table\n\s+TR\n\s+TH: Date\n\s+TH: By/);
    // Contents: each section's heading and page link to it.
    expect(text).toMatch(
      /H2: Contents\n\s+Table\n\s+TR\n\s+TD\n\s+Link: Paying\n\s+TD: Step 1\n\s+TD\n\s+Link: 2/,
    );
    // Rich text: a heading a level below its section's, and a numbered list with a link.
    expect(text).toMatch(
      /H2: Before you start\n\s+H3: You need\n\s+L\n\s+LI\n\s+Lbl: 1\.\n\s+LBody\n\s+P: Access to\n\s+Link: Xero/,
    );
    expect(text).toMatch(/LI\n\s+Lbl: 2\.\n\s+LBody\n\s+P: The invoice/);
    // A section, then a step: its number and wording one heading, its screenshot a figure.
    expect(text).toMatch(/H2: Paying\n\s+H3: 1 ?Click "Bills"\n\s+Figure\n/);
    expect(figures).toEqual(['Screenshot for step 1: Click "Bills"']);
    expect(text).toMatch(/L\n\s+LI\n\s+Lbl: •\n\s+LBody\n\s+P: Check the total/);
    // A tip: its kind, then its words.
    expect(text).toMatch(/P: TIP\n\s+P: Pay before Friday\./);

    // Marked as tagged, in the guide's language, with its title shown.
    const info = metadata.info as Record<string, unknown>;
    expect(info.Title).toBe("Pay a supplier");
    const raw = Buffer.from(pdf).toString("latin1");
    expect(raw).toMatch(/\/Marked true/);
    expect(raw).toContain("/Lang (en-GB)");
    expect(raw).toContain("/DisplayDocTitle true");
    // A link's annotation says what it is, and belongs to its Link element.
    expect(raw).toMatch(/\/Contents \(Xero\)/);
    expect(raw).toMatch(/\/StructParent \d+/);
  }, 60_000);

  it("draws an untagged document as before", async () => {
    // The wrapper only acts on the document being tagged: a second, ordinary pdfmake document in
    // the same process has no structure.
    // A tagged one first, so the wrapper is in place and the fonts are set.
    const model = buildRenderModel(guide, [step("a")], new Map(), {
      preparedBy: "",
      now: new Date(2026, 8, 30),
    });
    await renderPdf(model, fonts, { pageSize: "A4", orientation: "portrait" }, false);
    const pdfmakeModule = await import("pdfmake");
    const pdfmake = ((pdfmakeModule as unknown as { default?: typeof pdfmakeModule }).default ??
      pdfmakeModule) as unknown as {
      createPdf(definition: unknown): { getBuffer(): Promise<Uint8Array> };
    };
    const bytes = await pdfmake
      .createPdf({ content: ["Plain"], defaultStyle: { font: "Body" }, compress: false })
      .getBuffer();
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("/StructTreeRoot");
  }, 30_000);
});
