import { z } from "zod";

import { codeSchema } from "./code.ts";
import { FORMAT_VERSION } from "./format.ts";
import { TONES } from "./step-text/phrase.ts";

/**
 * The on-disk guide and step files, format version 1 (docs/spec/03-data-and-sharing.md). Every
 * file read from a library passes through these schemas; unknown fields are dropped and a newer
 * format is refused (docs/spec/08-privacy-and-security.md#hostile-files).
 */

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const percent = z.number().finite();

/** Links in notes may only point at web pages or email (never `javascript:` or files). */
export const isSafeHref = (href: string): boolean => /^(https?:|mailto:)/i.test(href);

const safeHref = z.string().max(2048).refine(isSafeHref, "Only web and email links are allowed.");

const mark = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }).strip(),
  z.object({ type: z.literal("italic") }).strip(),
  z
    .object({
      type: z.literal("link"),
      attrs: z.object({ href: safeHref }).strip(),
    })
    .strip(),
]);

/**
 * The coloured boxes of code documentation (28/09/2026): a note in blue, a tip in green, a
 * warning in amber and an important point in red. Each is also named in words wherever it's
 * shown, since colour alone doesn't tell everyone (WCAG 1.4.1).
 */
export const CALLOUT_KINDS = ["note", "tip", "warning", "important"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export interface RichTextNode {
  type:
    | "doc"
    | "paragraph"
    | "text"
    | "heading"
    | "bulletList"
    | "orderedList"
    | "listItem"
    | "hardBreak"
    | "callout";
  text?: string;
  attrs?: { level?: number; start?: number; kind?: CalloutKind };
  marks?: z.infer<typeof mark>[];
  content?: RichTextNode[];
}

/**
 * Rich text for notes, intro, outro and blocks: TipTap JSON limited to an allow-list of nodes and
 * marks. It is rendered from this structure, never as HTML (docs/spec/08-privacy-and-security.md).
 */
export const richTextNodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "doc",
        "paragraph",
        "text",
        "heading",
        "bulletList",
        "orderedList",
        "listItem",
        "hardBreak",
        // A coloured box in notes: its `kind` says which. One from a newer version reads as a note.
        "callout",
      ]),
      text: z.string().max(20_000).optional(),
      attrs: z
        .object({
          level: z.number().int().min(1).max(3).optional(),
          start: z.number().int().min(0).optional(),
          kind: z.enum(CALLOUT_KINDS).optional().catch("note"),
        })
        .strip()
        .optional(),
      marks: z.array(mark).max(10).optional(),
      content: z.array(richTextNodeSchema).max(2_000).optional(),
    })
    .strip(),
) as z.ZodType<RichTextNode>;

export const richTextSchema = richTextNodeSchema.refine((node) => node.type === "doc", {
  message: "Rich text must start with a document node.",
});
export type RichText = RichTextNode;

const highlight = z
  .object({ shape: z.enum(["circle", "box"]), x: percent, y: percent, w: percent, h: percent })
  .strip();
const rect = z.object({ x: percent, y: percent, w: percent, h: percent }).strip();

/**
 * The colours an arrow, box or label can take besides the brand's accent, which is the default and
 * isn't stored (28/09/2026). Six in all, so guides stay consistent.
 */
export const MARK_COLOURS = ["red", "amber", "green", "black", "white"] as const;
export type MarkColour = (typeof MARK_COLOURS)[number];
/** The same in every brand, and dark enough to show on a white screenshot (white aside). */
export const MARK_COLOUR_HEX: Record<MarkColour, string> = {
  red: "#D92D20",
  amber: "#DC8A00",
  green: "#1E8A4C",
  black: "#101828",
  white: "#FFFFFF",
};
/** A mark's colour as a hex value, the brand's accent when it has none. */
export const markColourHex = (colour: MarkColour | undefined, accent: string): string =>
  colour ? MARK_COLOUR_HEX[colour] : accent;
// A colour from a newer version reads as the accent rather than refusing the step.
const markColour = z.enum(MARK_COLOURS).optional().catch(undefined);

export const annotationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("arrow"),
      from: z.tuple([percent, percent]),
      to: z.tuple([percent, percent]),
      colour: markColour,
    })
    .strip(),
  z
    .object({
      type: z.literal("label"),
      x: percent,
      y: percent,
      text: z.string().max(500),
      colour: markColour,
    })
    .strip(),
  z
    .object({
      type: z.literal("box"),
      x: percent,
      y: percent,
      w: percent,
      h: percent,
      colour: markColour,
    })
    .strip(),
]);
export type Annotation = z.infer<typeof annotationSchema>;

/**
 * A block's kind. The stored names predate the coloured boxes and are kept so older guides open:
 * `callout` is the blue note and `alert` the red "important"; `warning` (amber) was added.
 */
export const BLOCK_TYPES = ["header", "text", "callout", "tip", "warning", "alert"] as const;

/** Which coloured box a block is, or null for a heading or plain text. */
export const calloutOfBlock = (type: string): CalloutKind | null =>
  (
    ({ callout: "note", tip: "tip", warning: "warning", alert: "important" }) as Record<
      string,
      CalloutKind
    >
  )[type] ?? null;

export const blockSchema = z
  .object({
    type: z.enum(BLOCK_TYPES),
    heading: z.string().max(500),
    body: richTextSchema.nullable(),
  })
  .strip();
export type Block = z.infer<typeof blockSchema>;

/**
 * A guide's or step's own words in another language than its main one (docs/spec/03-data-and-
 * sharing.md#languages): only what someone wrote; anything missing shows the main language, and a
 * recorded step's wording is worked out from what was recorded. Keyed by language code, at most
 * one per language Steps has.
 */
const languageKey = z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$/);

export const stepTextSchema = z
  .object({
    actionText: z.string().max(2_000).optional(),
    notes: richTextSchema.nullable().optional(),
    altText: z.string().max(2_000).nullable().optional(),
    /** A block's heading and body. */
    heading: z.string().max(500).optional(),
    body: richTextSchema.nullable().optional(),
  })
  .strip();
export type StepText = z.infer<typeof stepTextSchema>;

export const guideTextSchema = z
  .object({
    title: z.string().max(300).optional(),
    description: z.string().max(5_000).optional(),
    intro: richTextSchema.nullable().optional(),
    outro: richTextSchema.nullable().optional(),
  })
  .strip();
export type GuideText = z.infer<typeof guideTextSchema>;

const translations = <T extends z.ZodTypeAny>(text: T) =>
  z
    .record(languageKey, text)
    .refine((record) => Object.keys(record).length <= 64, "Too many languages.")
    .optional();

const formatVersion = z
  .number()
  .int()
  .min(1)
  .refine((version) => version <= FORMAT_VERSION, {
    message: "This guide was made by a newer version of Steps.",
  });

export const guideStepSchema = z
  .object({
    id,
    sortKey: z.string().regex(/^[0-9a-z]{1,200}$/),
    kind: z.enum(["interaction", "block"]),
    action: z.string().max(40),
    actionText: z.string().max(2_000),
    textParts: z
      .object({
        verb: z.string().max(200),
        target: z.string().max(2_000),
        kind: z.string().max(200),
        value: z.string().max(2_000).optional(),
      })
      .strip(),
    showValue: z.boolean(),
    textEdited: z.boolean(),
    notes: richTextSchema.nullable(),
    altText: z.string().max(2_000).nullable(),
    context: z
      .object({ app: z.string().max(260).nullable(), windowTitle: z.string().max(2_000) })
      .strip(),
    target: z.unknown(),
    media: z
      .object({
        id: id.nullable(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        scale: z.number().nullable(),
        captureRect: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
      })
      .strip()
      .nullable(),
    highlight: highlight.nullable(),
    crop: rect.extend({ source: z.enum(["auto", "manual"]) }).nullable(),
    redactions: z.array(rect.extend({ source: z.enum(["manual", "suggested"]) })).max(500),
    /**
     * Areas someone marked "Not personal": suggested blurs there aren't offered again, in the
     * editor or the export review (30/09/2026). Absent on most steps.
     */
    notPersonal: z.array(rect).max(200).optional(),
    annotations: z.array(annotationSchema).max(200),
    block: blockSchema.nullable(),
    /** A command, code or formula shown as a code block. Absent on other steps. */
    code: codeSchema.nullable().optional(),
    capturedAt: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string().max(200),
    formatVersion,
    reviewRequired: z.boolean().optional(),
    /** Its words in other languages, where someone wrote them (01/10/2026). */
    translations: translations(stepTextSchema),
  })
  .strip();
export type GuideStep = z.infer<typeof guideStepSchema>;

export const guideSchema = z
  .object({
    id,
    title: z.string().max(300),
    description: z.string().max(5_000),
    intro: richTextSchema.nullable(),
    outro: richTextSchema.nullable(),
    brandProfileId: z.string().nullable(),
    tags: z.array(z.string().max(60)).max(50),
    owner: z.string().max(200),
    reviewBy: z.string().nullable(),
    createdAt: z.string(),
    createdBy: z.string().max(200),
    updatedAt: z.string(),
    updatedBy: z.string().max(200),
    recordingSessionId: id.optional(),
    /**
     * The language its recorded steps are worded in, and what shows where a translation is
     * missing (packages/core/src/languages.ts). English when absent.
     */
    // A language code, as the desktop checks it: it goes into exported pages' markup.
    language: languageKey.optional(),
    /** How its recorded steps are worded: casual when absent, plain or formal. */
    // A tone from a newer version reads as casual rather than failing the guide.
    tone: z.enum(TONES).optional().catch(undefined),
    /** Its title, description, intro and outro in other languages, where someone wrote them. */
    translations: translations(guideTextSchema),
    formatVersion,
  })
  .strip();
export type Guide = z.infer<typeof guideSchema>;

/**
 * Reads a guide file leniently where older builds were loose (missing optional fields get their
 * defaults), and strictly everywhere else.
 */
export function parseGuide(value: unknown): Guide {
  const input = typeof value === "object" && value !== null ? value : {};
  return guideSchema.parse({
    description: "",
    intro: null,
    outro: null,
    brandProfileId: null,
    tags: [],
    owner: "",
    reviewBy: null,
    createdBy: "",
    updatedBy: "",
    ...input,
  });
}

/** Reads a step file, filling fields older recordings didn't write. */
export function parseStep(value: unknown): GuideStep {
  const input = typeof value === "object" && value !== null ? value : {};
  return guideStepSchema.parse({
    textEdited: false,
    notes: null,
    altText: null,
    crop: null,
    redactions: [],
    annotations: [],
    block: null,
    updatedBy: "",
    ...input,
  });
}
