import type { BrandProfile, Finding, GuideStep } from "@amluto-steps/core";
import {
  cameraOf,
  renderStepImage,
  withCameraFrame,
  type BrandLook,
  type RenderedImage,
} from "@amluto-steps/export";

import { asRedactions, openFindings, type FoundInStep } from "../editor/suggestions";
import { screenWords, type TextReader } from "../screen-words";
import { lookFor } from "../settings/brands";
import type { FindingSettings } from "../settings/preferences";

export interface PreparationInput {
  loadImage: (mediaId: string) => Promise<string>;
  /** Reads the screenshots' words for the personal-data check; absent, none can be checked. */
  textReader: TextReader | undefined;
  /** The web page: plain pictures for its player, checked in its camera's view. */
  walkthrough: boolean;
  blurTerms: string[];
  findings: FindingSettings;
}

/** What the review shows of the export's pictures so far. */
export interface Prepared {
  /** Each step's picture as it will be exported, in the brand last prepared. */
  images: ReadonlyMap<string, RenderedImage>;
  /** The web page's pictures: blur and crop only, since its player draws the marks itself. */
  plainImages: ReadonlyMap<string, RenderedImage>;
  /** Possible personal data not yet blurred, per step checked. */
  findings: ReadonlyMap<string, Finding[]>;
  /** Steps whose words couldn't be read, so were never checked (never reported as clear). */
  unchecked: readonly string[];
  /** Steps whose screenshot couldn't be loaded or drawn: they export without a picture. */
  missing: readonly string[];
  /** How many screenshots have been tried in which brand (they're redrawn when it changes). */
  progress: { brandId: string; count: number };
}

export interface ExportPreparation {
  /** The latest state: a new value each time it changes, for `useSyncExternalStore`. */
  readonly state: Prepared;
  /** Hears each change to `state`; returns the way to stop hearing. */
  subscribe(listener: () => void): () => void;
  /**
   * A step as this format shows it: the web page's camera opens on a slightly wider view of a
   * smart-zoom crop, so its picture, and the check for personal data, cover that view.
   */
  shown(step: GuideStep): GuideStep;
  /**
   * Draws every screenshot in `brand`, four at a time. The first pass to finish also checks each
   * for personal data and lists the ones that couldn't be loaded; later passes only redraw.
   * Stops taking steps once `signal` aborts, and keeps nothing it draws after that.
   */
  prepare(steps: readonly GuideStep[], brand: BrandProfile, signal?: AbortSignal): Promise<void>;
  /**
   * One step drawn and checked again, after a quick fix or an undo. When its screenshot can't be
   * loaded now, the review keeps what it last showed: the step exports from the guide either way.
   */
  refresh(step: GuideStep, brand: BrandProfile): Promise<void>;
  /**
   * Blur all: every possible personal detail found goes to `blur` at once (made one edit there),
   * then those screenshots are drawn again with it. Nothing happens when nothing was found.
   */
  blurAll(
    steps: readonly GuideStep[],
    brand: BrandProfile,
    blur: (found: FoundInStep[]) => void,
  ): Promise<void>;
}

/** Loads each screenshot once, by media id; one that fails is tried again next time. */
function loadingOnce(load: (mediaId: string) => Promise<string>) {
  const loaded = new Map<string, Promise<string>>();
  return (mediaId: string) => {
    const known = loaded.get(mediaId);
    if (known) return known;
    const loading = load(mediaId);
    loaded.set(mediaId, loading);
    loading.catch(() => loaded.delete(mediaId));
    return loading;
  };
}

/** Four at a time (05/10/2026): reading a screenshot's text runs while the next is drawn. */
const AT_ONCE = 4;

/**
 * Preparing an export (docs/spec/05-export.md#review-before-export): every screenshot drawn as
 * it will be exported, its personal-data findings, and the steps unchecked or missing. Each
 * screenshot is loaded once for the review and its words read once, so a brand change redraws
 * without loading or reading again.
 */
export function exportPreparation(input: PreparationInput): ExportPreparation {
  const sourceOf = loadingOnce(input.loadImage);
  const words = screenWords(input.textReader, sourceOf);
  let state: Prepared = {
    images: new Map(),
    plainImages: new Map(),
    findings: new Map(),
    unchecked: [],
    missing: [],
    progress: { brandId: "", count: 0 },
  };
  const listeners = new Set<() => void>();
  const update = (change: (current: Prepared) => Partial<Prepared>) => {
    state = { ...state, ...change(state) };
    for (const listener of listeners) listener();
  };
  const shown = (step: GuideStep) => (input.walkthrough ? withCameraFrame(step) : step);
  /** Text recognition and the missing-picture check run once, not per brand. */
  let firstPassDone = false;

  /**
   * A step's personal-data check from its words: its findings, or "not checked" when its words
   * couldn't be read, so it's never reported as clear.
   */
  const check = async (step: GuideStep) => {
    const lines = await words.wordsOf(step);
    const unread = lines === "unavailable";
    update((current) => {
      const findings = new Map(current.findings);
      if (unread) findings.delete(step.id);
      else findings.set(step.id, openFindings(shown(step), lines, input.blurTerms, input.findings));
      return {
        findings,
        unchecked: unread
          ? current.unchecked.includes(step.id)
            ? current.unchecked
            : [...current.unchecked, step.id]
          : current.unchecked.filter((id) => id !== step.id),
      };
    });
  };

  /**
   * Drawing and checking one step, for every pass: its picture in `look`, the web page's plain
   * one when asked for, and its personal-data check when asked for. Throws when the screenshot
   * can't be loaded or drawn.
   */
  const drawAndCheck = async (
    step: GuideStep,
    look: BrandLook,
    also: { plain: boolean; check: boolean },
    keep: () => boolean = () => true,
  ) => {
    const source = await sourceOf(step.media?.id ?? "");
    const drawn = await renderStepImage(shown(step), source, look);
    if (keep()) update((current) => ({ images: new Map(current.images).set(step.id, drawn) }));
    if (also.plain && input.walkthrough) {
      const plain = {
        ...(await renderStepImage(shown(step), source, look, "image/webp", false)),
        camera: cameraOf(step),
      };
      update((current) => ({ plainImages: new Map(current.plainImages).set(step.id, plain) }));
    }
    if (also.check) await check(step);
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shown,
    async prepare(steps, brand, signal) {
      const look = lookFor(brand);
      const firstPass = !firstPassDone;
      const stopped = () => signal?.aborted === true;
      const queue = steps.filter((step) => step.kind === "interaction" && step.media?.id);
      let done = 0;
      const prepareNext = async (): Promise<void> => {
        const step = queue.shift();
        if (!step || stopped()) return;
        try {
          await drawAndCheck(step, look, { plain: firstPass, check: firstPass }, () => !stopped());
        } catch {
          // A missing screenshot (e.g. not synced yet) exports as a step without a picture; the
          // review lists it.
          if (firstPass) update((current) => ({ missing: [...current.missing, step.id] }));
        }
        if (stopped()) return;
        done += 1;
        update(() => ({ progress: { brandId: brand.id, count: done } }));
        await prepareNext();
      };
      await Promise.all(Array.from({ length: AT_ONCE }, () => prepareNext()));
      if (stopped()) return;
      // A guide with no screenshots (text blocks only) is ready at once; without this its Export
      // button never came on.
      update(() => ({ progress: { brandId: brand.id, count: done } }));
      firstPassDone = true;
    },
    async refresh(step, brand) {
      if (!step.media?.id) return;
      try {
        await drawAndCheck(step, lookFor(brand), { plain: true, check: true });
      } catch {
        // Kept as last shown; see above.
      }
    },
    async blurAll(steps, brand, blur) {
      const found = [...state.findings]
        .filter(([, items]) => items.length > 0)
        .map(([stepId, items]) => ({ stepId, findings: items }));
      if (found.length === 0) return;
      blur(found);
      // The blur covers what was found, so the words aren't read again to know it's clear.
      update((current) => {
        const findings = new Map(current.findings);
        for (const { stepId } of found) findings.set(stepId, []);
        return { findings };
      });
      const look = lookFor(brand);
      for (const { stepId, findings: items } of found) {
        const step = steps.find((item) => item.id === stepId);
        if (!step?.media?.id) continue;
        const blurred = { ...step, redactions: [...step.redactions, ...asRedactions(items)] };
        try {
          await drawAndCheck(blurred, look, { plain: true, check: false });
        } catch {
          // The blur is saved either way; the export draws every screenshot again from the guide.
        }
      }
    },
  };
}
