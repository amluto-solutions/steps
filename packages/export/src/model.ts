import type { Block, Guide, GuideStep, RichText } from "@amluto-steps/core";
import { AMLUTO_COLOURS, formatDate, visibleStepText, withoutTypedValue } from "@amluto-steps/core";

/** A screenshot as it will be exported: blur, crop, highlight and annotations already drawn in. */
import type { Overlay } from "./geometry";
import { currentWords, exportWords, withWords } from "./words";

export interface RenderedImage {
  /** `data:image/jpeg;base64,…` or `data:image/png;base64,…`. */
  dataUrl: string;
  width: number;
  height: number;
  /** Marks for drawing live (the walkthrough); already drawn into `dataUrl` for other formats. */
  overlay?: Overlay;
  /** The walkthrough's camera: where it ends, as percentages of this picture (`camera.ts`). */
  camera?: { x: number; y: number; w: number; h: number } | null;
}

export interface RenderStep {
  kind: "step";
  id: string;
  number: number;
  /** The wording as shown: hidden typed values are already left out of it. */
  text: string;
  notes: RichText | null;
  altText: string;
  image: RenderedImage | null;
  /** Flagged for the review before export (unnamed click, missed clicks). */
  needsCheck: boolean;
  /** What the walkthrough animates for this kind of step (docs/spec/05-export.md#motion). */
  motion: StepMotion | null;
  /** A command, code or formula, shown as a code block (docs/spec/05-export.md#code). */
  code: RenderCode | null;
}

export interface RenderCode {
  text: string;
  /** The block's label ("PowerShell", "Excel formula"); empty for plain text. */
  label: string;
  /** What the command printed, when kept; null for none. */
  output: string | null;
  outputShortened: boolean;
}

/** Typed values only when shown; the rest come from the step's own wording. */
export type StepMotion =
  | { type: "typed"; value: string }
  | { type: "keys"; keys: string[] }
  | { type: "url"; url: string }
  | { type: "app"; name: string };

export function motionFor(step: GuideStep): StepMotion | null {
  const target = step.textParts.target.trim();
  if (step.action === "input" && step.showValue && step.textParts.value)
    return { type: "typed", value: step.textParts.value };
  if (step.textParts.kind === "shortcut" && target) {
    const keys = target.split(/\s*\+\s*/).filter(Boolean);
    return keys.length > 0 ? { type: "keys", keys } : null;
  }
  if (step.action === "navigation" && target) return { type: "url", url: target };
  if (step.action === "appswitch" && target) return { type: "app", name: target };
  return null;
}

export interface RenderBlock {
  kind: "block";
  id: string;
  type: Block["type"];
  heading: string;
  body: RichText | null;
}

export interface BrandLook {
  name: string;
  primary: string;
  accent: string;
  highlight: string;
  /** SVG text, or a PNG/JPEG data URL, for the cover; null for none. */
  coverLogo: { type: "svg" | "png" | "jpeg"; data: string } | null;
  /** A small logo at the top of every page after the cover; null for none. */
  pageLogo: { type: "svg" | "png" | "jpeg"; data: string } | null;
  /** Font families by name, for Word and the web page (the PDF gets the font files). */
  headingFont: string;
  bodyFont: string;
  footer: string;
}

/**
 * A section of the guide for the contents page: a header block and the steps after it, up to the
 * next header. Steps before the first header are "First steps", with no header of their own.
 */
export interface RenderSection {
  /** The header block's id (an anchor in PDF and Word); null for the steps before any header. */
  id: string | null;
  heading: string;
  first: number | null;
  last: number | null;
  /** The section's first step, where the PDF points "First steps", which has no heading. */
  firstStepId: string | null;
}

/** A saved version, as the document-control page lists it. */
export interface ControlVersion {
  /** dd/mm/yyyy */
  date: string;
  by: string;
  note: string;
  steps: number;
}

/** The document-control page: who owns the guide, when it changed, and its saved versions. */
export interface DocumentControl {
  owner: string;
  /** dd/mm/yyyy */
  created: string;
  createdBy: string;
  updated: string;
  updatedBy: string;
  /** dd/mm/yyyy, or null when no review date is set. */
  reviewBy: string | null;
  /** Newest first. */
  versions: ControlVersion[];
}

/**
 * What every export format is built from (docs/spec/05-export.md). It holds only what the reader
 * should see: no typed values whose toggle is off, no comments, no original screenshots.
 */
export interface RenderModel {
  title: string;
  description: string;
  intro: RichText | null;
  outro: RichText | null;
  preparedBy: string;
  /** dd/mm/yyyy */
  date: string;
  stepCount: number;
  minutes: number;
  /**
   * The language it's in (docs/spec/05-export.md#languages): `en-GB` for English, as exports have
   * always said, or the language's own code; files and pages say it so screen readers read it right.
   */
  language: string;
  brand: BrandLook;
  /** The "Made with Steps" line, linking to steps.amluto.com (Settings > General). */
  madeWith: boolean;
  items: (RenderStep | RenderBlock)[];
  /** The contents page's sections (PDF and Word), or null for none. */
  contents: RenderSection[] | null;
  /** The document-control page (PDF and Word), or null for none. */
  control: DocumentControl | null;
}

/**
 * The guide's sections, from its header blocks; empty when it has none, since a contents page
 * without sections would only repeat the steps.
 */
export function sectionsOf(items: RenderModel["items"]): RenderSection[] {
  const sections: RenderSection[] = [];
  let current: RenderSection | null = null;
  for (const item of items) {
    if (item.kind === "block" && item.type === "header") {
      current = {
        id: item.id,
        heading: item.heading.trim() || currentWords().untitledSection,
        first: null,
        last: null,
        firstStepId: null,
      };
      sections.push(current);
    } else if (item.kind === "step") {
      if (!current) {
        current = {
          id: null,
          heading: currentWords().firstSteps,
          first: null,
          last: null,
          firstStepId: null,
        };
        sections.push(current);
      }
      current.first ??= item.number;
      current.firstStepId ??= item.id;
      current.last = item.number;
    }
  }
  return sections.some((section) => section.id !== null) ? sections : [];
}

/** How many sections a guide's steps make: header blocks, for the contents page's default. */
export const headerCount = (steps: GuideStep[]) =>
  steps.filter((step) => step.kind === "block" && step.block?.type === "header").length;

/** A `YYYY-MM-DD` review date in the language's form, without a time zone moving it a day. */
const dayOf = (value: string | null, language: string) => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  return parts
    ? formatDate(new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])), language)
    : null;
};

/** An ISO time as a date in the language's form, or "" when it isn't one. */
const dateOf = (value: string, language: string) => {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "" : formatDate(time, language);
};

export const AMLUTO_LOOK: BrandLook = {
  name: "Amluto",
  ...AMLUTO_COLOURS,
  coverLogo: null,
  pageLogo: null,
  headingFont: "Century Gothic",
  bodyFont: "Aptos",
  footer: "",
};

/** A font family name safe to put in CSS or a Word style (letters, digits, spaces, dashes). */
export const safeFontName = (name: string, fallback: string) =>
  /^[A-Za-z0-9 -]{1,80}$/.test(name.trim()) ? name.trim() : fallback;

/** dd/mm/yyyy, shared with the app. */
export { formatDate } from "@amluto-steps/core";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export const richTextWords = (node: RichText | null): number =>
  !node
    ? 0
    : words(node.text ?? "") +
      (node.content ?? []).reduce((sum, child) => sum + richTextWords(child), 0);

/**
 * The old tool's estimate: 15 s, plus 8 s a step (12 s for typing), plus reading time at 200
 * words a minute. At least one minute.
 */
export function estimateMinutes(guide: Guide, steps: GuideStep[]): number {
  let seconds = 15;
  let reading = words(guide.description) + richTextWords(guide.intro) + richTextWords(guide.outro);
  for (const step of steps) {
    if (step.kind === "interaction") seconds += step.action === "input" ? 12 : 8;
    reading += words(step.actionText) + richTextWords(step.notes);
    if (step.block) reading += words(step.block.heading) + richTextWords(step.block.body);
  }
  seconds += (reading / 200) * 60;
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * Alt text: the person's own if they wrote one, otherwise generated from the step. Either way a
 * hidden typed value is taken out, as it is from the step text.
 */
export const altTextFor = (step: GuideStep, number: number) => {
  const own = step.altText?.trim();
  const text = own || currentWords().screenshotFor(number, step.actionText);
  return step.showValue ? text : withoutTypedValue(text, step.textParts.value);
};

/**
 * Everything an export shows, built once for every format (docs/spec/05-export.md), in the export's
 * language: its fixed words and dates (the guide's own text comes in that language already).
 */
export function buildRenderModel(
  guide: Guide,
  steps: GuideStep[],
  images: ReadonlyMap<string, RenderedImage>,
  options: Parameters<typeof buildModel>[3],
): RenderModel {
  return withWords(exportWords(options.language ?? "en"), () =>
    buildModel(guide, steps, images, options),
  );
}

function buildModel(
  guide: Guide,
  steps: GuideStep[],
  images: ReadonlyMap<string, RenderedImage>,
  options: {
    preparedBy: string;
    now: Date;
    brand?: BrandLook;
    madeWith?: boolean;
    /** Add a contents page from the header blocks (PDF and Word). */
    contents?: boolean;
    /** The language the guide is exported in (its text already in it): English when absent. */
    language?: string;
    /** Add a document-control page, with the guide's saved versions, newest first. */
    documentControl?: {
      versions: { createdAt: string; createdBy: string; note: string; stepCount: number }[];
    } | null;
  },
): RenderModel {
  const language = options.language ?? "en";
  let number = 0;
  const items = steps.map((step): RenderStep | RenderBlock => {
    if (step.kind === "block" && step.block) {
      return {
        kind: "block",
        id: step.id,
        type: step.block.type,
        heading: step.block.heading,
        body: step.block.body,
      };
    }
    number += 1;
    return {
      kind: "step",
      id: step.id,
      number,
      // Never a hidden typed value, even one left in hand-edited wording.
      text: visibleStepText(step),
      notes: step.notes,
      altText: altTextFor(step, number),
      image: images.get(step.id) ?? null,
      needsCheck: step.reviewRequired === true,
      motion: motionFor(step),
      code: step.code
        ? {
            text: step.code.text,
            label: currentWords().codeLabel(step.code.language),
            output: step.code.output?.trim() ? step.code.output : null,
            outputShortened: step.code.outputShortened,
          }
        : null,
    };
  });
  return {
    title: guide.title.trim() || currentWords().untitledGuide,
    description: guide.description.trim(),
    intro: guide.intro,
    outro: guide.outro,
    preparedBy: options.preparedBy.trim(),
    date: formatDate(options.now, language),
    stepCount: number,
    minutes: estimateMinutes(guide, steps),
    language: language === "en" ? "en-GB" : language,
    brand: options.brand ?? AMLUTO_LOOK,
    madeWith: options.madeWith ?? true,
    items,
    contents: options.contents ? sectionsOf(items) : null,
    control: options.documentControl
      ? {
          owner: guide.owner.trim(),
          created: dateOf(guide.createdAt, language),
          createdBy: guide.createdBy,
          updated: dateOf(guide.updatedAt, language),
          updatedBy: guide.updatedBy,
          reviewBy: dayOf(guide.reviewBy, language),
          versions: [...options.documentControl.versions]
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
            .map((version) => ({
              date: dateOf(version.createdAt, language),
              by: version.createdBy,
              note: version.note.trim(),
              steps: version.stepCount,
            })),
        }
      : null,
  };
}
