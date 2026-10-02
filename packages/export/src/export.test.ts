import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Guide, GuideStep } from "@amluto-steps/core";

import { pixelateBlock, planImage } from "./geometry";
import {
  AMLUTO_LOOK,
  buildRenderModel,
  estimateMinutes,
  type RenderedImage,
  type RenderModel,
  safeFontName,
} from "./model";
import { imageSize, renderDocx } from "./docx";
import { renderClipboardHtml, renderClipboardText } from "./html";
import { pdfDefinition, renderPdf, type PdfFonts } from "./pdf";
import { EXPORT_WORD_TEMPLATES } from "./wording";
import { en } from "./wording/en";

const guide: Guide = {
  id: "g1",
  title: "Add a supplier",
  description: "How to add a supplier in Xero.",
  intro: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "You need adviser access." }] }],
  },
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

describe("image plan", () => {
  it("crops, then moves every mark into the cropped image's pixels", () => {
    const plan = planImage(
      step("a", {
        crop: { x: 50, y: 50, w: 50, h: 50, source: "manual" },
        highlight: { shape: "circle", x: 60, y: 60, w: 5, h: 5 },
        redactions: [{ x: 40, y: 40, w: 20, h: 20, source: "manual" }],
        annotations: [{ type: "arrow", from: [55, 55], to: [75, 75] }],
      }),
      2000,
      1000,
    );
    expect(plan.source).toEqual({ x: 1000, y: 500, w: 1000, h: 500 });
    expect([plan.width, plan.height]).toEqual([1000, 500]);
    expect(plan.highlight?.rect).toEqual({ x: 200, y: 100, w: 100, h: 50 });
    // The blur area straddles the crop edge: only the part inside is kept, and all of it is.
    expect(plan.blur).toEqual([{ x: 0, y: 0, w: 200, h: 100 }]);
    expect(plan.annotations[0]).toEqual({ type: "arrow", from: [100, 50], to: [500, 250] });
  });

  it("scales lines and labels with the screenshot, and drops blur outside the crop", () => {
    const small = planImage(step("a"), 1920, 1080);
    const large = planImage(step("a"), 3840, 2160);
    expect(large.lineWidth).toBeGreaterThan(small.lineWidth);
    const outside = planImage(
      step("a", {
        crop: { x: 0, y: 0, w: 50, h: 50, source: "manual" },
        redactions: [{ x: 80, y: 80, w: 10, h: 10, source: "manual" }],
      }),
      1000,
      1000,
    );
    expect(outside.blur).toEqual([]);
    expect(pixelateBlock({ x: 0, y: 0, w: 30, h: 30 })).toBeGreaterThanOrEqual(12);
  });
});

describe("Made with Steps", () => {
  it("links to steps.amluto.com, and is left out when switched off", () => {
    const on = buildRenderModel(guide, [step("a")], new Map(), { preparedBy: "", now: new Date() });
    expect(on.madeWith).toBe(true);
    expect(renderClipboardHtml(on)).toContain(
      '<a href="https://steps.amluto.com/" style="color:inherit">Made with Steps</a>',
    );
    const off = buildRenderModel(guide, [step("a")], new Map(), {
      preparedBy: "",
      now: new Date(),
      madeWith: false,
    });
    expect(renderClipboardHtml(off)).not.toContain("Made with Steps");
  });
});

describe("render model", () => {
  it("never carries a hidden typed value, even in hand-edited wording or alt text", () => {
    const secret = step("a", {
      action: "input",
      actionText: "Enter Acme Ltd in the name box",
      textEdited: true,
      altText: "The name box with Acme Ltd typed in",
      textParts: { verb: "Type", target: "Name", kind: "field", value: "Acme Ltd" },
      showValue: false,
    });
    const model = buildRenderModel(guide, [secret], new Map(), {
      preparedBy: "",
      now: new Date(2026, 8, 26),
    });
    expect(JSON.stringify(model)).not.toContain("Acme");
    expect(renderClipboardText(model)).not.toContain("Acme");
    const shown = buildRenderModel(guide, [{ ...secret, showValue: true }], new Map(), {
      preparedBy: "",
      now: new Date(2026, 8, 26),
    });
    expect(JSON.stringify(shown)).toContain("Acme Ltd");
  });

  it("numbers steps but not blocks, and generates alt text", () => {
    const image: RenderedImage = { dataUrl: "data:image/png;base64,", width: 10, height: 10 };
    const model = buildRenderModel(
      guide,
      [
        step("a"),
        step("tip", { kind: "block", block: { type: "tip", heading: "Tip", body: null } }),
        step("b", { altText: "The Save button" }),
      ],
      new Map([["a", image]]),
      { preparedBy: "Robin", now: new Date(2026, 8, 26) },
    );
    expect(model.date).toBe("26/09/2026");
    expect(model.stepCount).toBe(2);
    expect(model.items.map((item) => (item.kind === "step" ? item.number : item.type))).toEqual([
      1,
      "tip",
      2,
    ]);
    const [first, , second] = model.items;
    expect(first?.kind === "step" && first.altText).toBe('Screenshot for step 1: Click "a"');
    expect(second?.kind === "step" && second.altText).toBe("The Save button");
  });

  it("never carries a typed value the step hides", () => {
    const hidden = step("t", {
      action: "input",
      actionText: 'Type in "Customer name"',
      textParts: {
        verb: "input",
        target: "Customer name",
        kind: "field",
        value: "Acme Secret Ltd",
      },
      showValue: false,
    });
    const model = buildRenderModel(guide, [hidden], new Map(), { preparedBy: "", now: new Date() });
    expect(JSON.stringify(model)).not.toContain("Acme Secret");
  });

  it("estimates time the old way", () => {
    // 15 s + 8 s + 12 s + a few words of reading is about half a minute: rounds up to 1.
    expect(estimateMinutes(guide, [step("a"), step("b", { action: "input" })])).toBe(1);
    const many = Array.from({ length: 40 }, (_, index) => step(`s${index}`));
    expect(estimateMinutes(guide, many)).toBe(6);
  });
});

describe("PDF", () => {
  it("builds a PDF with the guide's title, language and every page", async () => {
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
    // A 1×1 PNG stands in for a screenshot.
    const pixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const steps = Array.from({ length: 12 }, (_, index) => step(`s${index}`));
    const model = buildRenderModel(
      guide,
      [
        ...steps,
        step("alert", { kind: "block", block: { type: "alert", heading: "Careful", body: null } }),
      ],
      new Map(steps.map((item) => [item.id, { dataUrl: pixel, width: 1600, height: 900 }])),
      {
        preparedBy: "Robin",
        now: new Date(2026, 8, 26),
        brand: {
          ...AMLUTO_LOOK,
          coverLogo: {
            type: "svg",
            data: readFileSync(
              new URL("../../ui/src/assets/logo-horizontal-colour.svg", import.meta.url),
              "utf8",
            ),
          },
        },
      },
    );
    const bytes = await renderPdf(model, fonts, { pageSize: "A4", orientation: "portrait" }, false);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("/DisplayDocTitle true");
    // Tagged (docs/spec/05-export.md#tagged-pdf; the structure is checked in pdf-tags.test.ts).
    expect(text).toContain("/StructTreeRoot");
    expect(text).toMatch(/\/Marked true/);
    expect(text).toContain("/Lang (en-GB)");
    expect(text.includes("/Title")).toBe(true);
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(2);
  }, 30_000);

  it("sets notes too long for one page over two, instead of dropping the rest", async () => {
    const require = createRequire(import.meta.url);
    const font = (file: string) =>
      new Uint8Array(readFileSync(require.resolve(`@fontsource/inter/files/${file}`)));
    const regular = font("inter-latin-400-normal.woff");
    const bold = font("inter-latin-700-normal.woff");
    const fonts: PdfFonts = {
      heading: { normal: bold, bold },
      body: { normal: regular, bold, italics: regular, bolditalics: bold },
    };
    const pages = async (lines: number) => {
      const notes = {
        type: "doc" as const,
        content: Array.from({ length: lines }, (_, index) => ({
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: `Note line ${index}` }],
        })),
      };
      const model = buildRenderModel(guide, [step("a", { notes })], new Map(), {
        preparedBy: "",
        now: new Date(2026, 8, 26),
      });
      const bytes = await renderPdf(
        model,
        fonts,
        { pageSize: "A4", orientation: "portrait" },
        false,
      );
      return (
        Buffer.from(bytes)
          .toString("latin1")
          .match(/\/Type \/Page\b/g) ?? []
      ).length;
    };
    // The cover and the step share the first page; a long note runs on to more pages.
    expect(await pages(3)).toBe(1);
    expect(await pages(120)).toBeGreaterThan(2);
  }, 30_000);
});

describe("Word", () => {
  it("uses real headings, a numbered step list, alt text and the document language", async () => {
    const { default: JSZip } = await import("jszip");
    const pixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const model = buildRenderModel(
      guide,
      [
        step("a", {
          notes: {
            type: "doc",
            content: [
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "First point" }] },
                    ],
                  },
                ],
              },
            ],
          },
        }),
        step("h", { kind: "block", block: { type: "header", heading: "Part two", body: null } }),
        step("b", { altText: "The Save button, top right" }),
      ],
      new Map([["b", { dataUrl: pixel, width: 1600, height: 900 }]]),
      { preparedBy: "Robin", now: new Date(2026, 8, 26) },
    );
    const zip = await JSZip.loadAsync(await renderDocx(model));
    const read = async (name: string) => (await zip.file(name)?.async("string")) ?? "";
    const document = await read("word/document.xml");
    expect(document).toContain('w:val="Heading1"');
    expect(document).toContain('w:val="Heading2"');
    expect(document).toContain("Add a supplier");
    expect(document).toContain('descr="The Save button, top right"');
    expect(document).toContain("First point");
    const styles = await read("word/styles.xml");
    expect(styles).toContain('w:val="en-GB"');
    expect(await read("word/numbering.xml")).toContain('w:val="decimal"');
  });

  it("puts a PNG or JPEG cover logo above the title, and leaves an SVG one out", async () => {
    const { default: JSZip } = await import("jszip");
    const pixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const withLogo = (coverLogo: RenderModel["brand"]["coverLogo"]) =>
      buildRenderModel(guide, [step("a")], new Map(), {
        preparedBy: "",
        now: new Date(2026, 8, 26),
        brand: { ...AMLUTO_LOOK, name: "Client", coverLogo },
      });
    const png = await JSZip.loadAsync(await renderDocx(withLogo({ type: "png", data: pixel })));
    const document = (await png.file("word/document.xml")?.async("string")) ?? "";
    expect(document.indexOf('descr="Client"')).toBeGreaterThan(-1);
    expect(document.indexOf('descr="Client"')).toBeLessThan(document.indexOf("Add a supplier"));
    const svg = await JSZip.loadAsync(
      await renderDocx(
        withLogo({ type: "svg", data: "<svg xmlns='http://www.w3.org/2000/svg'/>" }),
      ),
    );
    expect(await svg.file("word/document.xml")?.async("string")).not.toContain('descr="Client"');
  });

  it("reads image sizes from PNG and JPEG headers", () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"), (c) =>
      c.charCodeAt(0),
    );
    expect(imageSize(png)).toEqual({ width: 1, height: 1 });
    // SOI, an APP0 segment, then SOF0 with height 300 and width 400.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c,
      0x01, 0x90, 0x03, 0x00, 0x00,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 400, height: 300 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("Copy as rich text", () => {
  it("escapes guide text and refuses script links", () => {
    const model = buildRenderModel(
      { ...guide, title: '<img src=x onerror="alert(1)">' },
      [
        step("a", {
          actionText: "Click <b>Save</b>",
          notes: {
            type: "doc",
            content: [
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
            ],
          },
        }),
      ],
      new Map(),
      { preparedBy: "", now: new Date(2026, 8, 26) },
    );
    const html = renderClipboardHtml(model);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Save</b>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Click &#60;b&#62;Save&#60;/b&#62;");
    expect(renderClipboardText(model)).toContain("1. Click <b>Save</b>");
  });
});

describe("tips, notes and warnings", () => {
  it("are named in the clipboard and web page, not told apart by colour alone", async () => {
    const model = buildRenderModel(
      guide,
      [step("a"), step("t", { kind: "block", block: { type: "alert", heading: "", body: null } })],
      new Map(),
      { preparedBy: "", now: new Date(2026, 8, 26) },
    );
    // The old red "alert" is now called Important; amber Warning is its own kind.
    expect(renderClipboardHtml(model)).toContain(
      '<strong style="color:#A3160C">❗ IMPORTANT</strong>',
    );
    const { renderWalkthrough } = await import("./walkthrough/render");
    const page = await renderWalkthrough(model);
    expect(page).toContain("<h3>IMPORTANT</h3>");
    expect(page).toContain("wt-callout wt-callout-important");
  });

  it("draws coloured boxes in notes in every format, each named in words", async () => {
    const notes = {
      type: "doc" as const,
      content: [
        {
          type: "callout" as const,
          attrs: { kind: "warning" as const },
          content: [
            {
              type: "paragraph" as const,
              content: [{ type: "text" as const, text: "Save first." }],
            },
          ],
        },
      ],
    };
    const model = buildRenderModel(
      guide,
      [
        step("a", { notes }),
        step("w", { kind: "block", block: { type: "warning", heading: "", body: null } }),
      ],
      new Map(),
      { preparedBy: "", now: new Date(2026, 8, 26) },
    );
    const clipboard = renderClipboardHtml(model);
    expect(clipboard).toContain("border-left:4px solid #DC8A00");
    expect(clipboard).toContain('<strong style="color:#7A4B00">⚠ WARNING</strong>');
    expect(clipboard).toContain("Save first.");
    const { renderWalkthrough } = await import("./walkthrough/render");
    const page = await renderWalkthrough(model);
    // The walkthrough's policy allows no inline styles: classes only.
    expect(page).toContain(
      '<div class="wt-callout wt-callout-warning"><p class="wt-callout-label"><strong>WARNING</strong>',
    );
    // The icon comes from the stylesheet, as an image the page's policy allows.
    expect(page).toContain(
      '.wt-callout-warning{--wt-callout-ink:#7A4B00;--wt-callout-icon:url("data:image/svg+xml,',
    );
    expect(page).not.toContain('class="wt-callout wt-callout-warning" style=');
    const pdf = JSON.stringify(
      pdfDefinition(model, { pageSize: "A4", orientation: "portrait" }).content,
    );
    expect(pdf).toContain('"fillColor":"#DC8A00"');
    expect(pdf).toContain("Save first.");
    expect(pdf).toContain('"text":"WARNING"');
    expect(pdf).toContain('"svg":"<svg');
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await renderDocx(model));
    const word = (await zip.file("word/document.xml")?.async("string")) ?? "";
    expect(word).toContain('w:fill="FFF4DE"');
    expect(word).toContain("⚠ ");
    expect(word).toContain("WARNING");
    expect(word).toContain("Save first.");
  });
});

describe("brand looks in exports", () => {
  const client = {
    ...AMLUTO_LOOK,
    name: "Client",
    primary: "#113355",
    headingFont: "Montserrat",
    bodyFont: "Segoe UI",
  };
  const model = () =>
    buildRenderModel(guide, [step("a"), step("b")], new Map(), {
      preparedBy: "",
      now: new Date(2026, 8, 26),
      brand: client,
    });

  it("numbers each list in Word on its own, from its own first number", async () => {
    const { default: JSZip } = await import("jszip");
    const list = (start?: number) => ({
      type: "doc" as const,
      content: [
        {
          type: "orderedList" as const,
          ...(start ? { attrs: { start } } : {}),
          content: ["One", "Two"].map((text) => ({
            type: "listItem" as const,
            content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
          })),
        },
      ],
    });
    const zip = await JSZip.loadAsync(
      await renderDocx(
        buildRenderModel(
          guide,
          [
            step("a", { notes: list() }),
            step("b", { notes: list() }),
            step("c", { notes: list(4) }),
          ],
          new Map(),
          { preparedBy: "", now: new Date(2026, 8, 26), brand: client },
        ),
      ),
    );
    const document = (await zip.file("word/document.xml")?.async("string")) ?? "";
    const numbering = (await zip.file("word/numbering.xml")?.async("string")) ?? "";
    // The steps list plus three note lists, each a numbering instance of its own.
    const numIds = new Set([...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]));
    expect(numIds.size).toBe(4);
    expect(numbering).toContain('<w:start w:val="4"/>');
  });

  it("names the brand's fonts in Word, and refuses a font name that isn't just a name", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await renderDocx(model()));
    const styles = (await zip.file("word/styles.xml")?.async("string")) ?? "";
    expect(styles).toContain('w:ascii="Montserrat"');
    expect(styles).toContain('w:ascii="Segoe UI"');
    expect(safeFontName('Evil"; }', "Aptos")).toBe("Aptos");
    expect(safeFontName(" Open Sans ", "Aptos")).toBe("Open Sans");
  });

  it("builds a PDF with a page logo and the compact layout", () => {
    const definition = pdfDefinition(
      {
        ...model(),
        brand: {
          ...client,
          pageLogo: { type: "svg", data: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
        },
      },
      { pageSize: "A4", orientation: "portrait", layout: "compact" },
    );
    const header = definition.header as (page: number) => unknown;
    expect(header(1)).toBeNull();
    expect(header(2)).toMatchObject({ alignment: "right" });
    const standard = pdfDefinition(model(), { pageSize: "A4", orientation: "portrait" });
    expect(standard.header).toBeDefined();
    expect((standard.header as (page: number) => unknown)(2)).toBeNull();
  });

  it("starts each step on a new page in the one-step-per-page layout, with its blocks", () => {
    const items = model().items;
    const content = (layout: "standard" | "page") =>
      pdfDefinition(model(), { pageSize: "A4", orientation: "portrait", layout }).content as {
        pageBreak?: string;
      }[];
    const breaks = (layout: "standard" | "page") =>
      content(layout).filter((part) => part.pageBreak === "before").length;
    expect(breaks("standard")).toBe(0);
    // A break before the first item and after every step; blocks would join the step after them.
    const expected = items.filter(
      (_, index) => index === 0 || items[index - 1]?.kind === "step",
    ).length;
    expect(breaks("page")).toBe(expected);
  });

  it("keeps a card on one page unless its notes can't fit, and never cuts them off", () => {
    const paragraph = (text: string) => ({
      type: "paragraph" as const,
      content: [{ type: "text" as const, text }],
    });
    const notes = (count: number) => ({
      type: "doc" as const,
      content: Array.from({ length: count }, (_, index) =>
        paragraph(
          `Line ${index} of the notes, long enough to wrap onto a second line on the page.`,
        ),
      ),
    });
    const cards = (count: number) => {
      const definition = pdfDefinition(
        buildRenderModel(guide, [step("a", { notes: notes(count) })], new Map(), {
          preparedBy: "",
          now: new Date(2026, 8, 26),
        }),
        { pageSize: "A4", orientation: "portrait" },
      );
      return (
        definition.content as { unbreakable?: boolean; stack?: { unbreakable?: boolean }[] }[]
      ).filter((item) => Array.isArray(item.stack) && item.stack.length > 0);
    };
    const short = cards(3).at(-1);
    expect(short?.unbreakable).toBe(true);
    const long = cards(80).at(-1);
    expect(long?.unbreakable).toBeUndefined();
    // The number, wording and screenshot still stay together.
    expect(long?.stack?.[0]?.unbreakable).toBe(true);

    const block = (count: number) =>
      (
        pdfDefinition(
          buildRenderModel(
            guide,
            [step("t", { kind: "block", block: { type: "tip", heading: "", body: notes(count) } })],
            new Map(),
            { preparedBy: "", now: new Date(2026, 8, 26) },
          ),
          { pageSize: "A4", orientation: "portrait" },
        ).content as { unbreakable?: boolean; table?: unknown }[]
      ).find((item) => item.table !== undefined);
    expect(block(3)?.unbreakable).toBe(true);
    expect(block(80)?.unbreakable).toBe(false);
  });
});

describe("code steps (docs/spec/05-export.md#code)", () => {
  const command = step("cmd", {
    action: "command",
    actionText: "Run in PowerShell",
    code: {
      text: 'Add-MailboxPermission -Identity "sales" -User <anna>\n  -AccessRights FullAccess',
      language: "powershell",
      output: "Identity  User\nSales     anna",
      outputShortened: true,
    },
  });
  const model = () =>
    buildRenderModel(guide, [command], new Map(), { preparedBy: "", now: new Date(2026, 8, 28) });

  it("carry their code, label and output into the render model", () => {
    const item = model().items[0];
    expect(item?.kind === "step" && item.code).toEqual({
      text: command.code?.text,
      label: "PowerShell",
      output: "Identity  User\nSales     anna",
      outputShortened: true,
    });
  });

  it("show in the web page with a label, Copy and folded output, all escaped", async () => {
    const { renderWalkthrough } = await import("./walkthrough/render");
    const html = await renderWalkthrough(model());
    expect(html).toContain('<span class="wt-code-label">PowerShell</span>');
    expect(html).toContain("-User &#60;anna&#62;");
    expect(html).not.toContain("<anna>");
    expect(html).toContain('<div class="wt-output"><details><summary>');
    // Copy is beside the summary that opens the output, never inside it.
    expect(html).not.toMatch(/<summary>(?:(?!<\/summary>).)*wt-copy/);
    // Code scrolls rather than wrapping, so its box can take focus.
    expect(html).toContain('<pre class="wt-code-text" tabindex="0">');
    expect(html).toContain("(2 lines, shortened)");
    // Copy needs the page's script, so it starts hidden.
    expect(html).toContain('<button type="button" class="wt-copy" hidden>Copy</button>');
  });

  it("go into the PDF in a monospace font, and into Word as shaded Consolas", async () => {
    const require = createRequire(import.meta.url);
    const file = (path: string) => new Uint8Array(readFileSync(require.resolve(path)));
    const inter = file("@fontsource/inter/files/inter-latin-400-normal.woff");
    const fonts: PdfFonts = {
      heading: { normal: inter, bold: inter },
      body: { normal: inter, bold: inter, italics: inter, bolditalics: inter },
      mono: file("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff"),
    };
    const bytes = await renderPdf(
      model(),
      fonts,
      { pageSize: "A4", orientation: "portrait" },
      false,
    );
    const pdf = Buffer.from(bytes).toString("latin1");
    expect(pdf).toMatch(/JetBrains/);

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await renderDocx(model()));
    const document = (await zip.file("word/document.xml")?.async("string")) ?? "";
    expect(document).toContain('w:ascii="Consolas"');
    expect(document).toMatch(/-User (&lt;|&#60;)anna(&gt;|&#62;)/);
    expect(document).toContain("  -AccessRights FullAccess");
    expect(document).toContain("Output (shortened)");
  }, 30_000);

  it("copy into the clipboard's text and HTML", () => {
    expect(renderClipboardText(model())).toContain("    -AccessRights FullAccess");
    expect(renderClipboardHtml(model())).toContain("<pre");
  });
});

describe("an export in another language", () => {
  // A stand-in German, until the real one is written: the export words are the same shape.
  const german = {
    ...en,
    beforeYouStart: "Bevor Sie beginnen",
    stepCount: { one: "{count} Schritt", other: "{count} Schritte" },
    minutes: "etwa {minutes} Min.",
    page: "Seite {current} von {total}",
    callouts: { note: "HINWEIS", tip: "TIPP", warning: "WARNUNG", important: "WICHTIG" },
    screenshotFor: "Screenshot zu Schritt {number}: {text}",
  };
  beforeAll(() => {
    EXPORT_WORD_TEMPLATES.de = german;
  });
  afterAll(() => {
    delete EXPORT_WORD_TEMPLATES.de;
  });

  it("uses that language's words and dates, and English again afterwards", () => {
    const model = buildRenderModel(guide, [step("a"), step("b")], new Map(), {
      preparedBy: "Robin",
      now: new Date(2026, 9, 1),
      language: "de",
    });
    expect(model.language).toBe("de");
    expect(model.date).toBe("01.10.2026");
    const items = model.items.filter((item) => item.kind === "step");
    expect(items[0]).toMatchObject({ altText: 'Screenshot zu Schritt 1: Click "a"' });
    const html = renderClipboardHtml(model);
    expect(html).toContain("Bevor Sie beginnen");
    expect(html).toContain("2 Schritte · etwa 1 Min.");
    // The words go back to English once the export is built.
    const english = buildRenderModel(guide, [step("a")], new Map(), {
      preparedBy: "",
      now: new Date(),
    });
    expect(renderClipboardHtml(english)).toContain("Before you start");
    expect(english.language).toBe("en-GB");
  });

  it("labels coloured boxes in the language, and numbers Word's pages in it", async () => {
    const model = buildRenderModel(
      guide,
      [
        step("n", {
          notes: {
            type: "doc",
            content: [{ type: "callout", attrs: { kind: "warning" }, content: [] }],
          },
        }),
      ],
      new Map(),
      { preparedBy: "", now: new Date(), language: "de" },
    );
    expect(renderClipboardHtml(model)).toContain("WARNUNG");
    const definition = pdfDefinition(model, { tagged: false } as never);
    expect(JSON.stringify(definition)).toContain("WARNUNG");
    // The footer is drawn later, page by page, still in German.
    const footer = (definition.footer as (current: number, total: number) => unknown)(1, 2);
    expect(JSON.stringify(footer)).toContain("Seite 1 von 2");
    const docx = await renderDocx(model);
    expect(docx.byteLength).toBeGreaterThan(0);
  });
});
