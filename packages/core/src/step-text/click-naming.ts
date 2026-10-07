// What a click is called (docs/spec/02-capture.md#click-naming): one module turns what the
// recorder found out about a click into its name, the kind of thing it is, where the name came
// from and whether someone should check it. A click step stores it, and its words, recorded or
// reworded into another language or tone, come from it alone (06/10/2026).

import type { OcrLine } from "../privacy.ts";
import { textAtPoint, type Box, type Point } from "../screen-text.ts";
import { phraseFor, taskbarAppName, TONES, type ElementKind, type Phrase } from "./phrase.ts";
import { PHRASEBOOKS } from "./phrasebooks/index.ts";
import type { StepTarget, UiaElementFacts } from "./types.ts";
import { promoteTextLeaf, readableFacts, uiaToStepTarget } from "./uia-adapter.ts";

/**
 * Where a click's name came from: the element itself, one of its parents, the page's own facts
 * (Steps for Chrome or Edge), the taskbar button's app, the words on the screenshot, or only the
 * window it was in.
 */
export const NAMING_SOURCES = [
  "element",
  "ancestor",
  "page",
  "taskbar",
  "screen",
  "window",
] as const;
export type NamingSource = (typeof NAMING_SOURCES)[number];

/** What a click is called. Stored on each click step as `naming`. */
export interface ClickNaming {
  /** The name quoted in the step; for a `window` naming the window's title, or "" for none. */
  name: string;
  kind: ElementKind;
  source: NamingSource;
  /** Flagged for review: nothing named the click itself, or the name may be misread. */
  needsReview: boolean;
}

/**
 * The words on a click's screenshot, where the click was on it (`x`, `y`), and the clicked
 * element's outline when the recorder had one (its own words or label come first).
 */
export interface ScreenEvidence extends Point {
  lines: OcrLine[];
  element?: Box | null | undefined;
}

/** What the recorder found out about a click. */
export interface ClickEvidence {
  /** The element under the click and its parents (`ancestors`), as UI Automation or AT-SPI saw them. */
  element: UiaElementFacts | null;
  /** The window clicked in; `shell` for the taskbar, Start or the desktop. */
  window: { title: string; exe: string | null; shell?: boolean | undefined };
  /** What Steps for Chrome or Edge said the element was, for a click in a web page. */
  page?: StepTarget | null | undefined;
  /**
   * The words on its screenshot, added when the draft opens: reading them during the recording
   * would slow every click.
   */
  screen?: ScreenEvidence | undefined;
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** A naming from the phrase the wording rules found for an element. */
const fromPhrase = (phrase: Phrase | undefined, source: NamingSource): ClickNaming | null =>
  phrase?.key === "click"
    ? { name: phrase.name, kind: phrase.kind, source, needsReview: false }
    : null;

/** A click named only by the window it was in, flagged for review. */
export const windowNaming = (title: string): ClickNaming => ({
  name: clean(title),
  kind: "other",
  source: "window",
  needsReview: true,
});

/**
 * A taskbar button: Windows' own shell (`explorer.exe`, not a File Explorer window), and a named
 * button, which is named after its app.
 */
const onTaskbar = ({ element, window }: ClickEvidence) =>
  window.shell === true &&
  window.exe?.toLowerCase() === "explorer.exe" &&
  element?.controlType === "Button" &&
  element.name.trim() !== "";

/** A name that only says something is loading: "Loading", "loading…". */
const LOADING_NAME = /^\s*loading[\s.…]*$/iu;
/** A loader's class (`sg-loader`, `page-loader`), not a word that merely contains it. */
const LOADER_CLASS = /(?:^|[^a-z])loader(?:$|[^a-z])/i;

/**
 * A loading overlay: what a page lays over itself while it loads, which a click lands on but isn't
 * about (05/10/2026: SiteGround's read `Click "loading"`). Named only "loading", a progress bar,
 * or with a loader's class; the page's facts are held to the same rule as UI Automation's.
 */
const isLoadingOverlay = ({ element, page }: ClickEvidence) =>
  (element !== null &&
    (LOADING_NAME.test(element.name) ||
      element.controlType === "ProgressBar" ||
      element.ariaRole === "progressbar" ||
      LOADER_CLASS.test(element.className))) ||
  (page != null &&
    (page.role === "progressbar" ||
      [page.ariaLabel, page.innerText, page.name].some(
        (name) => name !== undefined && LOADING_NAME.test(name),
      )));

/**
 * What a click is called, from its evidence. A loading overlay is never what was clicked, so a
 * click on one is named as if nothing named it. Otherwise, in order: what the page said the
 * element was; a taskbar button's app; the element, or the item up to four parents up that an
 * unnamed or text part of it belongs to; the screenshot's words at the click, flagged; else the
 * window, flagged.
 * A lookup that reached only the window itself is no control, and a framework's name for an
 * element is no name. The recorders only collect the evidence; every rule is here (06/10/2026).
 */
export function nameClick(evidence: ClickEvidence): ClickNaming {
  const { window, page } = evidence;
  if (isLoadingOverlay(evidence))
    return withScreenWords(windowNaming(window.title), evidence.screen);
  const fromPage = page ? fromPhrase(phraseFor("click", page), "page") : null;
  if (fromPage) return fromPage;
  const element = evidence.element && readableFacts(evidence.element);
  if (element && onTaskbar({ ...evidence, element }))
    return {
      name: taskbarAppName(element.name),
      kind: "button",
      source: "taskbar",
      needsReview: false,
    };
  if (element && element.controlType !== "Window") {
    // The promotion hands back the same facts when the element is named for itself.
    const promoted = promoteTextLeaf(element);
    const named = fromPhrase(
      phraseFor("click", uiaToStepTarget(element), null, null, promoted.controlType),
      promoted === element ? "element" : "ancestor",
    );
    if (named) return named;
  }
  return withScreenWords(windowNaming(window.title), evidence.screen);
}

/**
 * A naming with the screenshot's words applied. They name only a click nothing but its window
 * named, as "other" (words alone can't say what kind of thing they label), and the name is
 * flagged "check this name": text recognition misreads ("26holfor4noss"), and a misread name is
 * worse than none.
 */
export function withScreenWords(
  naming: ClickNaming,
  screen: ScreenEvidence | undefined,
): ClickNaming {
  if (naming.source !== "window" || !screen) return naming;
  const name = textAtPoint(screen.lines, screen.x, screen.y, screen.element);
  return name ? { name, kind: "other", source: "screen", needsReview: true } : naming;
}

/** What a stored click step keeps that its naming can be worked out from. */
export interface StoredClick {
  actionText: string;
  textParts: { target: string; kind: string };
  context: { windowTitle: string };
  target: unknown;
  naming?: ClickNaming | undefined;
}

/** A stored `target` that can be read as the element's facts. */
export const isTarget = (value: unknown): value is StepTarget =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every way a taskbar click has been worded: each language's template in each tone, with any
 * name in its slot. An older step was recorded in whichever its guide used (07/10/2026: only the
 * English casual words were recognised, so a formal or German one lost its taskbar wording).
 */
const TASKBAR_WORDINGS: readonly RegExp[] = Object.values(PHRASEBOOKS).flatMap((phrases) =>
  phrases
    ? TONES.map(
        (tone) =>
          new RegExp(
            `^${escapeRegExp(phrases[tone].clickTaskbar).replace(escapeRegExp("{name}"), ".+")}$`,
            "su",
          ),
      )
    : [],
);

const wordedAsTaskbar = (text: string) =>
  TASKBAR_WORDINGS.some((pattern) => pattern.test(text.trim()));

/**
 * A stored click's naming: the one it was recorded with, or, for a step saved before steps kept
 * it (1.0.0), worked out from what it does keep, which words it exactly as it was recorded. An
 * older step can't say a name came from a parent; it reads as the element's own.
 */
export function namingOfStep(step: StoredClick): ClickNaming {
  if (step.naming) return step.naming;
  const parts = step.textParts;
  const title = step.context.windowTitle;
  // Older recordings didn't mark a taskbar click, but its words did, in any language and tone.
  if (parts.kind === "taskbar" || wordedAsTaskbar(step.actionText))
    return {
      name: taskbarAppName(parts.target),
      kind: "button",
      source: "taskbar",
      needsReview: false,
    };
  // A click that only reached the window is named by the window, not as if it were a control.
  if (parts.kind === "window") return windowNaming(title);
  const target = isTarget(step.target) ? step.target : null;
  return (
    fromPhrase(phraseFor("click", target, null, null, parts.kind), "element") ?? windowNaming(title)
  );
}

/** The phrase a naming is worded by (a left click; `asRightClick` makes it a right one). */
export function clickPhrase(naming: ClickNaming): Phrase {
  switch (naming.source) {
    case "taskbar":
      return { key: "clickTaskbar", name: naming.name };
    case "window":
      return naming.name ? { key: "clickIn", title: naming.name } : { key: "clickBare" };
    default:
      return { key: "click", kind: naming.kind, name: naming.name };
  }
}
