import { describe, expect, it } from "vitest";

import table from "./click-naming.cases.json";
import {
  clickPhrase,
  menuItemFor,
  nameClick,
  namingOfStep,
  type ClickEvidence,
  type ClickNaming,
  type MenuItem,
  withoutShortcut,
} from "./click-naming.ts";
import { asDoubleClick, asRightClick, renderPhrase, TONES } from "./phrase.ts";
import { PHRASEBOOKS } from "./phrasebooks/index.ts";
import { wordStepIn } from "./reword.ts";
import type { UiaElementFacts } from "./types.ts";

/** What UI Automation reports for an element that tells it nothing. */
const BLANK: UiaElementFacts = {
  controlType: "Pane",
  localizedControlType: "",
  name: "",
  automationId: "",
  helpText: "",
  ariaRole: "",
  ariaProperties: "",
  className: "",
  frameworkId: "",
  isPassword: false,
  labeledBy: null,
  ancestors: [],
  sensitive: false,
};

interface Case {
  case: string;
  evidence: {
    element: Partial<UiaElementFacts> | null;
    window: ClickEvidence["window"];
    page?: ClickEvidence["page"];
    screen?: ClickEvidence["screen"];
    titleBarButton?: ClickEvidence["titleBarButton"];
    filterButton?: ClickEvidence["filterButton"];
  };
  naming: ClickNaming;
  text: string;
}

const evidenceOf = ({
  element,
  window,
  page,
  screen,
  titleBarButton,
  filterButton,
}: Case["evidence"]): ClickEvidence => ({
  element: element && { ...BLANK, ...element },
  window,
  ...(page ? { page } : {}),
  ...(screen ? { screen } : {}),
  ...(titleBarButton ? { titleBarButton } : {}),
  ...(filterButton ? { filterButton } : {}),
});

describe("click naming, case by case", () => {
  it.each((table.cases as Case[]).map((entry) => [entry.case, entry] as const))(
    "%s",
    (_, entry) => {
      const naming = nameClick(evidenceOf(entry.evidence));
      expect(naming).toEqual(entry.naming);
      expect(renderPhrase(clickPhrase(naming), "en", "casual")).toBe(entry.text);
    },
  );

  it("says a combo box's drop-down button opens its list, in the plain and formal tones", () => {
    const [opened] = (table.cases as Case[]).filter(
      (entry) => entry.case === "a combo box's own drop-down button is named by its combo box",
    );
    if (!opened) throw new Error("the Number Format case is missing");
    const naming = nameClick(evidenceOf(opened.evidence));
    expect(renderPhrase(clickPhrase(naming), "en", "plain")).toBe('Open the "Number Format" list');
    expect(renderPhrase(clickPhrase(naming), "en", "formal")).toBe(
      'Click the "Number Format" drop-down list.',
    );
  });

  it("says a header's filter drop-down opens its filter, in the plain and formal tones (#70)", () => {
    const [filter] = (table.cases as Case[]).filter((entry) =>
      entry.case.startsWith("a click on a header's filter drop-down"),
    );
    if (!filter) throw new Error("the filter case is missing");
    const naming = nameClick(evidenceOf(filter.evidence));
    expect(renderPhrase(clickPhrase(naming), "en", "plain")).toBe(
      'Open the filter on the "Item" column',
    );
    expect(renderPhrase(clickPhrase(naming), "en", "formal")).toBe(
      'Click the filter arrow in the "Item" column heading.',
    );
  });

  it("says a click in Word's document text in each tone, right- and double-clicked too (#74)", () => {
    const [page] = (table.cases as Case[]).filter((entry) =>
      entry.case.startsWith("a click into a Word document's page"),
    );
    if (!page) throw new Error("the Word page case is missing");
    const phrase = clickPhrase(nameClick(evidenceOf(page.evidence)));
    expect(renderPhrase(phrase, "en", "plain")).toBe("Select inside the document");
    expect(renderPhrase(phrase, "en", "formal")).toBe("Click inside the document.");
    // Right-clicked for a spelling suggestion; double-clicked to select a word.
    expect(renderPhrase(asRightClick(phrase), "en", "casual")).toBe("Right-click in the document");
    expect(renderPhrase(asDoubleClick(phrase), "en", "casual")).toBe(
      "Double-click in the document",
    );
    expect(renderPhrase(asDoubleClick(phrase), "en", "formal")).toBe(
      "Double-click inside the document.",
    );
    // Only Word's document text: another program's custom element is named as before.
    const elsewhere = nameClick(
      evidenceOf({ ...page.evidence, window: { title: "Notes", exe: "notes.exe" } }),
    );
    expect(elsewhere).toEqual({
      name: "Page 1",
      kind: "other",
      source: "element",
      needsReview: false,
    });
  });

  it("names a drop-down only with the cell's word that it has one (#70)", () => {
    // A press in the drop-down's square of a cell that has none is a click on the cell.
    const cell: Partial<UiaElementFacts> = {
      controlType: "DataItem",
      name: "B4",
      className: "XLSpreadsheetCell",
    };
    const naming = nameClick(
      evidenceOf({
        element: cell,
        window: { title: "Prices.xlsx - Excel", exe: "EXCEL.EXE" },
        filterButton: true,
      }),
    );
    expect(naming).toEqual({ name: "B4", kind: "listItem", source: "element", needsReview: false });
  });
});

describe("a tooltip's shortcut after a name (#71)", () => {
  it.each([
    ["Bold (Ctrl+B)", "Bold"],
    ["Bold (Ctrl + B)", "Bold"],
    ["Save (CTRL+S)", "Save"],
    ["Fett (Strg+B)", "Fett"],
    ["Rechercher (Ctrl+Maj+F)", "Rechercher"],
    ["Zoom (Ctrl+Page Up)", "Zoom"],
    ["太字 (Ctrl+B)", "太字"],
    ["太字（Ctrl+B）", "太字"],
  ])("takes it off %s", (name, cut) => {
    expect(withoutShortcut(name)).toBe(cut);
  });

  it.each(["(Ctrl+B)", "Inbox (3)", "Alt text (Alt-Text)", "Ctrl+B", "Help (F1)", "Bold (B)"])(
    "leaves %s as it is",
    (name) => {
      expect(withoutShortcut(name)).toBe(name);
    },
  );
});

describe("a name read from the screenshot, matched to the menu's items (#56)", () => {
  const item = (name: string, row: number | null = null): MenuItem => ({
    name,
    box: row === null ? null : { x: 1, y: row * 4, w: 14, h: 3.6 },
  });
  /** Paint's File menu, one item a row. */
  const paint = ["New", "Open", "Save", "Save as", "Print", "Exit"].map((name, row) =>
    item(name, row),
  );
  const inRow = (row: number) => ({ x: 5, y: row * 4 + 1.8 });

  it("takes the item a misread or cut-short name is, in the click's row", () => {
    expect(menuItemFor("Sav", paint, inRow(3))?.name).toBe("Save as");
    expect(menuItemFor("Sav", paint, inRow(2))?.name).toBe("Save");
    expect(menuItemFor("Prlnt", paint, inRow(4))?.name).toBe("Print");
  });

  it("takes none when the words are another item than the one clicked", () => {
    expect(menuItemFor("Print", paint, inRow(5))).toBeNull();
  });

  it("without boxes, takes only the one closest item", () => {
    const unplaced = paint.map(({ name }) => item(name));
    expect(menuItemFor("Opem", unplaced, inRow(0))?.name).toBe("Open");
    // "Sav" starts both Save and Save as: no telling which.
    expect(menuItemFor("Sav", unplaced, inRow(0))).toBeNull();
  });

  it("ignores case, an ellipsis, access-key marks and a shortcut after a tab", () => {
    const excel = [item("&Format Cells…\tCtrl+1", 0), item("Insert…", 1)];
    expect(menuItemFor("FORMAT CELLS...", excel, inRow(0))?.name).toBe("&Format Cells…\tCtrl+1");
  });

  it("allows one edit in four letters, and none in a word shorter than three", () => {
    const items = [item("Properties"), item("Ok")];
    expect(menuItemFor("Prapertes", items, { x: 0, y: 0 })?.name).toBe("Properties");
    expect(menuItemFor("Pnpertex", items, { x: 0, y: 0 })).toBeNull();
    expect(menuItemFor("OK", items, { x: 0, y: 0 })?.name).toBe("Ok");
    expect(menuItemFor("Ox", items, { x: 0, y: 0 })).toBeNull();
  });

  it("names the step after the item, without its ellipsis or shortcut, needing no check", () => {
    const naming = nameClick({
      element: null,
      window: { title: "", exe: "EXCEL.EXE" },
      screen: {
        lines: [{ words: [{ text: "Eormat", x: 1.5, y: 0.5, w: 4, h: 2 }] }],
        x: 3,
        y: 1.5,
        menuItems: [item("Format Cells…\tCtrl+1", 0)],
      },
    });
    expect(naming).toEqual({
      name: "Format Cells",
      kind: "menuItem",
      source: "menu",
      needsReview: false,
    });
    expect(renderPhrase(clickPhrase(naming), "en", "plain")).toBe(
      'Select "Format Cells" in the menu',
    );
  });
});

/** A recorded click as a guide stores it, with its naming and nothing else to go on. */
const storedClick = (naming: ClickNaming, actionText: string, verb = "click") => ({
  kind: "interaction",
  action: "click",
  actionText,
  textParts: { verb, target: "", kind: "group" },
  showValue: false,
  context: { windowTitle: "Site Tools > Dashboard - Google Chrome" },
  target: { tagName: "DIV" },
  naming,
});

describe("rewording reads the stored naming", () => {
  it("gives back the same English words for every case", () => {
    for (const entry of table.cases as Case[])
      expect(wordStepIn(storedClick(entry.naming, entry.text), "en", "casual")).toBe(entry.text);
  });

  it("keeps a name only the naming has, in another language and tone", () => {
    // Read from the screenshot: the element itself told UI Automation nothing.
    const naming: ClickNaming = {
      name: "Forwarders",
      kind: "other",
      source: "screen",
      needsReview: true,
    };
    const german = wordStepIn(storedClick(naming, 'Click "Forwarders"'), "de", "formal");
    expect(german).toContain("Forwarders");
    expect(german).not.toContain("Site Tools");
  });

  it("keeps a right-click a right-click", () => {
    const naming: ClickNaming = {
      name: "Forwarders",
      kind: "listItem",
      source: "ancestor",
      needsReview: false,
    };
    expect(wordStepIn(storedClick(naming, "", "rightClick"), "en", "casual")).toBe(
      'Right-click "Forwarders"',
    );
  });
});

describe("an older step's naming, worked out from what it kept", () => {
  /** A taskbar click saved before steps kept their naming or marked the taskbar. */
  const olderTaskbarClick = (actionText: string) => ({
    actionText,
    textParts: { target: "Outlook - 1 running window", kind: "button" },
    context: { windowTitle: "" },
    target: { tagName: "BUTTON", innerText: "Outlook - 1 running window" },
  });
  const taskbar: ClickNaming = {
    name: "Outlook",
    kind: "button",
    source: "taskbar",
    needsReview: false,
  };

  const worded = Object.keys(PHRASEBOOKS).flatMap((language) =>
    TONES.map((tone) => [
      `${language}, ${tone}`,
      renderPhrase({ key: "clickTaskbar", name: "Outlook" }, language, tone),
    ]),
  );

  it.each(worded)("knows a taskbar click by its words (%s)", (_, actionText) => {
    expect(namingOfStep(olderTaskbarClick(actionText ?? ""))).toEqual(taskbar);
  });

  it("knows a taskbar click marked as one, whatever its words", () => {
    const marked = {
      ...olderTaskbarClick("Edited by hand"),
      textParts: { target: "Outlook", kind: "taskbar" },
    };
    expect(namingOfStep(marked)).toEqual(taskbar);
  });

  it("knows a header's filter drop-down by its kind, named by the header (#70)", () => {
    // A version that didn't know the kind left the naming out; the step's parts still say it.
    const step = {
      actionText: 'Open the filter on "Item"',
      textParts: { target: "Item", kind: "filterButton" },
      context: { windowTitle: "Prices.xlsx - Excel" },
      target: { tagName: "DIV", innerText: "A1" },
    };
    expect(namingOfStep(step)).toEqual({
      name: "Item",
      kind: "filterButton",
      source: "element",
      needsReview: false,
    });
  });

  it("keeps a pop-up host's title an older click was named by, as it was recorded", () => {
    const step = {
      actionText: 'Click in "Pop-upHost"',
      textParts: { target: "Pop-upHost", kind: "window" },
      context: { windowTitle: "Pop-upHost" },
      target: null,
    };
    expect(namingOfStep(step).name).toBe("Pop-upHost");
  });

  it("names a pop-up host's click by the window it came from, kept as its target (#106)", () => {
    // A version that couldn't read the naming left it out; the target still says it.
    const step = {
      actionText: 'Click in "Untitled - Paint"',
      textParts: { target: "Untitled - Paint", kind: "window" },
      context: { windowTitle: "Pop-upHost" },
      target: null,
    };
    expect(namingOfStep(step)).toEqual({
      name: "Untitled - Paint",
      kind: "other",
      source: "window",
      needsReview: true,
    });
    // A window with a title of its own is still named by it, whatever the target says.
    expect(namingOfStep({ ...step, context: { windowTitle: "Book1 - Excel" } }).name).toBe(
      "Book1 - Excel",
    );
  });

  it("doesn't take a button whose name mentions the taskbar for a taskbar click", () => {
    const step = {
      ...olderTaskbarClick('Click "Pin on the taskbar"'),
      textParts: { target: "Pin on the taskbar", kind: "button" },
      target: { tagName: "BUTTON", innerText: "Pin on the taskbar" },
    };
    expect(namingOfStep(step).source).toBe("element");
  });
});
