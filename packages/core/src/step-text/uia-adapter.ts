// Fills a step's target facts from UI Automation, so desktop steps are worded by the same rules
// as the Chrome edition's (docs/spec/02-capture.md#mapping-uia-to-step-facts).

import {
  ENGLISH,
  asRightClick,
  phraseFor,
  renderPhrase,
  type Phrase,
  type StepWording,
} from "./phrase.ts";
import type { StepTarget, UiaElementFacts } from "./types.ts";

/** Control types a text leaf is promoted to, mirroring how the DOM reports the element clicked. */
const INTERACTIVE_PARENTS = new Set([
  "Button",
  "Hyperlink",
  "MenuItem",
  "ListItem",
  "TabItem",
  "TreeItem",
  "CheckBox",
  "RadioButton",
  "SplitButton",
]);

const clean = (text: string | null | undefined): string | undefined => {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
};

/** Rows in desktop lists and tables (File Explorer details view, Outlook message lists…). */
const ROW_PARENTS = new Set(["ListItem", "DataItem", "TreeItem"]);

/**
 * A text node inside a button or link reads as the button or link (Chrome and Office do this).
 * In desktop apps, a cell inside a row reads as the row: clicking the middle of a file in
 * Explorer's details view hits its "Date modified" cell, but the step is about the file.
 */
const promoteTextLeaf = (facts: UiaElementFacts): UiaElementFacts => {
  const { parent } = facts;
  if (!parent || !clean(parent.name)) {
    return facts;
  }
  const textInInteractive =
    facts.controlType === "Text" && INTERACTIVE_PARENTS.has(parent.controlType);
  const cellInDesktopRow =
    facts.frameworkId !== "Chrome" &&
    ROW_PARENTS.has(parent.controlType) &&
    ["Edit", "Text", "Image"].includes(facts.controlType);
  if (textInInteractive || cellInDesktopRow) {
    return { ...facts, controlType: parent.controlType, name: parent.name };
  }
  return facts;
};

export function uiaToStepTarget(input: UiaElementFacts): StepTarget {
  const facts = promoteTextLeaf(input);
  const name = clean(facts.name);
  const label = clean(facts.labeledBy) ?? name;
  const role = clean(facts.ariaRole);

  switch (facts.controlType) {
    case "Button":
    case "SplitButton":
      if (role === "switch" || role === "checkbox") {
        return { tagName: "DIV", role, labelText: label };
      }
      return { tagName: "BUTTON", innerText: name };
    case "Hyperlink":
      return { tagName: "A", innerText: name };
    case "Edit":
      return {
        tagName: "INPUT",
        elementType: facts.isPassword ? "password" : "text",
        labelText: label,
        placeholder: label ? undefined : clean(facts.helpText),
      };
    case "CheckBox":
      return { tagName: "INPUT", elementType: "checkbox", labelText: label };
    case "RadioButton":
      return { tagName: "INPUT", elementType: "radio", labelText: label };
    case "ComboBox":
      return { tagName: "SELECT", labelText: label };
    case "Image":
      return { tagName: "IMG", alt: name };
    default:
      return { tagName: "DIV", innerText: name, role };
  }
}

export interface ClickWording {
  text: string;
  /** No usable element name: flagged "Unnamed click" for review (docs/spec/02-capture.md). */
  unnamed: boolean;
}

/**
 * Step text for a desktop click. Falls back to the window title when UIA gave no name. A click
 * that only reaches the window itself (a page an app keeps off the accessibility tree, as Chrome
 * does on Linux) is named by its title too, not as if the title were a control.
 */
export function describeClick(
  facts: UiaElementFacts | null | undefined,
  windowTitle: string,
  wording: StepWording = ENGLISH,
  rightButton = false,
): ClickWording {
  const named = facts && facts.controlType !== "Window";
  const found = named
    ? phraseFor("click", uiaToStepTarget(facts), null, null, promoteTextLeaf(facts).controlType)
    : undefined;
  const phrase = found && rightButton ? asRightClick(found) : found;
  if (phrase) {
    return { text: renderPhrase(phrase, wording.language, wording.tone), unnamed: false };
  }
  const title = clean(windowTitle);
  const where: Phrase = title ? { key: "clickIn", title } : { key: "clickBare" };
  return {
    text: renderPhrase(rightButton ? asRightClick(where) : where, wording.language, wording.tone),
    unnamed: true,
  };
}

/** Step text for a field value read on focus-leave. `value` is undefined when withheld. */
export function describeInput(
  facts: UiaElementFacts,
  value: string | undefined,
  wording: StepWording = ENGLISH,
): string {
  const target = { ...uiaToStepTarget(facts), value };
  return renderPhrase(
    phraseFor("input", target) ?? { key: "type" },
    wording.language,
    wording.tone,
  );
}
