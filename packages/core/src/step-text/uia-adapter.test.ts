import { describe, expect, it } from "vitest";

import shared from "../../test-vectors/click-naming.json";
import type { UiaElementFacts } from "./types.ts";
import { clickPhrase, nameClick, NAMING_SOURCES } from "./click-naming.ts";
import { ELEMENT_KINDS, renderPhrase } from "./phrase.ts";
import {
  describeInput,
  FRAMEWORK_NAMES,
  LIGHT_DISMISS_IDS,
  readableFacts,
  uiaToStepTarget,
} from "./uia-adapter.ts";

/** A desktop click's English words and whether it's flagged, as a recorded step has them. */
const describeClick = (element: UiaElementFacts | null, title: string) => {
  const naming = nameClick({ element, window: { title, exe: null } });
  return {
    text: renderPhrase(clickPhrase(naming), "en", "casual"),
    unnamed: naming.needsReview,
  };
};

const facts = (overrides: Partial<UiaElementFacts>): UiaElementFacts => ({
  controlType: "Pane",
  localizedControlType: "",
  name: "",
  automationId: "",
  helpText: "",
  ariaRole: "",
  ariaProperties: "",
  className: "",
  frameworkId: "Chrome",
  isPassword: false,
  labeledBy: null,
  ancestors: [],
  sensitive: false,
  ...overrides,
});

describe("uiaToStepTarget", () => {
  it("maps buttons, links and images", () => {
    expect(uiaToStepTarget(facts({ controlType: "Button", name: "Save" }))).toEqual({
      tagName: "BUTTON",
      innerText: "Save",
    });
    expect(uiaToStepTarget(facts({ controlType: "Hyperlink", name: "Pricing" })).tagName).toBe("A");
    expect(uiaToStepTarget(facts({ controlType: "Image", name: "Logo" })).alt).toBe("Logo");
  });

  it("uses LabeledBy before the field's own name", () => {
    const target = uiaToStepTarget(
      facts({ controlType: "Edit", name: "Email address", labeledBy: "Email" }),
    );
    expect(target.labelText).toBe("Email");
  });

  it("falls back to help text as the placeholder only when there's no name", () => {
    expect(uiaToStepTarget(facts({ controlType: "Edit", helpText: "Search" })).placeholder).toBe(
      "Search",
    );
    expect(
      uiaToStepTarget(facts({ controlType: "Edit", name: "Query", helpText: "Search" }))
        .placeholder,
    ).toBeUndefined();
  });

  it("marks password edits", () => {
    expect(uiaToStepTarget(facts({ controlType: "Edit", isPassword: true })).elementType).toBe(
      "password",
    );
  });

  it("promotes a text node inside a link or button to its parent", () => {
    const target = uiaToStepTarget(
      facts({
        controlType: "Text",
        name: "Save",
        ancestors: [{ controlType: "Button", name: "Save changes" }],
      }),
    );
    expect(target).toEqual({ tagName: "BUTTON", innerText: "Save changes" });
  });

  it("names an unnamed part of a named list item by the item", () => {
    const inside = facts({
      controlType: "Group",
      className: "sg-nav-list-item__content",
      ancestors: [{ controlType: "ListItem", name: "Forwarders" }],
    });
    expect(describeClick(inside, "Site Tools").text).toBe('Click "Forwarders"');
    // A named part keeps its own name, and a field stays a field.
    expect(uiaToStepTarget({ ...inside, name: "Badge" })).toMatchObject({ innerText: "Badge" });
    expect(uiaToStepTarget({ ...inside, controlType: "Edit" })).toMatchObject({ tagName: "INPUT" });
  });

  it("reads a cell in a desktop list row as the row (File Explorer details view)", () => {
    const cell = facts({
      controlType: "Edit",
      name: "Date modified",
      frameworkId: "DirectUI",
      className: "UIProperty",
      ancestors: [{ controlType: "ListItem", name: "Q3 report.txt" }],
    });
    expect(describeClick(cell, "amluto-proto-files").text).toBe('Click "Q3 report.txt"');
  });

  it("keeps a real text box inside a web list as a field", () => {
    const field = facts({
      controlType: "Edit",
      name: "Quantity",
      frameworkId: "Chrome",
      ancestors: [{ controlType: "ListItem", name: "Widgets" }],
    });
    expect(describeClick(field, "Shop").text).toBe('Click "Quantity" field');
  });

  it("keeps plain text as text", () => {
    const target = uiaToStepTarget(
      facts({
        controlType: "Text",
        name: "Welcome",
        ancestors: [{ controlType: "Group", name: "" }],
      }),
    );
    expect(target).toEqual({ tagName: "DIV", innerText: "Welcome", role: undefined });
  });

  it("treats ARIA switches on buttons like the DOM did", () => {
    expect(
      uiaToStepTarget(facts({ controlType: "Button", name: "Dark mode", ariaRole: "switch" })),
    ).toEqual({ tagName: "DIV", role: "switch", labelText: "Dark mode" });
  });
});

describe("desktop clicks named and worded", () => {
  it("produces the old wording for common controls", () => {
    expect(describeClick(facts({ controlType: "Button", name: "Save" }), "App").text).toBe(
      'Click "Save"',
    );
    expect(describeClick(facts({ controlType: "Edit", name: "Email" }), "App").text).toBe(
      'Click "Email" field',
    );
    expect(describeClick(facts({ controlType: "CheckBox", name: "Remember me" }), "App").text).toBe(
      'Click "Remember me"',
    );
    expect(describeClick(facts({ controlType: "ComboBox", name: "Country" }), "App").text).toBe(
      'Click "Country"',
    );
    expect(describeClick(facts({ controlType: "MenuItem", name: "File" }), "Excel").text).toBe(
      'Click "File"',
    );
  });

  it("flags unnamed clicks and falls back to the window title", () => {
    expect(describeClick(facts({ controlType: "Pane" }), "Budget.xlsx - Excel")).toEqual({
      text: 'Click in "Budget.xlsx - Excel"',
      unnamed: true,
    });
    expect(describeClick(null, "")).toEqual({ text: "Click", unnamed: true });
  });

  it("names a click that only reached the window by its title, flagged", () => {
    const window = facts({ controlType: "Window", name: "Invoices - Google Chrome" });
    expect(describeClick(window, "Invoices - Google Chrome")).toEqual({
      text: 'Click in "Invoices - Google Chrome"',
      unnamed: true,
    });
  });
});

describe("describeInput", () => {
  it("reads like the old blur step", () => {
    expect(describeInput(facts({ controlType: "Edit", name: "Email" }), "robin@example.com")).toBe(
      'Type "robin@example.com" in "Email" field',
    );
  });

  it("names just the field when the value was withheld", () => {
    expect(
      describeInput(facts({ controlType: "Edit", name: "Password", isPassword: true }), undefined),
    ).toBe('Type in "Password" field');
  });
});

describe("the naming facts the Windows recorder shares (test-vectors/click-naming.json)", () => {
  it("allows the same element kinds and naming sources as the desktop's guide files", () => {
    expect(ELEMENT_KINDS).toEqual(shared.elementKinds);
    expect(NAMING_SOURCES).toEqual(shared.namingSources);
  });

  it("knows the same framework names and light-dismiss layer as the recorder", () => {
    expect(FRAMEWORK_NAMES).toEqual(shared.frameworkNames);
    expect(LIGHT_DISMISS_IDS).toEqual(shared.lightDismissAutomationIds);
  });

  it.each(shared.frameworkNameCases.map((entry) => [entry.name, entry] as const))(
    "takes a framework's name off, and only that (%j)",
    (_, { name, className, framework }) => {
      const read = readableFacts(facts({ name, className }));
      expect(read.name).toBe(framework ? "" : name);
    },
  );

  it("takes the light-dismiss layer's name off", () => {
    for (const automationId of shared.lightDismissAutomationIds)
      expect(readableFacts(facts({ name: "Close", automationId })).name).toBe("");
  });
});
