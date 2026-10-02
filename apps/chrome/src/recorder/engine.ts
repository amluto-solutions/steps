import {
  looksSensitive,
  siteExcluded,
  type OcrLine,
  type RecordingFact,
  type StepTarget,
} from "@amluto-steps/core";

import { newId } from "../library/ids";
import type { Journal } from "./journal";

/**
 * The Chrome edition's recorder (docs/spec/02-capture.md#chrome-edition), run by the extension's
 * background worker. Pages report what happened (`PagePointer`, `PageInput`); it takes the
 * screenshot, writes each fact to the journal and tells the open Steps pages. Its state is kept
 * in session storage, because Chrome stops an idle background worker and starts it again.
 */

export type RecorderState = "idle" | "recording" | "paused";

/** What the UI's recorder snapshot needs. */
export interface Snapshot {
  state: RecorderState;
  reason: string | null;
  sessionId: string | null;
  stepCount: number;
  missedCount: number;
  inputSource: "rawInput";
  keysRecorded: boolean;
}

interface Stored {
  state: RecorderState;
  sessionId: string | null;
  title: string;
  sequence: number;
  stepCount: number;
  keys: boolean;
  /** Screenshots at "Original" quality: lossless, at the tab's full size. */
  original: boolean;
  /** The last screenshot, reused for a click too soon after it for Chrome to take another. */
  last: { tabId: number; at: number; image: string; width: number; height: number } | null;
  /** The site each tab was last seen on, so only a change of site is a step. */
  origins: Record<string, string>;
  /** Sites never recorded: the person's and the organisation's (`siteName` host names). */
  excluded: string[];
  /** The organisation's extra field-name words whose values are never read. */
  sensitive: string[];
}

/** What a recording starts with, besides its title. */
export interface StartChoices {
  keys: boolean;
  excluded: string[];
  sensitive: string[];
  /** Settings > Recording, "Screenshot quality" is Original (and not locked). */
  original?: boolean;
}

const IDLE: Stored = {
  state: "idle",
  sessionId: null,
  title: "",
  sequence: 0,
  stepCount: 0,
  keys: false,
  original: false,
  last: null,
  origins: {},
  excluded: [],
  sensitive: [],
};

/** Chrome takes at most two screenshots a second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). */
export const CAPTURE_GAP_MS = 500;

export interface PageFacts {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  /** A frame's own address, when it happened in one: an excluded site stays so in a frame. */
  frameUrl?: string | undefined;
}

/** A pointer going down in a page: sent before the click has any effect. */
export interface PagePointer {
  target: StepTarget | null;
  /** Null for a click in a frame that couldn't be placed on the screenshot. */
  clickPct: { x: number; y: number } | null;
  elementPct: { x: number; y: number; w: number; h: number } | null;
  scale: number;
  /** The words on screen as the pointer went down, for blur suggestions (`capture/page-text`). */
  text?: OcrLine[];
  /** When the pointer went down (milliseconds since 1970), for Steps for Windows. */
  at?: number;
}

/** A field left after typing. `value` is null when the page withheld it as secret. */
export interface PageInput {
  target: StepTarget;
  value: string | null;
  sensitive: boolean;
}

/** What the engine needs from Chrome, so it can be tested without it. */
export interface EngineDeps {
  journal: Journal;
  load(): Promise<Stored | undefined>;
  save(state: Stored): Promise<void>;
  /**
   * The visible part of a window's active tab: a WebP within 2560 pixels, or lossless at full
   * size when `original`. Null when `tabId` isn't the active tab.
   */
  screenshot(
    windowId: number,
    tabId: number,
    original: boolean,
  ): Promise<{ image: Blob; width: number; height: number } | null>;
  /** Starts or stops the capture script in pages. */
  capturing(on: boolean): Promise<void>;
  /** Keeps the words a screenshot showed, found later by its bytes (`text-store.ts`). */
  keepText(image: Blob, lines: OcrLine[]): Promise<void>;
  broadcast(message: EngineEvent): void;
  author(): string;
  now(): number;
}

export type EngineEvent =
  | { type: "recorder:state"; snapshot: Snapshot }
  | { type: "recorder:fact"; fact: RecordingFact }
  | {
      type: "recorder:finished";
      finished: { sessionId: string; title: string; snapshot: Snapshot };
    };

/** A site as the step names it: its origin, never the path or anything after it. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * A page's title as a step keeps it. While a page loads, and on a page with no title, Chrome
 * shows its address as the title: that is replaced by the site's name, so no path or query
 * (which can hold ids and tokens) is ever kept.
 */
export function safeTitle(title: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return title.slice(0, 2000);
  }
  const bare = url.replace(/^[a-z]+:\/\//i, "");
  const trimmed = title.trim();
  if (trimmed === url || trimmed === bare || trimmed.startsWith(`${parsed.host}${parsed.pathname}`))
    return parsed.host;
  return title.slice(0, 2000);
}

/** Whether a page, or the frame in it where something happened, is on an excluded site. */
const excluded = (facts: PageFacts, sites: string[]) =>
  siteExcluded(facts.url, sites) ||
  (facts.frameUrl !== undefined && siteExcluded(facts.frameUrl, sites));

export function createEngine(deps: EngineDeps) {
  let stored: Stored | null = null;
  const current = async () => (stored ??= (await deps.load()) ?? { ...IDLE });
  // One change at a time: events from several tabs arrive together.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const commit = async (next: Stored) => {
    stored = next;
    await deps.save(next);
  };

  const snapshot = (value: Stored): Snapshot => ({
    state: value.state,
    reason: null,
    sessionId: value.sessionId,
    stepCount: value.stepCount,
    missedCount: 0,
    inputSource: "rawInput",
    keysRecorded: value.keys,
  });

  const announce = (value: Stored) =>
    deps.broadcast({ type: "recorder:state", snapshot: snapshot(value) });

  /** Writes a fact with the next sequence and tells the Steps pages. */
  const record = async (value: Stored, record: RecordingFact["record"], counts: boolean) => {
    const sequence = value.sequence + 1;
    const fact = {
      sessionId: value.sessionId as string,
      recordedAt: deps.now(),
      sequence,
      record,
    } as RecordingFact;
    await deps.journal.appendFact(fact);
    const next = { ...value, sequence, stepCount: value.stepCount + (counts ? 1 : 0) };
    await commit(next);
    deps.broadcast({ type: "recorder:fact", fact });
    announce(next);
  };

  const page = (facts: PageFacts) => ({
    tabId: facts.tabId,
    title: safeTitle(facts.title, facts.url),
    origin: originOf(facts.url),
  });

  return {
    getState: async () => snapshot(await current()),

    start: (title: string, { keys, excluded, sensitive, original = false }: StartChoices) =>
      serial(async () => {
        const value = await current();
        if (value.state !== "idle") return snapshot(value);
        const sessionId = newId();
        await deps.journal.startSession({
          sessionId,
          title,
          author: deps.author(),
          startedAt: deps.now(),
          stopped: false,
          restartAfter: null,
        });
        await deps.capturing(true);
        const next: Stored = {
          ...IDLE,
          state: "recording",
          sessionId,
          title,
          keys,
          original,
          excluded,
          sensitive,
        };
        await commit(next);
        announce(next);
        return snapshot(next);
      }),

    pause: () =>
      serial(async () => {
        const value = await current();
        if (value.state !== "recording") return snapshot(value);
        const next = { ...value, state: "paused" as const };
        await commit(next);
        announce(next);
        return snapshot(next);
      }),

    resume: () =>
      serial(async () => {
        const value = await current();
        if (value.state !== "paused") return snapshot(value);
        const next = { ...value, state: "recording" as const };
        await commit(next);
        announce(next);
        return snapshot(next);
      }),

    stop: () =>
      serial(async () => {
        const value = await current();
        if (value.state === "idle" || !value.sessionId) return snapshot(value);
        await deps.capturing(false);
        await deps.journal.updateSession(value.sessionId, { stopped: true });
        const finished = { sessionId: value.sessionId, title: value.title };
        const next: Stored = { ...IDLE, sessionId: value.sessionId };
        await commit(next);
        const done = snapshot(next);
        deps.broadcast({ type: "recorder:finished", finished: { ...finished, snapshot: done } });
        announce(next);
        return done;
      }),

    discard: () =>
      serial(async () => {
        const value = await current();
        if (value.state !== "idle") await deps.capturing(false);
        if (value.sessionId) await deps.journal.discard(value.sessionId);
        const next = { ...IDLE };
        await commit(next);
        announce(next);
        return snapshot(next);
      }),

    /** Stops recording a site from now on, in this recording (Settings keeps it for the next). */
    exclude: (site: string) =>
      serial(async () => {
        const value = await current();
        if (value.state === "idle" || value.excluded.includes(site)) return snapshot(value);
        const next = { ...value, excluded: [...value.excluded, site] };
        await commit(next);
        return snapshot(next);
      }),

    /** The session a stopped recording left, once it's saved or thrown away. */
    forgetSession: (sessionId: string) =>
      serial(async () => {
        const value = await current();
        if (value.state === "idle" && value.sessionId === sessionId) await commit({ ...IDLE });
      }),

    pointer: (facts: PageFacts, pointer: PagePointer) =>
      serial(async () => {
        const value = await current();
        if (value.state !== "recording" || !value.sessionId) return;
        // An excluded site: nothing about the click is kept, and no screenshot is taken.
        if (excluded(facts, value.excluded)) return;
        const now = deps.now();
        let shot = value.last;
        if (!shot || shot.tabId !== facts.tabId || now - shot.at >= CAPTURE_GAP_MS) {
          const taken = await deps.screenshot(facts.windowId, facts.tabId, value.original);
          // The tab was switched away from before the screenshot: the click is left out, as it
          // would be shown on another tab's picture.
          if (!taken) return;
          const name = `${newId()}.webp`;
          await deps.journal.putImage(
            value.sessionId,
            name,
            taken.image,
            taken.width,
            taken.height,
          );
          // Suggestions only: a screenshot is kept whether or not its words are.
          if (pointer.text?.length)
            await deps.keepText(taken.image, pointer.text).catch(() => undefined);
          shot = {
            tabId: facts.tabId,
            at: now,
            image: name,
            width: taken.width,
            height: taken.height,
          };
        }
        await record(
          { ...value, last: shot },
          {
            kind: "pageClick",
            id: value.sequence + 1,
            tickMs: now,
            page: page(facts),
            capture: {
              image: shot.image,
              width: shot.width,
              height: shot.height,
              scale: pointer.scale,
            },
            target: pointer.target,
            clickPct: pointer.clickPct,
            elementPct: pointer.elementPct,
          },
          true,
        );
      }),

    input: (facts: PageFacts, input: PageInput) =>
      serial(async () => {
        const value = await current();
        if (value.state !== "recording" || !value.sessionId) return;
        if (excluded(facts, value.excluded)) return;
        // A value is read only when asked for, and never from a secret field: the page checks
        // the built-in names, and the organisation's own are checked here.
        const target = input.target;
        const secret =
          input.sensitive ||
          (value.sensitive.length > 0 &&
            looksSensitive(
              [target.name, target.labelText, target.ariaLabel, target.placeholder].map(
                (text) => text ?? "",
              ),
              value.sensitive,
            ));
        const withheld = secret ? "sensitive" : value.keys ? null : "off";
        await record(
          value,
          {
            kind: "pageInput",
            tickMs: deps.now(),
            page: page(facts),
            target: input.target,
            value: withheld ? null : input.value,
            withheld,
          },
          true,
        );
      }),

    /** A tab's address changed: a step when it's a different site. */
    navigated: (facts: PageFacts) =>
      serial(async () => {
        const value = await current();
        const origin = originOf(facts.url);
        if (value.state !== "recording" || !value.sessionId || !origin) return;
        if (siteExcluded(facts.url, value.excluded)) return;
        const key = String(facts.tabId);
        if (value.origins[key] === origin) return;
        await record(
          { ...value, origins: { ...value.origins, [key]: origin } },
          { kind: "pageNavigation", tickMs: deps.now(), page: page(facts), origin },
          true,
        );
      }),
  };
}

export type Engine = ReturnType<typeof createEngine>;
