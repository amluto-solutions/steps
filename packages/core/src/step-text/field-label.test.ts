import { describe, expect, it } from "vitest";

import { nameClick } from "./click-naming.ts";
import { wordStepIn } from "./reword.ts";
import type { UiaElementFacts } from "./types.ts";
import { describeInput } from "./uia-adapter.ts";
import { wordStep } from "./wording.ts";

/** A Win32 edit box, named by the label beside it. */
const edit = (name: string): UiaElementFacts => ({
  controlType: "Edit",
  localizedControlType: "",
  name,
  automationId: "",
  helpText: "",
  ariaRole: "",
  ariaProperties: "",
  className: "",
  frameworkId: "Win32",
  isPassword: false,
  labeledBy: null,
  ancestors: [],
  sensitive: false,
});

describe("a field label's trailing colon (#100)", () => {
  it("comes off a value read when focus leaves", () => {
    expect(describeInput(edit("File name:"), "Holiday")).toBe(
      'Type "Holiday" in "File name" field',
    );
  });

  it("comes off with the space before it and in full width, in the guide's language", () => {
    // French quotes hold their words with no-break spaces.
    expect(
      describeInput(edit("Nom du fichier :"), "Vacances", { language: "fr", tone: "casual" }),
    ).toMatch(/^Taper «\s?Vacances\s?» dans le champ «\s?Nom du fichier\s?»$/u);
    expect(describeInput(edit("ファイル名："), "休暇", { language: "ja", tone: "casual" })).toBe(
      "「ファイル名」フィールドに「休暇」と入力",
    );
  });

  it("comes off typed values, a withheld value and a drop-down's label", () => {
    const field = { tagName: "INPUT", labelText: "User name: " };
    expect(wordStep("input", { ...field, value: "robin" })).toBe(
      'Type "robin" in "User name" field',
    );
    expect(wordStep("input", field)).toBe('Type in "User name" field');
    expect(wordStep("input", { tagName: "SELECT", labelText: "Save as type:", value: "PNG" })).toBe(
      'Choose "PNG" in "Save as type"',
    );
  });

  it("stays on a label that is only a colon, and inside a label", () => {
    expect(wordStep("input", { tagName: "INPUT", labelText: ":" })).toBe('Type in ":" field');
    expect(wordStep("input", { tagName: "INPUT", labelText: "Time (hh:mm)" })).toBe(
      'Type in "Time (hh:mm)" field',
    );
  });

  it("comes off a saved step reworded in another tone", () => {
    const stored = {
      kind: "interaction",
      action: "input",
      actionText: 'Type "Holiday" in "File name:" field',
      textParts: { verb: "Type", target: "File name:", kind: "field", value: "Holiday" },
      showValue: true,
      context: { windowTitle: "Save As" },
      target: { tagName: "INPUT", labelText: "File name:" },
    };
    expect(wordStepIn(stored, "en", "formal")).toBe('In the "File name" field, type "Holiday".');
  });

  it("leaves click names as they are", () => {
    const naming = nameClick({
      element: edit("File name:"),
      window: { title: "Save As", exe: null },
    });
    expect(naming.name).toBe("File name:");
  });
});
