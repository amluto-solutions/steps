import { spreadKeys, type Guide, type GuideStep } from "@amluto-steps/core";

import type { EditorDoc } from "../editor/document";
import { blockStep } from "../editor/edits";
import type { MediaFrom } from "../library-bridge";

/** One guide going into a merge, in the order it goes in. */
export interface MergePart {
  libraryId: string;
  doc: EditorDoc;
}

export interface MergeOptions {
  title: string;
  /** A header block with each guide's title before its part (the default). */
  headings: boolean;
  author: string;
  now: Date;
  /** A new id, unique within the merge (steps, blocks, screenshots and the guide itself). */
  newId: (prefix: string) => string;
}

/** The most tags a guide can carry (the format's limit). */
const MAX_TAGS = 50;

/**
 * Merge guides (docs/spec/04-editor.md#merge-guides): one new guide from several, in the order
 * given, worked out here once for both editions; storage then writes it (`createFromParts`).
 *
 * - Every step and screenshot gets a new id: recordings name theirs `capture-12` and
 *   `click-12.webp`, so two guides almost always share names. A screenshot two steps share (a split
 *   step) is copied once.
 * - With `headings`, each part starts with a header block of its guide's title, which the contents
 *   page and the walkthrough's sections then use.
 * - The first guide's intro and the last one's outro stay where they are; every other intro and
 *   outro becomes a text block at the start or end of its part, so no words go missing.
 * - Details: the first guide's description, owner and brand; every guide's tags (up to the
 *   format's 50); the earliest review-by date, as the guide is only as current as its oldest part.
 *   No versions, comments or recording link: it starts afresh.
 */
export function mergeGuides(
  parts: MergePart[],
  options: MergeOptions,
): { guide: Guide; steps: GuideStep[]; media: MediaFrom[] } {
  const [first] = parts;
  const last = parts.at(-1);
  if (!first || !last) throw new Error("Nothing to merge.");
  const at = options.now.toISOString();
  const stamp = { at: options.now.getTime(), by: options.author };

  const media: MediaFrom[] = [];
  /** Source screenshot (library, guide, id) to its new id, so a shared one is copied once. */
  const copied = new Map<string, string>();
  const newMediaId = (part: MergePart, mediaId: string) => {
    const sourceKey = `${part.libraryId}\n${part.doc.guide.id}\n${mediaId}`;
    let id = copied.get(sourceKey);
    if (!id) {
      id = options.newId("image");
      copied.set(sourceKey, id);
      media.push({
        fromLibraryId: part.libraryId,
        fromGuideId: part.doc.guide.id,
        mediaId,
        newMediaId: id,
      });
    }
    return id;
  };
  const textBlock = (body: Guide["intro"]): GuideStep => ({
    ...blockStep(options.newId("block"), "text", stamp),
    block: { type: "text", heading: "", body },
  });

  const ordered: GuideStep[] = [];
  parts.forEach((part, index) => {
    const { guide, steps } = part.doc;
    if (options.headings)
      ordered.push({
        ...blockStep(options.newId("block"), "header", stamp),
        block: { type: "header", heading: guide.title, body: null },
      });
    if (index > 0 && guide.intro) ordered.push(textBlock(guide.intro));
    for (const step of steps)
      ordered.push({
        ...step,
        id: options.newId("step"),
        media: step.media?.id ? { ...step.media, id: newMediaId(part, step.media.id) } : step.media,
      });
    if (index < parts.length - 1 && guide.outro) ordered.push(textBlock(guide.outro));
  });
  const keys = spreadKeys(ordered.length);
  const steps = ordered.map((step, index) => ({ ...step, sortKey: keys[index] ?? step.sortKey }));

  const reviewDates = parts
    .map((part) => part.doc.guide.reviewBy)
    .filter((date): date is string => Boolean(date))
    .sort();
  const guide: Guide = {
    id: options.newId("guide"),
    title: options.title.trim(),
    description: first.doc.guide.description,
    intro: first.doc.guide.intro,
    outro: last.doc.guide.outro,
    brandProfileId: first.doc.guide.brandProfileId,
    tags: [...new Set(parts.flatMap((part) => part.doc.guide.tags))].slice(0, MAX_TAGS),
    owner: first.doc.guide.owner,
    reviewBy: reviewDates[0] ?? null,
    createdAt: at,
    createdBy: options.author,
    updatedAt: at,
    updatedBy: options.author,
    formatVersion: 1,
  };
  return { guide, steps, media };
}

let counter = 0;
/** Ids for a merge: the time and a counter, so many made in one go never clash. */
export const mergeId = (prefix: string) => {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}`;
};
