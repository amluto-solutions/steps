// Fills a step's target facts from UI Automation, so desktop steps are worded by the same rules
// as the Chrome edition's (docs/spec/02-capture.md#mapping-uia-to-step-facts).

import { ENGLISH, phraseFor, renderPhrase, type StepWording } from "./phrase.ts";
import type { StepTarget, UiaAncestor, UiaElementFacts } from "./types.ts";

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
 * Names a UI framework gives its own hosts, which say nothing to a reader, compared without
 * spaces, hyphens and case. The Windows recorder uses the same list to decide when to look
 * further for the element under a click; `test-vectors/click-naming.json` holds both to it.
 */
export const FRAMEWORK_NAMES: readonly string[] = [
  "popuphost",
  "desktopwindowxamlsource",
  "xamlexplorerhostislandwindow",
  "chrome_widgetwin_0",
  "chrome_widgetwin_1",
  "chromelegacywindow",
  "intermediated3dwindow",
  "windowsuicorecorewindow",
];

/**
 * The invisible layer a XAML menu lays over its window to close on a click outside it, named
 * "Close" (02/10/2026: Notepad's Edit menu read `Click "Close"`).
 */
export const LIGHT_DISMISS_IDS: readonly string[] = ["Light Dismiss"];

/**
 * A framework's name (`PopupHost`, `Pop-upHost`, `DesktopWindowXamlSource`, or a window class
 * such as `Chrome_RenderWidgetHostHWND` standing in for one).
 */
const isFrameworkName = (name: string, className: string) =>
  FRAMEWORK_NAMES.includes(name.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase()) ||
  (name !== "" && name === className && name.includes("_"));

/**
 * The facts with any name that isn't the app's taken off: a UI framework's, or the light-dismiss
 * layer's "Close". The nearest named parent then speaks for the element. Facts with nothing taken
 * off come back as the same object.
 */
export const readableFacts = (facts: UiaElementFacts): UiaElementFacts =>
  facts.name !== "" &&
  (isFrameworkName(facts.name, facts.className) || LIGHT_DISMISS_IDS.includes(facts.automationId))
    ? { ...facts, name: "" }
    : facts;

/** Parts with nothing to say for themselves: wrappers, text, pictures. */
const WRAPPERS = new Set(["Group", "Text", "Image", "Custom", "Pane"]);

/**
 * The named item an element is part of: up its parents, past unnamed wrappers, to the first one
 * with a name, when that's an item that can be clicked. A named panel on the way, or an unnamed
 * button (an item's own "more" button), stops the climb: it isn't the item's.
 */
const owningItem = ({ ancestors }: UiaElementFacts): UiaAncestor | null => {
  for (const ancestor of ancestors) {
    if (clean(ancestor.name))
      return INTERACTIVE_PARENTS.has(ancestor.controlType) ? ancestor : null;
    if (!WRAPPERS.has(ancestor.controlType)) return null;
  }
  return null;
};

/**
 * A text node inside a button or link reads as the button or link (Chrome and Office do this),
 * and so does an unnamed part of a named menu or list item, button or link: SiteGround's
 * "Forwarders" is a list item whose clickable inside has no name (05/10/2026). Web pages wrap
 * an item's insides a few levels deep, so the item may be up to four parents up (06/10/2026).
 * In desktop apps, a cell inside a row reads as the row: clicking the middle of a file in
 * Explorer's details view hits its "Date modified" cell, but the step is about the file.
 * An element that stays itself comes back as the same object, which is how the click naming tells
 * a name of the element's own from its parent's.
 */
export const promoteTextLeaf = (facts: UiaElementFacts): UiaElementFacts => {
  const partOfItem =
    facts.controlType === "Text" || (!clean(facts.name) && WRAPPERS.has(facts.controlType));
  const item = partOfItem ? owningItem(facts) : null;
  if (item) return { ...facts, controlType: item.controlType, name: item.name };
  const [parent] = facts.ancestors;
  const cellInDesktopRow =
    parent !== undefined &&
    clean(parent.name) !== undefined &&
    facts.frameworkId !== "Chrome" &&
    ROW_PARENTS.has(parent.controlType) &&
    ["Edit", "Text", "Image"].includes(facts.controlType);
  if (cellInDesktopRow) return { ...facts, controlType: parent.controlType, name: parent.name };
  return facts;
};

export function uiaToStepTarget(input: UiaElementFacts): StepTarget {
  const facts = promoteTextLeaf(readableFacts(input));
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
