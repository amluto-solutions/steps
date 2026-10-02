import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import type { RichText } from "@amluto-steps/core";

import { safeFontName, type RenderBlock, type RenderModel, type RenderStep } from "./model";
import {
  blockLook,
  CALLOUT_LOOK,
  calloutName,
  EXPORT_PALETTE,
  exportWords,
  withWords,
  currentWords,
} from "./words";
import { wrapCode } from "./wrap-code";

/** Word's proofing language: the export's own (docs/spec/05-export.md#languages), English as en-GB. */
const language = () => {
  const code = currentWords().language;
  return { value: code === "en" ? "en-GB" : code };
};
/** Screenshots fit the page width (6.3 in at 96 px per inch) and never take more than 5.5 in. */
const MAX_WIDTH_PX = 605;
const MAX_HEIGHT_PX = 528;
const hex = (colour: string) => colour.replace("#", "").toUpperCase();

const decodeDataUrl = (dataUrl: string): { bytes: Uint8Array; type: "jpg" | "png" } => {
  const [header = "", data = ""] = dataUrl.split(",");
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes, type: header.includes("image/png") ? "png" : "jpg" };
};

/** Pixel size of a PNG or JPEG from its header, or null if it can't be read. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    // Start-of-frame markers hold the size; C4 (Huffman), C8 and CC (arithmetic) don't.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

/** The cover logo, at most 48 px high and 240 px wide. SVG logos must be converted to PNG first. */
function logoParagraph(model: RenderModel): Paragraph[] {
  const logo = model.brand.coverLogo;
  if (!logo || logo.type === "svg") return [];
  const { bytes, type } = decodeDataUrl(logo.data);
  const size = imageSize(bytes);
  if (!size || size.width === 0 || size.height === 0) return [];
  const scale = Math.min(48 / size.height, 240 / size.width);
  return [
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new ImageRun({
          type,
          data: bytes,
          transformation: {
            width: Math.round(size.width * scale),
            height: Math.round(size.height * scale),
          },
          altText: { name: "Logo", title: "Logo", description: model.brand.name },
        }),
      ],
    }),
  ];
}

/**
 * The numbered lists in one document. Word numbers every paragraph of one numbering instance as
 * a single list, so each list gets its own instance (and starts at its own first number) instead
 * of carrying on from the list in an earlier step.
 */
export class ListNumbering {
  private next = 0;
  /** The first numbers lists start at, each needing its own numbering definition. */
  readonly starts = new Set<number>([1]);

  /** A new list: its reference and instance. */
  list(start: number): { reference: string; instance: number } {
    const first = Number.isInteger(start) && start >= 0 ? start : 1;
    this.starts.add(first);
    this.next += 1;
    return { reference: numbersFrom(first), instance: this.next };
  }
}

const numbersFrom = (start: number) => (start === 1 ? "numbers" : `numbers-from-${start}`);

/** Rich text as Word paragraphs: real lists, headings and clickable links. */
export function richTextToDocx(
  node: RichText | null,
  extra: Omit<IParagraphOptions, "children" | "text" | "heading" | "numbering"> = {},
  lists: ListNumbering = new ListNumbering(),
): Paragraph[] {
  if (!node?.content) return [];
  const runs = (children: RichText[] = []): ParagraphChild[] =>
    children.flatMap((child): ParagraphChild[] => {
      if (child.type === "hardBreak") return [new TextRun({ text: "", break: 1 })];
      if (child.type !== "text") return runs(child.content);
      const marks = child.marks ?? [];
      const options: IRunOptions = {
        text: child.text ?? "",
        bold: marks.some((mark) => mark.type === "bold"),
        italics: marks.some((mark) => mark.type === "italic"),
        language: language(),
      };
      const link = marks.find((mark) => mark.type === "link");
      return link && link.type === "link"
        ? [
            new ExternalHyperlink({
              link: link.attrs.href,
              children: [new TextRun({ ...options, style: "Hyperlink" })],
            }),
          ]
        : [new TextRun(options)];
    });
  const blocks = (child: RichText, level: number): Paragraph[] => {
    switch (child.type) {
      case "paragraph":
        return [new Paragraph({ ...extra, children: runs(child.content) })];
      case "heading":
        return [
          new Paragraph({
            ...extra,
            children: runs(child.content),
            heading: HeadingLevel.HEADING_3,
          }),
        ];
      case "bulletList":
      case "orderedList": {
        const numbering =
          child.type === "bulletList"
            ? { reference: "bullets" }
            : lists.list(child.attrs?.start ?? 1);
        return (child.content ?? []).flatMap((item) =>
          (item.content ?? []).flatMap((inner, position) =>
            inner.type === "paragraph" && position === 0
              ? [
                  new Paragraph({
                    ...extra,
                    children: runs(inner.content),
                    numbering: { ...numbering, level },
                  }),
                ]
              : blocks(inner, level + 1),
          ),
        );
      }
      case "callout": {
        // A coloured box: shaded paragraphs with the kind's bar, its kind in words first.
        const kind = child.attrs?.kind ?? "note";
        const look = CALLOUT_LOOK[kind];
        const panel = {
          ...extra,
          shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(look.fill) },
          border: { left: { style: BorderStyle.SINGLE, size: 24, color: hex(look.bar), space: 6 } },
          indent: { left: (typeof extra.indent?.left === "number" ? extra.indent.left : 0) + 180 },
        };
        return [
          new Paragraph({ ...panel, children: calloutLabelRuns(look, calloutName(kind)) }),
          ...richTextToDocx({ type: "doc", content: child.content ?? [] }, panel, lists),
        ];
      }
      default:
        return [];
    }
  };
  return node.content.flatMap((child) => blocks(child, 0));
}

/** Consolas is on every Windows PC; Word falls back to its own monospace elsewhere. */
const CODE_FONT = "Consolas";
/**
 * Consolas characters that fit the shaded box on an A4 page (Word wraps any line longer, after a
 * hyphen if it likes), at 9.5 pt for code and 8.5 pt for output. Lines are wrapped at spaces first.
 */
const CODE_COLUMNS = 78;
const OUTPUT_COLUMNS = 86;

/**
 * Text as one shaded monospace paragraph, a line break per line, so it copies out of Word
 * cleanly (docs/spec/05-export.md#code).
 */
function codeParagraph(text: string, size: number, fill: string, keepNext: boolean): Paragraph {
  const rule = {
    style: BorderStyle.SINGLE,
    size: 4,
    color: hex(EXPORT_PALETTE.codeRule),
    space: 4,
  };
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(fill) },
    border: { top: rule, bottom: rule, left: rule, right: rule },
    indent: { left: 460, right: 100 },
    spacing: { before: 60, after: 120 },
    keepNext,
    keepLines: text.split("\n").length <= 40,
    children: text
      .split("\n")
      .map(
        (line, index) =>
          new TextRun({ text: line, font: CODE_FONT, size, break: index > 0 ? 1 : 0 }),
      ),
  });
}

function codeParagraphs(step: RenderStep): Paragraph[] {
  const code = step.code;
  if (!code) return [];
  const label = (text: string) =>
    new Paragraph({
      indent: { left: 360 },
      spacing: { before: 60, after: 0 },
      keepNext: true,
      children: [
        new TextRun({
          text,
          bold: true,
          size: 16,
          color: hex(EXPORT_PALETTE.muted),
          language: language(),
        }),
      ],
    });
  const result: Paragraph[] = [];
  if (code.label) result.push(label(code.label.toUpperCase()));
  result.push(codeParagraph(wrapCode(code.text, CODE_COLUMNS), 19, EXPORT_PALETTE.codePaper, true));
  if (code.output) {
    result.push(
      label(
        code.outputShortened
          ? `${currentWords().output} (${currentWords().shortened})`
          : currentWords().output,
      ),
      codeParagraph(
        wrapCode(code.output, OUTPUT_COLUMNS),
        17,
        EXPORT_PALETTE.panel,
        step.image !== null,
      ),
    );
  }
  return result;
}

function stepParagraphs(step: RenderStep, lists: ListNumbering): Paragraph[] {
  const result = [
    new Paragraph({
      children: [new TextRun({ text: step.text, bold: true, language: language() })],
      numbering: { reference: "steps", level: 0 },
      keepNext: true,
      spacing: { before: 240, after: 80 },
    }),
    ...codeParagraphs(step),
  ];
  if (step.image) {
    const { bytes, type } = decodeDataUrl(step.image.dataUrl);
    const scale = Math.min(1, MAX_WIDTH_PX / step.image.width, MAX_HEIGHT_PX / step.image.height);
    result.push(
      new Paragraph({
        keepNext: step.notes !== null,
        children: [
          new ImageRun({
            type,
            data: bytes,
            transformation: {
              width: Math.round(step.image.width * scale),
              height: Math.round(step.image.height * scale),
            },
            altText: {
              name: `Step ${step.number}`,
              title: `Step ${step.number}`,
              description: step.altText,
            },
          }),
        ],
      }),
    );
  }
  result.push(...richTextToDocx(step.notes, { indent: { left: 360 } }, lists));
  return result;
}

/**
 * A section heading's bookmark, for the contents page's links. Word allows 40 letters, digits and
 * underscores, starting with a letter.
 */
export const wordAnchor = (id: string) =>
  `section_${id.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 40);

/** Light rules between rows only, as in the PDF. */
const ROW_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: "auto" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
  left: { style: BorderStyle.NONE, size: 0, color: "auto" },
  right: { style: BorderStyle.NONE, size: 0, color: "auto" },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: hex(EXPORT_PALETTE.line) },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
};

const cell = (children: ParagraphChild[], width?: number) =>
  new TableCell({
    children: [new Paragraph({ children, spacing: { before: 60, after: 60 } })],
    ...(width ? { width: { size: width, type: WidthType.PERCENTAGE } } : {}),
  });

const run = (text: string, muted = false, bold = false) =>
  new TextRun({
    text,
    language: language(),
    bold,
    ...(muted ? { color: hex(EXPORT_PALETTE.muted) } : {}),
  });

const table = (rows: TableRow[]) =>
  new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: ROW_BORDERS });

/**
 * The contents page: each section, linked to its heading, with its steps. Word would need to
 * refresh a page-number field as the file opens, so the steps stand in for page numbers.
 */
function contentsBlocks(model: RenderModel): (Paragraph | Table)[] {
  const sections = model.contents ?? [];
  if (sections.length === 0) return [];
  return [
    new Paragraph({ text: currentWords().contents, heading: HeadingLevel.HEADING_2 }),
    table(
      sections.map(
        (section) =>
          new TableRow({
            children: [
              cell(
                [
                  section.id
                    ? new InternalHyperlink({
                        anchor: wordAnchor(section.id),
                        children: [
                          new TextRun({
                            text: section.heading,
                            style: "Hyperlink",
                            language: language(),
                          }),
                        ],
                      })
                    : run(section.heading),
                ],
                70,
              ),
              cell([run(currentWords().stepRange(section.first, section.last), true)], 30),
            ],
          }),
      ),
    ),
  ];
}

/** The document-control page: the guide's details, then its saved versions. */
function controlBlocks(model: RenderModel): (Paragraph | Table)[] {
  const control = model.control;
  if (!control) return [];
  const words = currentWords().control;
  const row = (label: string, value: string) =>
    new TableRow({ children: [cell([run(label, true)], 30), cell([run(value)], 70)] });
  return [
    new Paragraph({ text: currentWords().documentControl, heading: HeadingLevel.HEADING_2 }),
    table([
      row(words.title, model.title),
      row(words.owner, control.owner || words.notSet),
      ...(model.preparedBy ? [row(words.preparedBy, model.preparedBy)] : []),
      row(words.created, currentWords().dateBy(control.created, control.createdBy)),
      row(words.updated, currentWords().dateBy(control.updated, control.updatedBy)),
      row(words.reviewBy, control.reviewBy ?? words.notSet),
      row(words.exported, model.date),
    ]),
    new Paragraph({ text: words.history, heading: HeadingLevel.HEADING_3 }),
    control.versions.length > 0
      ? table([
          new TableRow({
            tableHeader: true,
            children: [
              cell([run(words.date, true, true)], 16),
              cell([run(words.by, true, true)], 24),
              cell([run(words.note, true, true)], 48),
              cell([run(words.steps, true, true)], 12),
            ],
          }),
          ...control.versions.map(
            (version) =>
              new TableRow({
                children: [
                  cell([run(version.date)], 16),
                  cell([run(version.by)], 24),
                  cell([run(version.note)], 48),
                  cell([run(String(version.steps))], 12),
                ],
              }),
          ),
        ])
      : new Paragraph({ children: [run(words.noVersions, true)] }),
  ];
}

function blockParagraphs(
  block: RenderBlock,
  model: RenderModel,
  lists: ListNumbering,
): Paragraph[] {
  if (block.type === "header") {
    // Bookmarked, so the contents page can link here.
    return [
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new Bookmark({
            id: wordAnchor(block.id),
            children: [new TextRun({ text: block.heading, language: language() })],
          }),
        ],
      }),
    ];
  }
  if (block.type === "text") {
    return [
      ...(block.heading
        ? [new Paragraph({ text: block.heading, heading: HeadingLevel.HEADING_3 })]
        : []),
      ...richTextToDocx(block.body, {}, lists),
    ];
  }
  const look = blockLook(block);
  const accent = hex(look.bar);
  const panel = {
    shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(look.fill) },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 6 } },
    indent: { left: 180 },
  };
  return [
    new Paragraph({
      ...panel,
      children: calloutLabelRuns(look, look.label),
      spacing: { before: 200 },
    }),
    ...richTextToDocx(block.body, panel, lists),
  ];
}

/**
 * A coloured box's label: its icon as a Segoe UI Symbol character (Word keeps it plain and in
 * the ink colour, where a picture would need a PNG), then its kind or heading.
 */
function calloutLabelRuns(look: { ink: string; symbol: string }, label: string): TextRun[] {
  const colour = hex(look.ink);
  return [
    new TextRun({
      text: `${look.symbol} `,
      font: "Segoe UI Symbol",
      bold: true,
      color: colour,
      language: language(),
    }),
    new TextRun({ text: label, bold: true, color: colour, language: language() }),
  ];
}

/**
 * The Word export: the accessible deliverable (docs/spec/05-export.md#accessibility-of-the-outputs).
 * The title is heading 1, section headers heading 2, steps a real numbered list, and every
 * screenshot has alt text. The document language is set.
 */
function docxDocument(model: RenderModel): Document {
  const meta = currentWords().coverParts(model.stepCount, model.minutes, model.date).join(" · ");
  const lists = new ListNumbering();
  const section = (heading: string, body: RichText | null): Paragraph[] =>
    body
      ? [
          new Paragraph({ text: heading, heading: HeadingLevel.HEADING_2 }),
          ...richTextToDocx(body, {}, lists),
        ]
      : [];
  // A document-control or contents page comes before the guide, which then starts a new page.
  const front = [...controlBlocks(model), ...contentsBlocks(model)];
  const children: (Paragraph | Table)[] = [
    ...logoParagraph(model),
    new Paragraph({ text: model.title, heading: HeadingLevel.HEADING_1 }),
    ...(model.description
      ? [
          new Paragraph({
            children: [new TextRun({ text: model.description, language: language() })],
          }),
        ]
      : []),
    new Paragraph({
      children: [
        new TextRun({ text: meta, color: hex(EXPORT_PALETTE.muted), language: language() }),
      ],
    }),
    ...(model.preparedBy
      ? [
          new Paragraph({
            children: [
              new TextRun({
                text: currentWords().preparedBy(model.preparedBy),
                color: hex(EXPORT_PALETTE.muted),
                language: language(),
              }),
            ],
          }),
        ]
      : []),
    ...front,
    ...(front.length > 0 ? [new Paragraph({ children: [new PageBreak()] })] : []),
    ...section(currentWords().beforeYouStart, model.intro),
    ...model.items.flatMap((item) =>
      item.kind === "step" ? stepParagraphs(item, lists) : blockParagraphs(item, model, lists),
    ),
    ...section(currentWords().youreDone, model.outro),
  ];
  const primary = hex(model.brand.primary);
  // Named only: Word uses the font if the reader has it (docs/spec/05-export.md#fonts).
  const headingFont = safeFontName(model.brand.headingFont, "Century Gothic");
  const bodyFont = safeFontName(model.brand.bodyFont, "Aptos");
  const document = new Document({
    title: model.title,
    creator: model.preparedBy || "Steps",
    description: model.description,
    styles: {
      default: {
        document: { run: { font: bodyFont, size: 22, language: language() } },
        heading1: {
          run: { font: headingFont, size: 40, bold: true, color: primary },
          paragraph: { spacing: { after: 120 } },
        },
        heading2: {
          run: { font: headingFont, size: 28, bold: true, color: primary },
          paragraph: { spacing: { before: 280, after: 100 } },
        },
        heading3: { run: { font: headingFont, size: 24, bold: true, color: primary } },
      },
    },
    numbering: {
      config: [
        {
          reference: "steps",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { run: { bold: true, color: primary } },
            },
          ],
        },
        {
          reference: "bullets",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 + level * 360, hanging: 260 } } },
          })),
        },
        ...[...lists.starts].map((start) => ({
          reference: numbersFrom(start),
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            start: level === 0 ? start : 1,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 + level * 360, hanging: 260 } } },
          })),
        })),
      ],
    },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: [
                      model.brand.footer,
                      model.brand.footer && model.madeWith ? " · " : "",
                    ].join(""),
                    size: 16,
                    color: hex(EXPORT_PALETTE.faint),
                  }),
                  ...(model.madeWith
                    ? [
                        new ExternalHyperlink({
                          link: currentWords().madeWithUrl,
                          children: [
                            new TextRun({
                              text: currentWords().madeWith,
                              size: 16,
                              color: hex(EXPORT_PALETTE.faint),
                            }),
                          ],
                        }),
                      ]
                    : []),
                  new TextRun({
                    // "Page 2 of 5" in the export's language, Word filling in the numbers.
                    children: [
                      "  ·  ",
                      ...currentWords()
                        .pageTemplate.split(/(\{current\}|\{total\})/)
                        .filter(Boolean)
                        .map((part) =>
                          part === "{current}"
                            ? PageNumber.CURRENT
                            : part === "{total}"
                              ? PageNumber.TOTAL_PAGES
                              : part,
                        ),
                    ],
                    size: 16,
                    color: hex(EXPORT_PALETTE.faint),
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return document;
}

/** A Word document of the guide, in the model's language (docs/spec/05-export.md#languages). */
export async function renderDocx(model: RenderModel): Promise<Uint8Array> {
  const document = withWords(exportWords(model.language), () => docxDocument(model));
  return new Uint8Array(await Packer.toArrayBuffer(document));
}
