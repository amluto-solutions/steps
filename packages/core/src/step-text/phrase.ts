import type { CodeLanguage } from "../code.ts";
import { localKeys } from "../key-names.ts";
import { DEFAULT_LANGUAGE } from "../languages.ts";
import { PHRASEBOOKS } from "./phrasebooks/index.ts";
import type { StepAction, StepTarget } from "./types.ts";

/**
 * What a step says, apart from the words it's said in (docs/spec/02-capture.md#step-wording):
 * "a click on the button named Save". A phrasebook per language and tone turns it into words
 * (`renderPhrase`), so the same step reads `Click "Save"`, `Select the "Save" button` or
 * `Klicken Sie auf die Schaltfläche „Speichern“.`, and a guide can be reworded into another tone or
 * language from what was recorded, without retyping anything (01/10/2026).
 */

/** How steps are worded: today's short style, plain language, or full formal sentences. */
export const TONES = ["casual", "plain", "formal"] as const;
export type Tone = (typeof TONES)[number];
export const DEFAULT_TONE: Tone = "casual";
export const isTone = (value: unknown): value is Tone =>
  typeof value === "string" && (TONES as readonly string[]).includes(value);

/** The language and tone steps are worded in. */
export interface StepWording {
  language: string;
  tone: Tone;
}

/** How steps were always worded: English, casual. */
export const ENGLISH: StepWording = { language: DEFAULT_LANGUAGE, tone: DEFAULT_TONE };

/**
 * What kind of thing was clicked, for the tones that name it ("the Save button"). `field` is a
 * box named by its label (worded "… field" even in the casual tone); `namedField` one named by an
 * explicit accessible name, which the casual tone words as a plain name.
 */
export type ElementKind =
  | "button"
  | "link"
  | "menuItem"
  | "tab"
  | "field"
  | "namedField"
  | "textArea"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "switch"
  | "picture"
  | "listItem"
  | "other";

/** The terminals a command's wording names; other languages run "in the terminal". */
export type Terminal = "powershell" | "cmd" | "bash";

export type Phrase =
  | { key: "click"; kind: ElementKind; name: string }
  | { key: "clickIn"; title: string }
  | { key: "clickBare" }
  | { key: "clickTaskbar"; name: string }
  | { key: "rightClick"; name: string }
  | { key: "rightClickIn"; title: string }
  | { key: "rightClickBare" }
  | { key: "selectRange"; range: string }
  | { key: "typeValueInField"; value: string; field: string }
  | { key: "typeInField"; field: string }
  | { key: "chooseValueIn"; value: string; field: string }
  | { key: "chooseIn"; field: string }
  | { key: "typeValue"; value: string }
  | { key: "type" }
  | { key: "typeValueInCell"; value: string; cell: string }
  | { key: "typeInCell"; cell: string }
  | { key: "press"; keys: string }
  | { key: "goTo"; site: string }
  | { key: "open"; app: string }
  | { key: "runIn"; terminal: Terminal | null }
  | { key: "formulaInCell"; cell: string }
  | { key: "formulaInSelected" }
  | { key: "code" }
  | { key: "missed"; count: number }
  | { key: "touch"; count: number }
  | { key: "captureNow" };

/** One form per plural category the language has (Intl.PluralRules); `other` always. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/**
 * One tone's words in one language. Templates hold their own quotation marks, so each language
 * uses its own („…“, «…», 「…」); `{name}`, `{value}`, `{field}`, `{title}`, `{site}`, `{app}`,
 * `{keys}`, `{cell}`, `{where}` and `{count}` are filled in.
 */
export interface Phrasebook {
  /** A click on something named, by kind; `other` for anything without its own. */
  click: Partial<Record<ElementKind, string>> & { other: string };
  clickIn: string;
  clickBare: string;
  clickTaskbar: string;
  /** A right-click (04/10/2026): on something named, in a window, or neither. */
  rightClick: string;
  rightClickIn: string;
  rightClickBare: string;
  /** Cells selected by dragging: `{range}` is "D38:F42" (04/10/2026). */
  selectRange: string;
  typeValueInField: string;
  typeInField: string;
  /** A choice made in a drop-down list by typing: `{value}`, `{field}` (F010). */
  chooseValueIn: string;
  /** `{field}` */
  chooseIn: string;
  typeValue: string;
  type: string;
  typeValueInCell: string;
  typeInCell: string;
  press: string;
  goTo: string;
  open: string;
  runIn: string;
  runInTerminal: string;
  formulaInCell: string;
  formulaInSelected: string;
  code: string;
  missed: PluralForms;
  touch: PluralForms;
  captureNow: string;
}

export interface LanguagePhrases {
  casual: Phrasebook;
  plain: Phrasebook;
  formal: Phrasebook;
  /** The terminals' names in this language, where they have one ("Eingabeaufforderung"). */
  terminals: Record<Terminal, string>;
}

/** Kinds worded like another when a language has no words of their own for them. */
const KIND_FALLBACK: Partial<Record<ElementKind, ElementKind>> = {
  namedField: "field",
  textArea: "field",
  listItem: "other",
  menuItem: "other",
};

/** The longest name or value quoted in full; longer ones are cut and end in "...". */
export const QUOTE_LIMIT = 80;

export function shorten(text: string, limit = QUOTE_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}...`;
}

/** Fills `{slot}`s in one pass, so a name with braces in it is never filled in again. */
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (whole, slot: string) => values[slot] ?? whole);

const phrasesFor = (language: string): LanguagePhrases =>
  PHRASEBOOKS[language] ?? PHRASEBOOKS[DEFAULT_LANGUAGE] ?? fail(language);

function fail(language: string): never {
  throw new Error(`No phrasebook for ${language} or English.`);
}

const plural = (forms: PluralForms, count: number, language: string) => {
  let category: Intl.LDMLPluralRule = "other";
  try {
    category = new Intl.PluralRules(language).select(count);
  } catch {
    // An engine without this language's rules uses the general form.
  }
  return fill(forms[category] ?? forms.other, { count: String(count) });
};

/** A phrase in words, in `language` (English when Steps hasn't got it) and `tone`. */
export function renderPhrase(phrase: Phrase, language: string, tone: Tone): string {
  const phrases = phrasesFor(language);
  const book = phrases[tone];
  switch (phrase.key) {
    case "click": {
      let kind: ElementKind | undefined = phrase.kind;
      let template = book.click[kind];
      while (template === undefined && kind) {
        kind = KIND_FALLBACK[kind];
        template = kind ? book.click[kind] : undefined;
      }
      return fill(template ?? book.click.other, { name: shorten(phrase.name) });
    }
    case "clickIn":
      return fill(book.clickIn, { title: phrase.title });
    case "clickBare":
      return book.clickBare;
    case "clickTaskbar":
      return fill(book.clickTaskbar, { name: phrase.name });
    case "rightClick":
      return fill(book.rightClick, { name: shorten(phrase.name) });
    case "rightClickIn":
      return fill(book.rightClickIn, { title: phrase.title });
    case "rightClickBare":
      return book.rightClickBare;
    case "selectRange":
      return fill(book.selectRange, { range: phrase.range });
    case "typeValueInField":
      return fill(book.typeValueInField, {
        value: shorten(phrase.value),
        field: shorten(phrase.field),
      });
    case "typeInField":
      return fill(book.typeInField, { field: shorten(phrase.field) });
    case "chooseValueIn":
      return fill(book.chooseValueIn, {
        value: shorten(phrase.value),
        field: shorten(phrase.field),
      });
    case "chooseIn":
      return fill(book.chooseIn, { field: shorten(phrase.field) });
    case "typeValue":
      return fill(book.typeValue, { value: shorten(phrase.value) });
    case "type":
      return book.type;
    case "typeValueInCell":
      return fill(book.typeValueInCell, { value: shorten(phrase.value), cell: phrase.cell });
    case "typeInCell":
      return fill(book.typeInCell, { cell: phrase.cell });
    case "press":
      return fill(book.press, { keys: localKeys(phrase.keys, language) });
    case "goTo":
      return fill(book.goTo, { site: phrase.site });
    case "open":
      return fill(book.open, { app: phrase.app });
    case "runIn":
      return phrase.terminal
        ? fill(book.runIn, { where: phrases.terminals[phrase.terminal] })
        : book.runInTerminal;
    case "formulaInCell":
      return fill(book.formulaInCell, { cell: phrase.cell });
    case "formulaInSelected":
      return book.formulaInSelected;
    case "code":
      return book.code;
    case "missed":
      return plural(book.missed, phrase.count, language);
    case "touch":
      return plural(book.touch, phrase.count, language);
    case "captureNow":
      return book.captureNow;
  }
}

// ----- From what was recorded to a phrase -----

type NameFact = "ariaLabel" | "innerText" | "placeholder" | "name" | "labelText" | "alt" | "value";

/** The first of `facts` the element has, in that order. */
const firstFact = (target: StepTarget, facts: readonly NameFact[]) =>
  facts.map((fact) => target[fact]).find((found): found is string => Boolean(found));

/** Desktop control types (UI Automation's, lower-cased as steps keep them) and web roles. */
const KIND_OF_HINT: Record<string, ElementKind> = {
  button: "button",
  splitbutton: "button",
  hyperlink: "link",
  link: "link",
  menuitem: "menuItem",
  tabitem: "tab",
  tab: "tab",
  listitem: "listItem",
  dataitem: "listItem",
  treeitem: "listItem",
  option: "listItem",
  checkbox: "checkbox",
  radiobutton: "radio",
  radio: "radio",
  combobox: "dropdown",
  edit: "field",
  textbox: "field",
  image: "picture",
  img: "picture",
  switch: "switch",
};

/** What kind of thing the element is, from its tag, role and, on the desktop, control type. */
function elementKind(target: StepTarget, hint?: string): ElementKind {
  const { tagName: tag, elementType: type, role } = target;
  if (role === "switch") return "switch";
  if (role === "checkbox") return "checkbox";
  switch (tag) {
    case "BUTTON":
      return "button";
    case "A":
      return "link";
    case "INPUT":
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "field";
    case "SELECT":
      return "dropdown";
    case "TEXTAREA":
      return "textArea";
    case "IMG":
      return "picture";
  }
  return (
    KIND_OF_HINT[(role ?? "").toLowerCase()] ?? KIND_OF_HINT[(hint ?? "").toLowerCase()] ?? "other"
  );
}

/**
 * Where a clicked element's name comes from, most specific first. Each entry is tried in turn;
 * the first that names the element wins. Anything unnamed falls back to its text.
 */
function clickNames(target: StepTarget): { facts: NameFact[]; field?: true }[] {
  const { tagName: tag, elementType: type, role } = target;
  const names: { facts: NameFact[]; field?: true }[] = [];
  switch (tag) {
    case "BUTTON":
    case "A":
      names.push({ facts: ["innerText"] });
      break;
    case "INPUT":
      if (type === "submit" || type === "button" || type === "reset")
        names.push({ facts: ["value"] });
      if (type === "checkbox" || type === "radio") names.push({ facts: ["labelText", "name"] });
      // A box to type in is named as a field.
      names.push({ facts: ["labelText", "placeholder", "name"], field: true });
      break;
    case "SELECT":
      names.push({ facts: ["labelText", "name"] });
      break;
    case "TEXTAREA":
      names.push({ facts: ["labelText", "placeholder", "name"] });
      break;
    case "IMG":
      names.push({ facts: ["alt"] });
      break;
  }
  if (role === "checkbox" || role === "switch") names.push({ facts: ["labelText", "name"] });
  names.push({ facts: ["innerText"] });
  return names;
}

/**
 * Typing names the field, by whatever labels it, and the value only when it's shown
 * (docs/spec/04-editor.md#typed-values): never the field's name as if it were what was typed.
 */
function typingPhrase(target: StepTarget): Phrase | undefined {
  const { value, labelText } = target;
  // A spreadsheet cell, named by its reference (docs/spec/02-capture.md#keys).
  if (target.tagName === "TD" && target.role === "gridcell" && labelText)
    return value
      ? { key: "typeValueInCell", value, cell: labelText }
      : { key: "typeInCell", cell: labelText };
  const field = firstFact(target, ["labelText", "ariaLabel", "placeholder", "name", "innerText"]);
  // Typing into a drop-down list chooses from it: "Type in … field" read wrongly (F010).
  const list = target.tagName === "SELECT" || ["combobox", "listbox"].includes(target.role ?? "");
  if (field && list)
    return value ? { key: "chooseValueIn", value, field } : { key: "chooseIn", field };
  if (field)
    return value ? { key: "typeValueInField", value, field } : { key: "typeInField", field };
  return value ? { key: "typeValue", value } : undefined;
}

/**
 * The phrase for what was done to an element, or undefined when nothing names it (the recorder
 * then words it from the window). `typed` is free typing with no field; `keys` a combination;
 * `hint` the desktop control type, which says what kind of thing an element is where its tag
 * can't (a menu item, a tab).
 */
export function phraseFor(
  action: StepAction,
  target?: StepTarget | null,
  typed?: string | null,
  keys?: string | null,
  hint?: string,
): Phrase | undefined {
  if (action === "keypress" && keys) return { key: "press", keys };
  if (action === "input" && typed) return { key: "typeValue", value: typed };
  if (!target) return undefined;
  if (action === "input") return typingPhrase(target);
  if (action !== "click") return undefined;
  // An explicit accessible name says what the author meant it to be called.
  if (target.ariaLabel) {
    const kind = elementKind(target, hint);
    return { key: "click", kind: kind === "field" ? "namedField" : kind, name: target.ariaLabel };
  }
  for (const { facts, field } of clickNames(target)) {
    const name = firstFact(target, facts);
    if (name) return { key: "click", kind: field ? "field" : elementKind(target, hint), name };
  }
  return undefined;
}

/**
 * What a taskbar button stands for. Windows names a running app's button after its window
 * ("New tab - Work - Microsoft Edge - 1 running window"), which ends with the app's name, and adds
 * "pinned" for a pinned app ("Google Chrome - 1 running window pinned", or "Google Chrome pinned"
 * with none running; 04/10/2026: the step read Click "1 running window pinned").
 */
export function taskbarAppName(buttonName: string): string {
  // Edge puts a zero-width space in "Microsoft Edge".
  const visible = buttonName.replace(/[\u{200B}-\u{200D}\u{FEFF}]/gu, "");
  const withoutCount = visible
    .replace(/\s+pinned$/i, "")
    .replace(/\s+-\s+\d+ running windows?$/i, "")
    .trim();
  return withoutCount.split(" - ").at(-1)?.trim() || withoutCount;
}

/**
 * The same click made with the right button (04/10/2026: right-clicks read as plain clicks, so a
 * context menu's choice seemed to come from nowhere). A stored step says so with the verb
 * `rightClick`.
 */
export function asRightClick(phrase: Phrase): Phrase {
  switch (phrase.key) {
    case "click":
    case "clickTaskbar":
      return { key: "rightClick", name: phrase.name };
    case "clickIn":
      return { key: "rightClickIn", title: phrase.title };
    case "clickBare":
      return { key: "rightClickBare" };
    default:
      return phrase;
  }
}

/** What a stored step needs for its phrase to be worked out again. */
export interface PhraseFacts {
  kind: string;
  action: string;
  actionText: string;
  textParts: { verb: string; target: string; kind: string; value?: string | undefined };
  showValue: boolean;
  context: { windowTitle: string };
  target: unknown;
  code?: { language: CodeLanguage } | null | undefined;
}

const TERMINALS = new Set<string>(["powershell", "cmd", "bash"]);

const isTarget = (value: unknown): value is StepTarget =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstNumber = (text: string) => Number(/\d+/.exec(text)?.[0] ?? "0");

/**
 * The phrase a recorded step says, worked out again from what it stores, for rewording it in
 * another tone or language; null for a step that can't be (a block, a step written by hand, or
 * one too old to say). Its own words aren't looked at, except to recover what older recordings
 * didn't store (a taskbar click, a count).
 */
export function phraseOfStep(step: PhraseFacts): Phrase | null {
  if (step.kind === "block") return null;
  const parts = step.textParts;
  const target = isTarget(step.target) ? step.target : null;
  const title = step.context.windowTitle.replace(/\s+/g, " ").trim();
  switch (step.action) {
    case "click": {
      if (parts.verb === "selectRange") return { key: "selectRange", range: parts.target };
      const right = parts.verb === "rightClick" ? asRightClick : (phrase: Phrase) => phrase;
      if (parts.kind === "taskbar" || step.actionText.endsWith(" on the taskbar"))
        return right({ key: "clickTaskbar", name: taskbarAppName(parts.target) });
      // A click that only reached the window is named by the window, not as if it were a control.
      const named =
        parts.kind === "window" ? undefined : phraseFor("click", target, null, null, parts.kind);
      return right(named ?? (title ? { key: "clickIn", title } : { key: "clickBare" }));
    }
    case "input": {
      const value = step.showValue ? parts.value : undefined;
      if (target && Object.keys(target).length > 0)
        return phraseFor("input", { ...target, value }) ?? { key: "type" };
      return value ? { key: "typeValue", value } : { key: "type" };
    }
    case "keypress":
      return parts.target ? { key: "press", keys: parts.target } : null;
    case "navigation":
      return parts.target ? { key: "goTo", site: parts.target } : null;
    case "appswitch":
      return parts.target ? { key: "open", app: parts.target } : null;
    case "command": {
      const language = step.code?.language ?? "";
      return { key: "runIn", terminal: TERMINALS.has(language) ? (language as Terminal) : null };
    }
    case "formula":
      return parts.target.trim()
        ? { key: "formulaInCell", cell: parts.target.trim() }
        : { key: "formulaInSelected" };
    case "code":
      return { key: "code" };
    case "manual":
      if (parts.target === "missed" && parts.kind === "warning")
        return { key: "missed", count: Number(parts.value) || firstNumber(step.actionText) };
      if (parts.target === "touch" && parts.kind === "warning")
        return { key: "touch", count: Number(parts.value) || firstNumber(step.actionText) };
      if (parts.kind === "screenshot") return { key: "captureNow" };
      return null;
    default:
      return null;
  }
}

/** A stored step's words in `language` and `tone`, or null when they can't be worked out again. */
export function wordStepIn(step: PhraseFacts, language: string, tone: Tone): string | null {
  const phrase = phraseOfStep(step);
  return phrase ? renderPhrase(phrase, language, tone) : null;
}
