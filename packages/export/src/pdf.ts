import * as pdfmakeModule from "pdfmake";
import type { Content, ContentText, TDocumentDefinitions } from "pdfmake/interfaces";
import type { CalloutKind, PdfLayout, RichText } from "@amluto-steps/core";

import { base64 } from "./html";
import { tagDefinition, tagged, type PdfMakeLike } from "./pdf-tags";
import type { RenderBlock, RenderCode, RenderModel, RenderStep } from "./model";
import {
  blockLook,
  CALLOUT_LOOK,
  calloutIconSvg,
  calloutName,
  EXPORT_PALETTE,
  exportWords,
  withWords,
  currentWords,
} from "./words";
import { wrapCode } from "./wrap-code";

/** Font files for the PDF, as raw bytes; each family needs a normal and a bold face. */
export interface PdfFonts {
  heading: { normal: Uint8Array; bold: Uint8Array };
  body: { normal: Uint8Array; bold: Uint8Array; italics: Uint8Array; bolditalics: Uint8Array };
  /** Monospace, for code blocks. Without it code is set in the body font. */
  mono?: Uint8Array;
}

export interface PdfOptions {
  pageSize: "A4" | "LETTER";
  orientation: "portrait" | "landscape";
  /**
   * Standard: steps follow on, each kept whole, big screenshots. Page: each step starts a new page.
   * Compact: smaller screenshots, so about two steps fit a page.
   */
  layout?: PdfLayout;
}

const {
  muted: MUTED,
  panel: PANEL,
  ink: INK,
  codePaper: CODE_PAPER,
  codeRule: CODE_RULE,
} = EXPORT_PALETTE;

const CODE_SIZE = 9.5;
const OUTPUT_SIZE = 8.5;

/** A step's code as a light, labelled box, and its output below in a dashed one (docs/spec/05-export.md#code). */
/** Characters of monospace text at `size` that fit a code box across `width` (JetBrains Mono is 0.6 em). */
const codeColumns = (width: number, size: number) => (width - 20) / (size * 0.6);

function codeContent(code: RenderCode | null, width: number): Content[] {
  if (!code) return [];
  const box = (text: string, size: number, dashed: boolean, label?: string): Content =>
    ({
      table: {
        widths: ["*"],
        body: [
          ...(label
            ? [
                [
                  {
                    text: label.toUpperCase(),
                    fontSize: 7.5,
                    bold: true,
                    color: MUTED,
                    characterSpacing: 0.6,
                    margin: [4, 3, 4, 1],
                  },
                ],
              ]
            : []),
          [
            {
              text,
              tag: "Code",
              font: "Mono",
              fontSize: size,
              lineHeight: 1.2,
              color: INK,
              preserveLeadingSpaces: true,
              margin: [4, 4, 4, 3],
            },
          ],
        ],
      },
      layout: {
        fillColor: () => (dashed ? null : CODE_PAPER),
        hLineColor: () => CODE_RULE,
        vLineColor: () => CODE_RULE,
        hLineWidth: (index: number, node: { table: { body: unknown[] } }) =>
          index === 0 || index === node.table.body.length || (label && index === 1) ? 0.75 : 0,
        vLineWidth: () => 0.75,
        ...(dashed
          ? {
              hLineStyle: () => ({ dash: { length: 3 } }),
              vLineStyle: () => ({ dash: { length: 3 } }),
            }
          : {}),
      },
      margin: [0, 8, 0, 0],
    }) as Content;
  const parts = [
    box(
      wrapCode(code.text, codeColumns(width, CODE_SIZE)),
      CODE_SIZE,
      false,
      code.label || undefined,
    ),
  ];
  if (code.output) {
    const heading = code.outputShortened
      ? `${currentWords().output} (${currentWords().shortened})`
      : currentWords().output;
    parts.push(
      { text: heading, fontSize: 8.5, bold: true, color: MUTED, margin: [0, 6, 0, 0] },
      box(wrapCode(code.output, codeColumns(width, OUTPUT_SIZE)), OUTPUT_SIZE, true),
    );
  }
  return parts;
}

/** Roughly how tall a code block will be, to keep a card on one page. */
function codeHeight(code: RenderCode | null, width: number): number {
  if (!code) return 0;
  const lines = (text: string, size: number) =>
    text
      .split("\n")
      .reduce(
        (sum, line) => sum + Math.max(1, Math.ceil((line.length * size * 0.6) / (width - 16))),
        0,
      ) *
    size *
    1.2;
  return (
    lines(code.text, CODE_SIZE) + 30 + (code.output ? lines(code.output, OUTPUT_SIZE) + 36 : 0)
  );
}

/** A coloured box's label: its icon, then its kind (or heading) in its ink. */
function calloutLabel(
  kind: CalloutKind,
  label: string,
  margin: [number, number, number, number],
): Content {
  return {
    columns: [
      { svg: calloutIconSvg(kind), width: 11, height: 11, margin: [0, 1, 0, 0] },
      { text: label, bold: true, color: CALLOUT_LOOK[kind].ink, width: "*" },
    ],
    columnGap: 5,
    margin,
  };
}

/**
 * Rich text (the allow-listed TipTap JSON) as pdfmake content. Links stay clickable. Its headings
 * are tagged from `level` down (the heading it sits under, plus one).
 */
export function richTextToPdf(node: RichText | null, level = 3): Content[] {
  if (!node?.content) return [];
  const inline = (children: RichText[] = []): ContentText[] =>
    children.flatMap((child): ContentText[] => {
      if (child.type === "hardBreak") return [{ text: "\n" }];
      if (child.type !== "text") return inline(child.content);
      const marks = child.marks ?? [];
      const link = marks.find((mark) => mark.type === "link");
      return [
        {
          text: child.text ?? "",
          bold: marks.some((mark) => mark.type === "bold"),
          italics: marks.some((mark) => mark.type === "italic"),
          ...(link && link.type === "link"
            ? { link: link.attrs.href, color: "#1C67B1", decoration: "underline" as const }
            : {}),
        },
      ];
    });
  const block = (child: RichText): Content | null => {
    switch (child.type) {
      case "paragraph":
        return { text: inline(child.content), margin: [0, 0, 0, 4] };
      case "heading":
        return {
          text: inline(child.content),
          style: child.attrs?.level === 3 ? "h3" : "h2",
          tag: `H${Math.min(6, level + (child.attrs?.level === 3 ? 1 : 0))}`,
        } as Content;
      case "bulletList":
      case "orderedList": {
        // Drawn here rather than with pdfmake's lists, whose numbers are lines with no tag: each
        // number or bullet is its item's label (Lbl), and the item's text its body (LBody).
        const start = child.type === "orderedList" ? (child.attrs?.start ?? 1) : null;
        const items = child.content ?? [];
        // As wide as the longest number (about 6 points a digit, and the full stop and a gap), so
        // the text starts where pdfmake's own lists put it.
        const markerWidth = start === null ? 12 : String(start + items.length - 1).length * 6.3 + 6;
        return {
          tagGroup: "L",
          stack: items.map((item, index) => ({
            tagGroup: "LI",
            columns: [
              {
                text: start === null ? "\u2022" : `${start + index}.`,
                tag: "Lbl",
                width: markerWidth,
              },
              {
                tagGroup: "LBody",
                width: "*",
                stack: (item.content ?? []).map(block).filter(Boolean) as Content[],
              },
            ],
            columnGap: 0,
          })),
          margin: [0, 0, 0, 4],
        } as Content;
      }
      case "callout": {
        // A coloured box: its bar, fill and kind in words, as blocks are drawn.
        const look = CALLOUT_LOOK[child.attrs?.kind ?? "note"];
        return {
          table: {
            widths: [3, "*"],
            body: [
              [
                { text: "", fillColor: look.bar },
                {
                  fillColor: look.fill,
                  margin: [8, 5, 8, 3],
                  stack: [
                    calloutLabel(
                      child.attrs?.kind ?? "note",
                      calloutName(child.attrs?.kind ?? "note"),
                      [0, 0, 0, 2],
                    ),
                    ...((child.content ?? []).map(block).filter(Boolean) as Content[]),
                  ],
                },
              ],
            ],
          },
          layout: "noBorders",
          margin: [0, 2, 0, 6],
        };
      }
      default:
        return null;
    }
  };
  return node.content.map(block).filter((item): item is Content => item !== null);
}

/** The plain text of a rich-text node and how many hard line breaks it holds. */
function plainText(node: RichText): { text: string; breaks: number } {
  if (node.type === "text") return { text: node.text ?? "", breaks: 0 };
  if (node.type === "hardBreak") return { text: "", breaks: 1 };
  return (node.content ?? [])
    .map(plainText)
    .reduce((all, part) => ({ text: all.text + part.text, breaks: all.breaks + part.breaks }), {
      text: "",
      breaks: 0,
    });
}

/**
 * Roughly how tall rich text sets at the body size in `width` points, erring tall. pdfmake keeps
 * only the first page of an `unbreakable` block that runs over a page, so anything that might
 * not fit mustn't be one.
 */
export function estimateTextHeight(node: RichText | null, width: number): number {
  if (!node) return 0;
  // About 5 points a character at 10.5 pt, a little less than most text needs.
  const perLine = Math.max(20, Math.floor(width / 5));
  let height = 0;
  const visit = (current: RichText) => {
    // A box's label and padding.
    if (current.type === "callout") height += 26;
    if (current.type === "paragraph" || current.type === "heading") {
      const { text, breaks } = plainText(current);
      height += (Math.max(1, Math.ceil(text.length / perLine)) + breaks) * 15 + 6;
      return;
    }
    for (const child of current.content ?? []) visit(child);
  };
  visit(node);
  return height;
}

function stepCard(
  step: RenderStep,
  model: RenderModel,
  contentWidth: number,
  maxImageHeight: number,
  pageContentHeight: number,
): Content {
  const image: Content[] = step.image
    ? [
        {
          image: step.image.dataUrl,
          tagAlt: step.altText,
          fit: [contentWidth, maxImageHeight],
          margin: [0, 8, 0, 0],
          alignment: "center",
        },
      ]
    : [];
  const notes = step.notes
    ? [
        {
          table: {
            widths: ["*"],
            body: [[{ stack: richTextToPdf(step.notes, 4), margin: [8, 6, 8, 4], color: MUTED }]],
          },
          layout: "noBorders",
          fillColor: PANEL,
          margin: [0, 8, 0, 0],
        } as Content,
      ]
    : [];
  const header: Content = {
    columns: [
      {
        width: 26,
        table: {
          widths: [22],
          heights: [22],
          body: [
            [
              {
                text: String(step.number),
                // The number and the wording read as one heading: "3 Click Save".
                tag: "H3",
                tagKey: `step-${step.id}`,
                color: "#FFFFFF",
                bold: true,
                alignment: "center",
                fontSize: 11,
                margin: [0, 4, 0, 0],
              },
            ],
          ],
        },
        layout: {
          fillColor: () => model.brand.primary,
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
      },
      {
        text: step.text,
        tag: "H3",
        tagKey: `step-${step.id}`,
        id: stepAnchor(step.id),
        bold: true,
        fontSize: 12,
        margin: [8, 4, 0, 0],
      },
    ],
  };
  // A card stays on one page (docs/spec/05-export.md#layout-pdf-word-and-html-follow-the-same-structure).
  // Only notes too long for that can't: then the number, wording and screenshot stay together
  // and the notes continue on the next page, rather than being cut off.
  const imageHeight = step.image
    ? Math.min(maxImageHeight, (step.image.height * contentWidth) / Math.max(1, step.image.width)) +
      8
    : 0;
  const notesHeight = step.notes ? estimateTextHeight(step.notes, contentWidth - 16) + 18 : 0;
  const code = codeContent(step.code, contentWidth);
  const codeTall = codeHeight(step.code, contentWidth);
  if (40 + codeTall + imageHeight + notesHeight <= pageContentHeight) {
    return {
      unbreakable: true,
      margin: [0, 0, 0, 18],
      stack: [header, ...code, ...image, ...notes],
    };
  }
  // Too tall for one page. The number, wording, code and screenshot stay together while they fit,
  // and the notes run on; code too long for a page runs on itself, the screenshot after it.
  if (40 + codeTall + imageHeight <= pageContentHeight) {
    return {
      margin: [0, 0, 0, 18],
      stack: [{ unbreakable: true, stack: [header, ...code, ...image] }, ...notes],
    };
  }
  return {
    margin: [0, 0, 0, 18],
    stack: [header, ...code, { unbreakable: true, stack: image }, ...notes],
  };
}

/** Where a section's heading is, for the contents page's links and page numbers. */
export const sectionAnchor = (id: string) => `section-${id}`;
/** Where a step's wording is: "First steps", which has no heading, points at its first step. */
export const stepAnchor = (id: string) => `step-${id}`;

/** Light rules between rows, and none down the sides. */
const ROWS_LAYOUT = {
  hLineWidth: (row: number, node: { table: { body: unknown[] } }) =>
    row === 0 || row === node.table.body.length ? 0 : 0.6,
  vLineWidth: () => 0,
  hLineColor: () => EXPORT_PALETTE.line,
  paddingLeft: () => 0,
  paddingRight: () => 8,
  paddingTop: () => 5,
  paddingBottom: () => 5,
};

/** The contents page: each section with its steps and its page, linked to it. */
function contentsContent(model: RenderModel): Content[] {
  const sections = model.contents ?? [];
  if (sections.length === 0) return [];
  return [
    { text: currentWords().contents, style: "h2", tag: "H2" },
    {
      tagTable: true,
      table: {
        widths: ["*", "auto", 36],
        body: sections.map((section) => {
          const anchor = section.id
            ? sectionAnchor(section.id)
            : section.firstStepId
              ? stepAnchor(section.firstStepId)
              : null;
          return [
            anchor
              ? { text: section.heading, linkToDestination: anchor }
              : { text: section.heading },
            {
              text: currentWords().stepRange(section.first, section.last),
              color: MUTED,
              fontSize: 9.5,
            },
            anchor ? { pageReference: anchor, alignment: "right", color: MUTED } : { text: "" },
          ];
        }),
      },
      layout: ROWS_LAYOUT,
      margin: [0, 0, 0, 18],
    } as Content,
  ];
}

/** The document-control page: the guide's details, then its saved versions. */
function controlContent(model: RenderModel): Content[] {
  const control = model.control;
  if (!control) return [];
  const words = currentWords().control;
  const row = (label: string, value: string) => [
    { text: label, color: MUTED, tag: "TH", tagScope: "Row" },
    { text: value },
  ];
  const history: Content =
    control.versions.length > 0
      ? ({
          tagTable: true,
          table: {
            headerRows: 1,
            widths: [64, 110, "*", 36],
            body: [
              [words.date, words.by, words.note, words.steps].map((text) => ({
                text,
                bold: true,
                color: MUTED,
              })),
              ...control.versions.map((version) => [
                { text: version.date },
                { text: version.by },
                { text: version.note },
                { text: String(version.steps), alignment: "right" },
              ]),
            ],
          },
          layout: ROWS_LAYOUT,
        } as Content)
      : { text: words.noVersions, color: MUTED };
  return [
    { text: currentWords().documentControl, style: "h2", tag: "H2" },
    {
      tagTable: true,
      table: {
        widths: [110, "*"],
        body: [
          row(words.title, model.title),
          row(words.owner, control.owner || words.notSet),
          ...(model.preparedBy ? [row(words.preparedBy, model.preparedBy)] : []),
          row(words.created, currentWords().dateBy(control.created, control.createdBy)),
          row(words.updated, currentWords().dateBy(control.updated, control.updatedBy)),
          row(words.reviewBy, control.reviewBy ?? words.notSet),
          row(words.exported, model.date),
        ],
      },
      layout: ROWS_LAYOUT,
      margin: [0, 0, 0, 14],
    } as Content,
    { text: words.history, style: "h3", tag: "H3" },
    history,
    { text: "", margin: [0, 0, 0, 18] },
  ];
}

function blockContent(
  block: RenderBlock,
  model: RenderModel,
  contentWidth: number,
  pageContentHeight: number,
): Content {
  if (block.type === "header") {
    return {
      text: block.heading,
      // The contents page links here, and gives this heading's page.
      id: sectionAnchor(block.id),
      style: "h1",
      tag: "H2",
      alignment: "center",
      margin: [0, 10, 0, 14],
      pageBreak: undefined,
    };
  }
  if (block.type === "text") {
    return {
      stack: [
        ...(block.heading ? [{ text: block.heading, style: "h2", tag: "H3" }] : []),
        ...richTextToPdf(block.body, block.heading ? 4 : 3),
      ],
      margin: [0, 0, 0, 14],
    };
  }
  const look = blockLook(block);
  // Kept on one page unless it is too long for one, when it flows on instead of being cut off.
  const fits = estimateTextHeight(block.body, contentWidth - 28) + 40 <= pageContentHeight;
  return {
    unbreakable: fits,
    margin: [0, 0, 0, 16],
    table: {
      widths: [4, "*"],
      body: [
        [
          {
            text: "",
            fillColor: look.bar,
          },
          {
            fillColor: look.fill,
            margin: [10, 8, 10, 6],
            stack: [
              calloutLabel(look.kind, look.label, [0, 0, 0, 4]),
              ...richTextToPdf(block.body, 3),
            ],
          },
        ],
      ],
    },
    layout: "noBorders",
  };
}

/** The pdfmake document for a guide (docs/spec/05-export.md#layout-pdf-word-and-html-follow-the-same-structure). */
/** The PDF's definition, in the model's language (docs/spec/05-export.md#languages). */
export function pdfDefinition(model: RenderModel, options: PdfOptions): TDocumentDefinitions {
  return withWords(exportWords(model.language), () => definitionOf(model, options));
}

function definitionOf(model: RenderModel, options: PdfOptions): TDocumentDefinitions {
  const footerWords = currentWords();
  const pageWidth = options.pageSize === "A4" ? 595.28 : 612;
  const pageHeight = options.pageSize === "A4" ? 841.89 : 792;
  const [width, height] =
    options.orientation === "portrait" ? [pageWidth, pageHeight] : [pageHeight, pageWidth];
  const margin = 44;
  const pageLogo = model.brand.pageLogo;
  // The page logo sits above the text, so pages with one start a little lower.
  const top = pageLogo ? margin + 22 : margin;
  const contentWidth = width - margin * 2;
  // "Steps follow on" keeps a screenshot to a little over half a page, so a step with a tall one
  // shares its page instead of leaving the rest of it empty (F038); "one step per page" lets it
  // fill the page, and "compact" fits two or more.
  const maxImageHeight =
    options.layout === "compact"
      ? (height - top - margin) / 2 - 110
      : options.layout === "page"
        ? height - top - margin - 150
        : (height - top - margin) * 0.55 - 40;
  const meta = currentWords().coverParts(model.stepCount, model.minutes, model.date).join("  ·  ");

  const cover: Content[] = [
    ...(model.brand.coverLogo
      ? [
          (model.brand.coverLogo.type === "svg"
            ? { svg: model.brand.coverLogo.data, width: 170, margin: [0, 0, 0, 36] }
            : {
                image: model.brand.coverLogo.data,
                fit: [200, 70],
                margin: [0, 0, 0, 36],
              }) as Content,
        ]
      : []),
    { text: model.title, style: "title", tag: "H1" },
    ...(model.description
      ? [{ text: model.description, color: MUTED, margin: [0, 6, 0, 0] } as Content]
      : []),
    { text: meta, color: MUTED, fontSize: 10, margin: [0, 12, 0, 0] },
    ...(model.preparedBy
      ? [
          {
            text: currentWords().preparedBy(model.preparedBy),
            color: MUTED,
            fontSize: 10,
            margin: [0, 2, 0, 0],
          } as Content,
        ]
      : []),
    {
      canvas: [
        {
          type: "line",
          x1: 0,
          y1: 0,
          x2: contentWidth,
          y2: 0,
          lineWidth: 1,
          lineColor: EXPORT_PALETTE.line,
        },
      ],
      margin: [0, 18, 0, 18],
    },
  ];
  /** A document-control or contents page comes before the guide. */
  const front = Boolean(model.control) || Boolean(model.contents?.length);
  const startsPage = (content: Content[], breakBefore: boolean): Content[] =>
    breakBefore && content.length > 0 ? [{ stack: content, pageBreak: "before" }] : content;
  const section = (heading: string, body: RenderModel["intro"]): Content[] =>
    body
      ? [
          { text: heading, style: "h2", tag: "H2" },
          ...richTextToPdf(body, 3),
          { text: "", margin: [0, 0, 0, 10] },
        ]
      : [];

  return {
    pageSize: { width, height },
    pageMargins: [margin, top, margin, margin + 10],
    // Every page after the cover carries the small page logo.
    header: (current) =>
      !pageLogo || current === 1
        ? null
        : ({
            margin: [margin, margin - 18, margin, 0],
            alignment: "right",
            ...(pageLogo.type === "svg"
              ? { svg: pageLogo.data, height: 16 }
              : { image: pageLogo.data, fit: [120, 18] }),
          } as Content),
    info: {
      title: model.title,
      author: model.preparedBy || "Steps",
      creator: "Steps",
      producer: "Steps",
    },
    language: model.language,
    defaultStyle: { font: "Body", fontSize: 10.5, lineHeight: 1.25, color: EXPORT_PALETTE.ink },
    styles: {
      title: { font: "Heading", bold: true, fontSize: 24, color: model.brand.primary },
      h1: { font: "Heading", bold: true, fontSize: 17, color: model.brand.primary },
      h2: {
        font: "Heading",
        bold: true,
        fontSize: 13.5,
        color: model.brand.primary,
        margin: [0, 4, 0, 6],
      },
      h3: {
        font: "Heading",
        bold: true,
        fontSize: 11.5,
        color: model.brand.primary,
        margin: [0, 2, 0, 4],
      },
    },
    content: [
      ...cover,
      ...controlContent(model),
      ...contentsContent(model),
      // After a document-control or contents page, the guide starts on a page of its own
      // (one step per page already starts each step on one).
      ...startsPage(
        [...section(currentWords().beforeYouStart, model.intro)],
        front && !(options.layout === "page" && !model.intro),
      ),
      ...model.items.map((item, index): Content => {
        const content =
          item.kind === "step"
            ? stepCard(item, model, contentWidth, maxImageHeight, height - top - margin - 30)
            : blockContent(item, model, contentWidth, height - top - margin - 30);
        // One step per page: a new page before each step, or before the blocks that lead into it,
        // so a heading or tip stays with the step after it.
        const newPage =
          (options.layout === "page" && (index === 0 || model.items[index - 1]?.kind === "step")) ||
          (index === 0 && front && !model.intro);
        return newPage ? { stack: [content], pageBreak: "before" } : content;
      }),
      ...section(currentWords().youreDone, model.outro),
    ],
    // pdfmake draws the footer later, after this export's words have gone: they're kept here.
    footer: (current, total) => ({
      margin: [margin, 8, margin, 0],
      columns: [
        {
          text: [
            model.brand.footer,
            model.brand.footer && model.madeWith ? "  ·  " : "",
            ...(model.madeWith
              ? [{ text: footerWords.madeWith, link: footerWords.madeWithUrl }]
              : []),
          ],
          fontSize: 8,
          color: EXPORT_PALETTE.faint,
        },
        {
          text: footerWords.page(current, total),
          fontSize: 8,
          color: EXPORT_PALETTE.faint,
          alignment: "right",
        },
      ],
    }),
  };
}

interface PdfMake {
  createPdf: typeof pdfmakeModule.createPdf;
  setFonts: typeof pdfmakeModule.setFonts;
  setUrlAccessPolicy: typeof pdfmakeModule.setUrlAccessPolicy;
  addVirtualFileSystem?: (vfs: Record<string, string>) => void;
  virtualfs?: { writeFileSync(name: string, data: string, encoding: string): void };
}

// The browser build and the Node build (tests) are both CommonJS singletons.
const pdfmake = ((pdfmakeModule as unknown as { default?: PdfMake }).default ??
  pdfmakeModule) as unknown as PdfMake;

/** Builds the PDF. Nothing is fetched: fonts come in as bytes and images as data URLs. */
export async function renderPdf(
  model: RenderModel,
  fonts: PdfFonts,
  options: PdfOptions,
  compress = true,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {
    "heading-normal": fonts.heading.normal,
    "heading-bold": fonts.heading.bold,
    "body-normal": fonts.body.normal,
    "body-bold": fonts.body.bold,
    "body-italics": fonts.body.italics,
    "body-bolditalics": fonts.body.bolditalics,
    "mono-normal": fonts.mono ?? fonts.body.normal,
  };
  const vfs = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, base64(bytes)]),
  );
  if (pdfmake.addVirtualFileSystem) pdfmake.addVirtualFileSystem(vfs);
  else
    for (const [name, data] of Object.entries(vfs))
      pdfmake.virtualfs?.writeFileSync(name, data, "base64");
  pdfmake.setFonts({
    Heading: {
      normal: "heading-normal",
      bold: "heading-bold",
      italics: "heading-normal",
      bolditalics: "heading-bold",
    },
    Body: {
      normal: "body-normal",
      bold: "body-bold",
      italics: "body-italics",
      bolditalics: "body-bolditalics",
    },
    Mono: {
      normal: "mono-normal",
      bold: "mono-normal",
      italics: "mono-normal",
      bolditalics: "mono-normal",
    },
  });
  // No network: images are data URLs, and any URL in a document is refused.
  pdfmake.setUrlAccessPolicy(() => false);
  // Tagged (docs/spec/05-export.md#tagged-pdf): each line and picture is marked as what it is,
  // headers and footers as page furniture. The viewer shows the guide's title, not the file name.
  const base = pdfDefinition(model, options);
  let keys = 0;
  const newKey = () => `k${(keys += 1)}`;
  const furniture = <T>(make: T): T =>
    typeof make === "function"
      ? (((...args: unknown[]) => {
          const made = (make as (...given: unknown[]) => Content | null)(...args);
          return made ? tagDefinition(made, newKey, { parents: [], artifact: "Pagination" }) : made;
        }) as unknown as T)
      : make;
  const definition = {
    ...base,
    content: tagDefinition(base.content, newKey),
    header: furniture(base.header),
    footer: furniture(base.footer),
    compress,
    displayTitle: true,
    version: "1.7",
  };
  const buffer = await tagged(
    pdfmake as unknown as PdfMakeLike,
    definition as unknown as Record<string, unknown>,
  );
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as ArrayBuffer);
}
