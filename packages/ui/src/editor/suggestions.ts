import { findSensitive, type Finding, type GuideStep, type OcrLine } from "@amluto-steps/core";
import type { TFunction } from "i18next";

import type { Change, Edit, EditorDoc } from "./document";
import type { Stamp } from "./edits";
import { readBlurStrength, readSafeTerms } from "../settings/preferences";

const TERMS_KEY = "amluto-steps-blur-terms";

/**
 * What a suggestion is, and why when a label said so: "name next to “Account owner”". A name or
 * an ID looks like any other word, so the reason is what makes the suggestion make sense.
 */
export const describeFinding = (finding: Finding, t: TFunction): string => {
  const kind = t(`findBlur.kinds.${finding.kind}`);
  return finding.label ? t("findBlur.nextTo", { kind, label: finding.label }) : kind;
};

/** Each different description once, in order, for a list like "name, email". */
export const describeFindings = (findings: Finding[], t: TFunction): string =>
  [...new Set(findings.map((finding) => describeFinding(finding, t)))].join(", ");

/** Settings → Privacy: words to suggest blurring in every screenshot (e.g. a client's name). */
export function readBlurTerms(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TERMS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(0, 200)
      : [];
  } catch {
    return [];
  }
}

export function saveBlurTerms(terms: string[]) {
  try {
    window.localStorage.setItem(TERMS_KEY, JSON.stringify(terms));
  } catch {
    // Kept for this session.
  }
}

/** A data URL's bytes, for sending a screenshot to OCR. */
export const dataUrlBytes = (dataUrl: string): Uint8Array => {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

type Rect = Finding["rect"];

const overlap = (a: Rect, b: Rect) => {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return width * height;
};

/** Whether a finding lies mostly in an area marked "Not personal" on its step. */
export const markedNotPersonal = (rect: Rect, areas: Rect[] | undefined): boolean =>
  rect.w > 0 &&
  rect.h > 0 &&
  (areas ?? []).some((area) => overlap(rect, area) >= 0.5 * rect.w * rect.h);

const inside = (x: number, y: number, rect: Rect) =>
  x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

/**
 * Whether blur areas cover every part of a rectangle. Checked on a grid of points rather than by
 * adding up areas, so two overlapping blurs can't add up to "covered" while leaving a gap.
 */
export function fullyCovered(rect: Rect, blurs: Rect[]): boolean {
  const columns = 12;
  const rows = 6;
  for (let column = 0; column <= columns; column += 1) {
    for (let row = 0; row <= rows; row += 1) {
      const x = rect.x + (rect.w * column) / columns;
      const y = rect.y + (rect.h * row) / rows;
      if (!blurs.some((blur) => inside(x, y, blur))) return false;
    }
  }
  return true;
}

/**
 * Personal data OCR found on a step's screenshot that isn't completely blurred and that is at
 * least partly inside the crop, if there is one. Half-blurred text still counts as open.
 */
/**
 * The person's own names (their Windows or Linux account, OneDrive accounts, and their name in
 * Settings), found as personal details at Standard and Thorough (F006). Set once the app has them.
 */
let people: string[] = [];
export const setPeopleNames = (names: string[]) => {
  people = names.filter((name) => name.trim().length >= 3);
};

export function openFindings(step: GuideStep, lines: OcrLine[], terms: string[]): Finding[] {
  const options = { strength: readBlurStrength(), people, safe: readSafeTerms() };
  return findSensitive(lines, terms, options).filter((finding) => {
    if (finding.rect.w <= 0 || finding.rect.h <= 0) return false;
    const visible = step.crop ? overlap(finding.rect, step.crop) > 0 : true;
    return (
      visible &&
      !fullyCovered(finding.rect, step.redactions) &&
      !markedNotPersonal(finding.rect, step.notPersonal)
    );
  });
}

/** Findings as blur areas, marked as suggested so the review can tell them apart. */
export const asRedactions = (findings: Finding[]): GuideStep["redactions"] =>
  findings.map((finding) => ({ ...finding.rect, source: "suggested" as const }));

/** Findings on one step. */
export interface FoundInStep {
  stepId: string;
  findings: Finding[];
}

/** An edit adding blur areas over findings on several steps, as one undo step. */
export const blurFoundEdit =
  (found: FoundInStep[], label: string) =>
  (current: EditorDoc, stamp: Stamp): Edit | null => {
    const changes: Change[] = found.flatMap(({ stepId, findings: items }) => {
      const before = current.steps.find((step) => step.id === stepId);
      if (!before || items.length === 0) return [];
      return [
        {
          kind: "step" as const,
          id: stepId,
          before,
          after: {
            ...before,
            redactions: [...before.redactions, ...asRedactions(items)],
            updatedAt: new Date(stamp.at).toISOString(),
            updatedBy: stamp.by,
          },
        },
      ];
    });
    return changes.length ? { label, changes, at: stamp.at } : null;
  };

/**
 * Marks findings on one step "Not personal", as one undo step: they aren't suggested again there,
 * in the editor or the export review. At most 200 areas a step; the oldest go first.
 */
export const notPersonalEdit =
  (stepId: string, found: Finding[], label: string) =>
  (current: EditorDoc, stamp: Stamp): Edit | null => {
    const before = current.steps.find((step) => step.id === stepId);
    if (!before || found.length === 0) return null;
    const areas = [
      ...(before.notPersonal ?? []),
      ...found.map(({ rect }) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })),
    ].slice(-200);
    return {
      label,
      changes: [
        {
          kind: "step",
          id: stepId,
          before,
          after: {
            ...before,
            notPersonal: areas,
            updatedAt: new Date(stamp.at).toISOString(),
            updatedBy: stamp.by,
          },
        },
      ],
      at: stamp.at,
    };
  };

/**
 * Every screenshot's open findings (Find & Blur with an empty box, and Blur all). Screenshots
 * OCR couldn't read are counted, so a search that read nothing never looks clean.
 */
export async function findOpenInGuide(
  steps: GuideStep[],
  linesFor: (step: GuideStep) => Promise<OcrLine[]>,
  terms: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ found: FoundInStep[]; unread: number }> {
  const withImages = steps.filter((step) => step.media?.id);
  const found: FoundInStep[] = [];
  let unread = 0;
  for (const [index, step] of withImages.entries()) {
    try {
      const findings = openFindings(step, await linesFor(step), terms);
      if (findings.length) found.push({ stepId: step.id, findings });
    } catch {
      unread += 1;
    }
    onProgress?.(index + 1, withImages.length);
  }
  return { found, unread };
}

export const findingKey = (stepId: string, finding: Finding) =>
  `${stepId}:${finding.kind}:${finding.rect.x}:${finding.rect.y}`;
