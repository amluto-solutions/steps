// What a click is called (docs/spec/02-capture.md#click-naming): one module turns what the
// recorder found out about a click into its name, the kind of thing it is, where the name came
// from and whether someone should check it. A click step stores it, and its words, recorded or
// reworded into another language or tone, come from it alone (06/10/2026).

import { KEY_NAMES } from "../key-names.ts";
import type { OcrLine } from "../privacy.ts";
import { textAtPoint, type Box, type Point } from "../screen-text.ts";
import { phraseFor, taskbarAppName, TONES, type ElementKind, type Phrase } from "./phrase.ts";
import { PHRASEBOOKS } from "./phrasebooks/index.ts";
import type { StepTarget, UiaElementFacts } from "./types.ts";
import {
  isFrameworkName,
  isWord,
  isWordBody,
  promoteTextLeaf,
  readableFacts,
  uiaToStepTarget,
  WORD_BODY_CLASS,
} from "./uia-adapter.ts";

/**
 * Where a click's name came from: the element itself, one of its parents, the page's own facts
 * (Steps for Chrome or Edge), the taskbar button's app, a title-bar button's window, the words on
 * the screenshot, a menu's item those words picked out (its name as UI Automation read it when
 * the menu opened), or only the window it was in.
 */
export const NAMING_SOURCES = [
  "element",
  "ancestor",
  "page",
  "taskbar",
  "titleBar",
  "screen",
  "menu",
  "window",
] as const;
export type NamingSource = (typeof NAMING_SOURCES)[number];

/**
 * A window's own title-bar buttons, as the Windows recorder tells them from the window's hit test
 * as the button went down, before the window reacts (12/10/2026, #48). Maximise on a window that's
 * already maximised is Restore.
 */
export const TITLE_BAR_BUTTONS = ["close", "minimise", "maximise", "restore"] as const;
export type TitleBarButton = (typeof TITLE_BAR_BUTTONS)[number];

const TITLE_BAR_KINDS: Record<TitleBarButton, ElementKind> = {
  close: "closeButton",
  minimise: "minimiseButton",
  maximise: "maximiseButton",
  restore: "restoreButton",
};

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
 * One of the items UI Automation read in a menu as it opened (12/10/2026, #56): its name, and its
 * box on the click's screenshot, in percentages of it, when it had one.
 */
export interface MenuItem {
  name: string;
  box: Box | null;
}

/**
 * The words on a click's screenshot, where the click was on it (`x`, `y`), and the clicked
 * element's outline when the recorder had one (its own words or label come first).
 */
export interface ScreenEvidence extends Point {
  lines: OcrLine[];
  element?: Box | null | undefined;
  /**
   * The items of the menu the click landed in, as UI Automation read them when it opened; a name
   * read from the screenshot is matched against them.
   */
  menuItems?: readonly MenuItem[] | undefined;
  /**
   * The menu `menuItems` are from was still showing as the button went down: it was read in a
   * window of its own (a pop-up), and that window was under the pointer then (#106). The item
   * whose box holds the click is then the one clicked, with or without words to say so.
   */
  menuShowing?: boolean | undefined;
  /**
   * The window clicked had gone from the click before the screenshot was taken (it closed, as a
   * dialog's OK closes it): the picture shows what was behind it there, so its words never name
   * the click (F019, #48).
   */
  windowGone?: boolean | undefined;
}

/** The window a click was in, as the recorder read it as the button went down. */
export interface ClickWindow {
  title: string;
  exe: string | null;
  shell?: boolean | undefined;
  hostedExe?: string | null | undefined;
  /**
   * For a pop-up (a top-level window without a title bar of Windows': a menu, a drop-down list),
   * the title of the window it came from, "" when that has none; absent for any other window, a
   * pop-up of the Windows shell's, and in recordings made before #106.
   */
  ownerTitle?: string | null | undefined;
}

/** What the recorder found out about a click. */
export interface ClickEvidence {
  /** The element under the click and its parents (`ancestors`), as UI Automation or AT-SPI saw them. */
  element: UiaElementFacts | null;
  /**
   * The window clicked in; `shell` for the taskbar, Start or the desktop; `hostedExe` for a frame
   * Windows draws round another program's window, that program (#109); `ownerTitle` for a pop-up
   * (a menu, a drop-down list), the title of the window it came from (#106).
   */
  window: ClickWindow;
  /** What Steps for Chrome or Edge said the element was, for a click in a web page. */
  page?: StepTarget | null | undefined;
  /**
   * The words on its screenshot, added when the draft opens: reading them during the recording
   * would slow every click.
   */
  screen?: ScreenEvidence | undefined;
  /** The window's own title-bar button the click was on, when Windows' hit test told it. */
  titleBarButton?: TitleBarButton | undefined;
  /**
   * The press was on the filter drop-down of the spreadsheet header clicked (12/10/2026, #70): the
   * Windows recorder tells it from the cell's box when the cell says it has one (`filterHeader`).
   */
  filterButton?: boolean | undefined;
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** A naming from the phrase the wording rules found for an element. */
const fromPhrase = (phrase: Phrase | undefined, source: NamingSource): ClickNaming | null =>
  phrase?.key === "click"
    ? { name: phrase.name, kind: phrase.kind, source, needsReview: false }
    : null;

const TRAILING_ELLIPSIS = /\s*(?:…|\.{3,})\s*$/u;

/**
 * A name without its trailing ellipsis ("Format Cells…", "Save As..."): on screen it says the item
 * opens a dialog, and a guide tells the reader what to click (12/10/2026, #56). A name that is
 * nothing but dots (a browse button's "...") keeps them.
 */
export const withoutEllipsis = (name: string): string => {
  const cut = name.replace(TRAILING_ELLIPSIS, "");
  return /[\p{L}\p{N}]/u.test(cut) ? cut : name;
};

/** Modifier keys as keyboards in any language print them ("Strg", "Maj"), and other spellings. */
const MODIFIER_NAMES = [
  ...new Set([
    ...["Ctrl", "Control", "Alt", "AltGr", "Shift", "Win", "Windows", "Cmd", "Command", "Option"],
    ...Object.values(KEY_NAMES).flatMap((names) =>
      ["Ctrl", "Alt", "AltGr", "Shift", "Win"].flatMap((key) => names?.[key] ?? []),
    ),
  ]),
].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/**
 * "(Ctrl+B)", "(Ctrl + Shift + S)", "(Strg+B)" at the end of a name, in either kind of bracket.
 * Keys joined by "+" only: "(Alt-Text)" is a name.
 */
const TRAILING_SHORTCUT = new RegExp(
  `\\s*[(（]\\s*(?:(?:${MODIFIER_NAMES.join("|")})\\s*\\+\\s*)+[^\\s()（）+][^()（）+]{0,15}?\\s*[)）]\\s*$`,
  "iu",
);

/**
 * A name without the shortcut a tooltip adds after it ("Bold (Ctrl+B)"): the step says what to
 * click, and a reader looks for "Bold" (12/10/2026, #71: Notepad's Bold button read
 * `Click "Bold (Ctrl+B)"`). Only a bracket holding a modifier and a key, in any language's
 * keyboard names, so "Inbox (3)" keeps its count; a name that is nothing but a shortcut keeps it.
 */
export const withoutShortcut = (name: string): string => {
  const cut = name.replace(TRAILING_SHORTCUT, "");
  return /[\p{L}\p{N}]/u.test(cut) ? cut : name;
};

/** A click's name without what's on screen only to help: a tooltip's shortcut, an ellipsis. */
export const tidyName = (name: string): string => withoutEllipsis(withoutShortcut(name));

const tidied = (naming: ClickNaming | null): ClickNaming | null =>
  naming && { ...naming, name: tidyName(naming.name) };

/**
 * The title a click named by its window quotes: for a pop-up, the title of the window it came
 * from; otherwise, or when that has none, the window's own (#106: a quick click in Paint's File
 * menu read `Click in "Pop-upHost"`). A pop-up has no title bar, so its own title isn't on screen,
 * and WinUI's pop-up host is titled in Windows' language ("PopupHost", en-GB "Pop-upHost", fr-FR
 * "Hôte contextuel"), so it can't be told by its words. A framework's name is never one: with no
 * window it came from, such a click is named by no title.
 */
export const windowTitleOf = (window: ClickWindow): string =>
  clean(window.ownerTitle ?? "") || titleUnlessFramework(window.title);

/** A window's title, or "" for a UI framework's name standing in for one. */
const titleUnlessFramework = (title: string) => (isFrameworkName(title, "") ? "" : clean(title));

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

/**
 * A click on a spreadsheet header's filter drop-down, named by the header's words, or its cell
 * when it has none (12/10/2026, #70). Excel draws the drop-down inside the header cell, so UI
 * Automation finds the cell there: read as the cell, the step read `Click "Item"` and a reader
 * clicked the cell, which opens nothing.
 */
const filterNaming = ({ element, filterButton }: ClickEvidence): ClickNaming | null => {
  if (filterButton !== true || element?.filterHeader === undefined) return null;
  const name = clean(element.filterHeader) || clean(element.name);
  return name ? { name, kind: "filterButton", source: "element", needsReview: false } : null;
};

/** What a document's text is made of to UI Automation: its pages, their parts, the body itself. */
const DOCUMENT_PARTS = new Set(["Custom", "Group", "Pane", "Text", "Document"]);

/** A click in a document's text, named by no part of it. */
export const DOCUMENT_NAMING: ClickNaming = {
  name: "",
  kind: "document",
  source: "element",
  needsReview: false,
};

/**
 * A click in Word's document text (#74): on the body itself, or on a part of it whose parents
 * stop at the body (a page). Word names a page "Page 1", so the click read `Click "Page 1"`, which
 * a reader can't find; what matters is where in the document, which the screenshot shows. A
 * link, a picture or a box in the text is clicked by its own name.
 */
const inWordDocument = (element: UiaElementFacts, exe: string | null) =>
  isWordBody(element, exe) ||
  (isWord(exe) &&
    element.documentClass === WORD_BODY_CLASS &&
    DOCUMENT_PARTS.has(element.controlType) &&
    element.ancestors.every((ancestor) => DOCUMENT_PARTS.has(ancestor.controlType)));

/**
 * The programs that draw Windows' input panels: the text input host draws the emoji panel
 * (Win+.), clipboard history (Win+V), the touch keyboard and the voice typing panel (Win+H), and
 * their windows can't be told apart. The Windows recorder knows it by the same name
 * (`crates/capture/src/dictation.rs`); `test-vectors/click-naming.json` holds both to it.
 */
export const INPUT_PANEL_PROGRAMS: readonly string[] = ["TextInputHost.exe"];

/**
 * Whether a window is one of Windows' input panels, by its program (in any case): its own window,
 * or a frame showing it. Windows 11 shows the emoji panel in a frame of `explorer.exe`'s round the
 * text input host's window (build 26300, 12/10/2026), which the recorder says as `hostedExe`.
 */
export const isInputPanel = (window: {
  exe: string | null;
  hostedExe?: string | null | undefined;
}): boolean =>
  [window.exe, window.hostedExe].some((exe) =>
    INPUT_PANEL_PROGRAMS.some((program) => program.toLowerCase() === exe?.toLowerCase()),
  );

/**
 * A click in Windows' input panel (#109): nothing in it is named, by the element, its parents or
 * the screenshot's words, since a clipboard history item can be named after the text it holds and
 * the clipboard is never read (04/10/2026). Flagged, so the person can say what was picked.
 */
export const INPUT_PANEL_NAMING: ClickNaming = {
  name: "",
  kind: "inputPanel",
  source: "window",
  needsReview: true,
};

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
 * What a click is called, from its evidence. A click in Windows' input panel is named by nothing
 * in it (#109). A window's title-bar button, then a spreadsheet header's filter drop-down, come
 * next. A loading overlay is never what was clicked, so a click on one is named as if nothing
 * named it. Otherwise, in order: what the page said the
 * element was; a taskbar button's app; a place in Word's document text, which no part of it
 * names (#74); the element, or the item up to four parents up that an
 * unnamed or text part of it belongs to; the screenshot's words at the click, flagged; else the
 * window, flagged (for a pop-up, the window it came from, #106).
 * A lookup that reached only the window itself is no control, and a framework's name for an
 * element or a window is no name. The recorders only collect the evidence; every rule is here (06/10/2026).
 */
export function nameClick(evidence: ClickEvidence): ClickNaming {
  const { window, page, titleBarButton } = evidence;
  // Before anything the click's evidence holds: in the input panel, that is clipboard text.
  if (isInputPanel(window)) return INPUT_PANEL_NAMING;
  // Told before the window reacted, so it holds even when the click closed the window. A window
  // with no title has nothing to name its button by.
  if (titleBarButton && clean(window.title))
    return {
      name: clean(window.title),
      kind: TITLE_BAR_KINDS[titleBarButton],
      source: "titleBar",
      needsReview: false,
    };
  const filter = filterNaming(evidence);
  if (filter) return filter;
  if (isLoadingOverlay(evidence))
    return withScreenWords(windowNaming(windowTitleOf(window)), evidence.screen);
  const fromPage = page ? tidied(fromPhrase(phraseFor("click", page), "page")) : null;
  if (fromPage) return fromPage;
  const element = evidence.element && readableFacts(evidence.element);
  if (element && onTaskbar({ ...evidence, element }))
    return {
      name: taskbarAppName(element.name),
      kind: "button",
      source: "taskbar",
      needsReview: false,
    };
  if (element && inWordDocument(element, window.exe)) return DOCUMENT_NAMING;
  if (element && element.controlType !== "Window") {
    // The promotion hands back the same facts when the element is named for itself.
    const promoted = promoteTextLeaf(element);
    const named = tidied(
      fromPhrase(
        phraseFor("click", uiaToStepTarget(element), null, null, promoted.controlType),
        promoted === element ? "element" : "ancestor",
      ),
    );
    if (named) return named;
  }
  return withScreenWords(windowNaming(windowTitleOf(window)), evidence.screen);
}

/**
 * A naming with the screenshot's words applied. They name only a click nothing but its window
 * named, as "other" (words alone can't say what kind of thing they label), and the name is
 * flagged "check this name": text recognition misreads ("26holfor4noss"), and a misread name is
 * worse than none. A screenshot taken after the window clicked had gone shows another window at
 * the click, and names nothing.
 *
 * On a menu whose items UI Automation read as it opened, the words pick out the item they are
 * (`menuItemFor`), and the click takes that item's own name: a menu item, needing no check
 * (12/10/2026, #56: "Format Cells…" had been read "Eormat Cells...", "Save as" "Sav"). Words like
 * none of them stand, flagged as before. With no words to go by (none at the click, or a window
 * gone by the screenshot, as a menu closed by the click is), a menu still showing as the button
 * went down names the click by the one item whose box holds it (#106: Save clicked at once in
 * Paint's WinUI File menu, which had gone by the screenshot).
 */
export function withScreenWords(
  naming: ClickNaming,
  screen: ScreenEvidence | undefined,
): ClickNaming {
  if (naming.source !== "window" || naming.kind === "inputPanel" || !screen) return naming;
  const read =
    screen.windowGone === true
      ? null
      : textAtPoint(screen.lines, screen.x, screen.y, screen.element);
  if (!read) {
    const under = screen.menuShowing === true ? itemUnder(screen.menuItems ?? [], screen) : null;
    return under ? menuNaming(under) : naming;
  }
  const item = screen.menuItems ? menuItemFor(read, screen.menuItems, screen) : null;
  return item
    ? menuNaming(item)
    : { name: tidyName(read), kind: "other", source: "screen", needsReview: true };
}

/** A click named by a menu's item: the app's own name for it, needing no check (#56). */
const menuNaming = (item: MenuItem): ClickNaming => ({
  name: tidyName(itemName(item)),
  kind: "menuItem",
  source: "menu",
  needsReview: false,
});

/** The one named item whose box holds a point, or null for none or several. */
const itemUnder = (items: readonly MenuItem[], at: Point): MenuItem | null => {
  const under = items.filter((item) => item.box && holds(item.box, at) && itemName(item) !== "");
  return under.length === 1 ? (under[0] ?? null) : null;
};

/** A name without a shortcut after a tab ("Save\tCtrl+S"), as a menu can give its items'. */
const beforeTab = (name: string) => clean(name.split("\t")[0] ?? "");

/** A menu item's name as a step quotes it. */
const itemName = (item: MenuItem) => beforeTab(item.name);

/** A name as menu matching compares it: no ellipsis, case, access-key marks or extra spaces. */
const matchKey = (name: string) =>
  tidyName(beforeTab(name))
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/&/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The fewest letters a read name needs before a misread one, or one cut short, is matched. */
const MIN_FUZZY = 3;

/**
 * How many edits turn `read` into `item`, or into the start of it when `read` is long enough to
 * have been cut short ("sav" is no edits from "save as"): text recognition drops a word's end
 * where the highlight or a submenu's arrow crosses it.
 */
function editsTo(read: string, item: string): number {
  const readChars = [...read];
  const itemChars = [...item];
  let row = Array.from({ length: itemChars.length + 1 }, (_, index) => index);
  readChars.forEach((char, i) => {
    const next = [i + 1];
    itemChars.forEach((other, j) => {
      next.push(
        Math.min(
          (row[j + 1] ?? 0) + 1,
          (next[j] ?? 0) + 1,
          (row[j] ?? 0) + (char === other ? 0 : 1),
        ),
      );
    });
    row = next;
  });
  const whole = row[itemChars.length] ?? Number.POSITIVE_INFINITY;
  return readChars.length >= MIN_FUZZY ? Math.min(whole, ...row) : whole;
}

/** The edits a read name may be from an item and still be it: one in four letters, at least one. */
const allowedEdits = (read: string) =>
  [...read].length < MIN_FUZZY ? 0 : Math.max(1, Math.floor([...read].length / 4));

const holds = (box: Box, { x, y }: Point) =>
  x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;

/**
 * The menu item a name read from the screenshot at a click is, from the items UI Automation read
 * when the menu opened (12/10/2026, #56): one within a few edits of the words, or one they start.
 * When the click is in exactly one item's box, it's that item or none, since words close to
 * another item aren't what was clicked ("Sav" is the "Save as" clicked, not "Save" above it);
 * otherwise the closest item, if only one is closest. Null when none is close enough.
 */
export function menuItemFor(read: string, items: readonly MenuItem[], at: Point): MenuItem | null {
  const key = matchKey(read);
  if (!key) return null;
  const allowed = allowedEdits(key);
  const close = items
    .map((item) => ({ item, key: matchKey(item.name) }))
    .filter((entry) => entry.key !== "")
    .map((entry) => ({ ...entry, edits: editsTo(key, entry.key) }))
    .filter((entry) => entry.edits <= allowed);
  const under = items.filter((item) => item.box && holds(item.box, at));
  if (under.length === 1) return close.find((entry) => entry.item === under[0])?.item ?? null;
  const fewest = Math.min(...close.map((entry) => entry.edits));
  const closest = close.filter((entry) => entry.edits === fewest);
  // The same name twice (an item and a submenu's) is still one answer.
  return new Set(closest.map((entry) => entry.key)).size === 1 ? (closest[0]?.item ?? null) : null;
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
  // A window's title-bar button is marked by its kind, with the window's title as its target.
  const titleBarKind = Object.values(TITLE_BAR_KINDS).find((kind) => kind === parts.kind);
  if (titleBarKind && parts.target.trim())
    return { name: parts.target, kind: titleBarKind, source: "titleBar", needsReview: false };
  // So is a spreadsheet header's filter drop-down, with the header as its target (#70).
  if (parts.kind === "filterButton" && parts.target.trim())
    return { name: parts.target, kind: "filterButton", source: "element", needsReview: false };
  // So is a click in a document's text (#74), and one in Windows' input panel (#109).
  if (parts.kind === "document") return DOCUMENT_NAMING;
  if (parts.kind === "inputPanel") return INPUT_PANEL_NAMING;
  // A click that only reached the window is named by the window, not as if it were a control.
  if (parts.kind === "window") return windowNaming(storedWindowTitle(title, parts.target));
  const target = isTarget(step.target) ? step.target : null;
  return (
    fromPhrase(phraseFor("click", target, null, null, parts.kind), "element") ??
    windowNaming(storedWindowTitle(title, parts.target))
  );
}

/**
 * The title an older click named by its window quotes: its window's, as recorded, unless that's
 * none or a framework's ("Pop-upHost"), when the step's target holds the title it was named by:
 * the window a pop-up came from (#106). Before, the target was that same title (a step named
 * `Click in "Pop-upHost"` keeps its words), or no title.
 */
const storedWindowTitle = (title: string, target: string) =>
  titleUnlessFramework(title) || clean(target);

/** The phrase a naming is worded by (a left click; `asRightClick` makes it a right one). */
export function clickPhrase(naming: ClickNaming): Phrase {
  switch (naming.source) {
    case "taskbar":
      return { key: "clickTaskbar", name: naming.name };
    case "window":
      if (naming.kind === "inputPanel") return { key: "clickInInputPanel" };
      return naming.name ? { key: "clickIn", title: naming.name } : { key: "clickBare" };
    default:
      return naming.kind === "document"
        ? { key: "clickInDocument" }
        : { key: "click", kind: naming.kind, name: naming.name };
  }
}
