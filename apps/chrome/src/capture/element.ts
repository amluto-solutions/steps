import { looksSensitive, type StepTarget } from "@amluto-steps/core";

/**
 * What the Chrome edition learns about the element a click or typing landed on
 * (docs/spec/02-capture.md#chrome-edition): the element people meant, its step facts for the
 * shared wording rules, where it is, and whether its value must never be read.
 */

/** What people click on purpose; a click inside one (an icon in a button) counts as on it. */
const INTERACTIVE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  ...[
    "button",
    "link",
    "checkbox",
    "switch",
    "radio",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "option",
    "gridcell",
    "treeitem",
    "combobox",
    "textbox",
  ].map((role) => `[role='${role}']`),
].join(",");

/** The longest text read from an element: enough to word it, not a whole page. */
const MAX_TEXT = 500;

const clean = (text: string | null | undefined) =>
  (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) || undefined;

/** An element's text as people see it (`innerText` where the browser has it). */
const visibleText = (element: Element) =>
  clean(
    element instanceof HTMLElement && typeof element.innerText === "string"
      ? element.innerText
      : element.textContent,
  );

/** Where people type in rich-text editors (Outlook on the web, Teams, TinyMCE, CKEditor). */
const EDITABLE =
  "[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";

/**
 * The rich-text editor an element is in: the outermost editable element around it, or the body of
 * a document in design mode (older editors in a frame). Null outside one.
 */
export function editingHost(element: Element): HTMLElement | null {
  const document = element.ownerDocument;
  if (document.designMode === "on") return document.body;
  let host: HTMLElement | null = null;
  for (let up = element.closest(EDITABLE); up; up = up.parentElement?.closest(EDITABLE) ?? null)
    if (up instanceof HTMLElement) host = up;
  return host;
}

/** The longest text read from an editor as typing: the step format's limit for a value. */
export const MAX_EDITED = 20_000;

/** What an editor holds, as its words: what "Record what's typed" reads when it's left. */
export const editedText = (host: HTMLElement) =>
  (typeof host.innerText === "string" ? host.innerText : (host.textContent ?? ""))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, MAX_EDITED);

/**
 * What was typed into an editor: the part that changed between arriving and leaving, so a reply
 * doesn't carry the quoted message below it. Empty when text was only taken away.
 */
export function typedPart(before: string, after: string): string {
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < shorter - start && before[before.length - 1 - end] === after[after.length - 1 - end])
    end += 1;
  return after.slice(start, after.length - end).trim();
}

/** The element a click meant: the nearest interactive one around the point clicked. */
export function meantElement(hit: Element): Element {
  const found = hit.closest(INTERACTIVE);
  if (!found) return hit;
  // A label clicks its control: word the control, named by the label.
  if (found instanceof HTMLLabelElement && found.control) return found.control;
  return found;
}

/** The text of the elements an `aria-labelledby` names. */
function labelledBy(element: Element): string | undefined {
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean) ?? [];
  const parts = ids
    .map((id) => element.ownerDocument.getElementById(id))
    .map((found) => (found ? visibleText(found) : undefined))
    .filter(Boolean);
  return parts.length ? clean(parts.join(" ")) : undefined;
}

function labelText(element: Element): string | undefined {
  const labels = (element as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    // The label's own words, not the words of the control inside it.
    const label = labels[0] as HTMLLabelElement;
    const copy = label.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("input, select, textarea, button").forEach((control) => control.remove());
    return clean(copy.textContent);
  }
  return undefined;
}

/**
 * An editor that is a whole document in a frame (TinyMCE's "Rich Text Area") is named by its
 * frame, when the frame's page can be read.
 */
function frameTitle(element: Element): string | undefined {
  const document = element.ownerDocument;
  if (element !== document.body || editingHost(element) !== element) return undefined;
  try {
    const frame = document.defaultView?.frameElement;
    return frame
      ? (clean(frame.getAttribute("aria-label")) ?? clean(frame.getAttribute("title")))
      : undefined;
  } catch {
    // A frame from another site can't see the page around it.
    return undefined;
  }
}

/** The step facts the wording rules read, from the page. */
export function stepTarget(element: Element): StepTarget {
  const tag = element.tagName.toUpperCase();
  const input = element instanceof HTMLInputElement ? element : null;
  const type = input?.type.toLowerCase();
  // An editor's words are what was typed in it, so they're read only as typing, like a field's.
  const field =
    tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || editingHost(element) !== null;
  const target: StepTarget = {
    tagName: tag,
    elementType: type,
    ariaLabel:
      clean(element.getAttribute("aria-label")) ?? labelledBy(element) ?? frameTitle(element),
    innerText: field ? undefined : visibleText(element),
    placeholder:
      clean(element.getAttribute("placeholder")) ??
      clean(element.getAttribute("aria-placeholder")) ??
      clean(element.getAttribute("data-placeholder")),
    name: clean(element.getAttribute("name")),
    labelText: labelText(element),
    alt: tag === "IMG" ? clean(element.getAttribute("alt")) : undefined,
    role: clean(element.getAttribute("role")),
    // A button's words are its value; any other field's value is only read as typing.
    value:
      type === "submit" || type === "button" || type === "reset" ? clean(input?.value) : undefined,
  };
  return Object.fromEntries(Object.entries(target).filter(([, value]) => value !== undefined));
}

/** Autofill hints that say a field holds a secret, whatever it's called. */
const SECRET_AUTOCOMPLETE =
  /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i;

/**
 * Whether a field's value must never be read (docs/spec/08-privacy-and-security.md#input-rules):
 * a password box, a secret autofill hint, or a name, label or hint the shared sensitive-field
 * rules recognise. `extraTerms` come from IT policy.
 */
export function isSensitive(element: Element, extraTerms: readonly string[] = []): boolean {
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") return true;
  if (SECRET_AUTOCOMPLETE.test(element.getAttribute("autocomplete") ?? "")) return true;
  const target = stepTarget(element);
  return looksSensitive(
    [
      target.labelText ?? "",
      target.ariaLabel ?? "",
      target.placeholder ?? "",
      target.name ?? "",
      element.id,
      element.getAttribute("title") ?? "",
    ],
    extraTerms,
  );
}

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A point or box as percentages of the visible page, which is what the screenshot shows. */
export function inView(
  box: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): ViewRect {
  const pc = (value: number, total: number) => Math.round((value / total) * 10_000) / 100;
  return {
    x: pc(box.left, viewport.width),
    y: pc(box.top, viewport.height),
    w: pc(box.width, viewport.width),
    h: pc(box.height, viewport.height),
  };
}
