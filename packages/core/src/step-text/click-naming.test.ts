import { describe, expect, it } from "vitest";

import table from "./click-naming.cases.json";
import {
  clickPhrase,
  nameClick,
  namingOfStep,
  type ClickEvidence,
  type ClickNaming,
} from "./click-naming.ts";
import { renderPhrase, TONES } from "./phrase.ts";
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
  };
  naming: ClickNaming;
  text: string;
}

const evidenceOf = ({ element, window, page, screen }: Case["evidence"]): ClickEvidence => ({
  element: element && { ...BLANK, ...element },
  window,
  ...(page ? { page } : {}),
  ...(screen ? { screen } : {}),
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

  it("doesn't take a button whose name mentions the taskbar for a taskbar click", () => {
    const step = {
      ...olderTaskbarClick('Click "Pin on the taskbar"'),
      textParts: { target: "Pin on the taskbar", kind: "button" },
      target: { tagName: "BUTTON", innerText: "Pin on the taskbar" },
    };
    expect(namingOfStep(step).source).toBe("element");
  });
});
