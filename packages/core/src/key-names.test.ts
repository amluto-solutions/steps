import { describe, expect, it } from "vitest";

import { keyCapName, localKeys } from "./key-names.ts";
import { renderPhrase } from "./step-text/phrase.ts";

describe("keys named as the keyboard names them", () => {
  it("says Strg in German, Maj in French, and Ctrl where keyboards say Ctrl", () => {
    expect(localKeys("Ctrl + Shift + S", "de")).toBe("Strg + Umschalt + S");
    expect(localKeys("Ctrl+Escape", "fr")).toBe("Ctrl+Échap");
    expect(localKeys("Ctrl + S", "ja")).toBe("Ctrl + S");
    expect(keyCapName("Ctrl", "xx")).toBe("Ctrl");
  });

  it("words a recorded shortcut in the guide's language", () => {
    expect(renderPhrase({ key: "press", keys: "Ctrl + S" }, "de", "casual")).toContain("Strg + S");
    expect(renderPhrase({ key: "press", keys: "Ctrl + Shift + S" }, "en", "casual")).toBe(
      'Press "Ctrl + Shift + S"',
    );
    // A shortcut Windows names says that name too, in the guide's language.
    expect(renderPhrase({ key: "press", keys: "Ctrl + S" }, "en", "casual")).toBe(
      'Press "Ctrl + S" (Save)',
    );
    expect(renderPhrase({ key: "press", keys: "Ctrl + C" }, "de", "formal")).toBe(
      "Drücken Sie Strg + C (Kopieren).",
    );
  });

  // The 10/10/2026 test (P16, #71): Ctrl + A and Ctrl + S were labelled, Ctrl + B wasn't.
  it.each([
    ["Ctrl + B", "Bold"],
    ["Ctrl + I", "Italic"],
    ["Ctrl + U", "Underline"],
    ["Ctrl + F", "Find"],
    ["Ctrl + P", "Print"],
    ["Ctrl + N", "New"],
    ["Ctrl + W", "Close tab"],
  ])("says what %s does in any app", (keys, meaning) => {
    expect(renderPhrase({ key: "press", keys }, "en", "casual")).toBe(
      `Press "${keys}" (${meaning})`,
    );
    expect(renderPhrase({ key: "press", keys, app: "notepad.exe" }, "en", "casual")).toBe(
      `Press "${keys}" (${meaning})`,
    );
  });

  it("says what Ctrl + G and Ctrl + D do in Excel, and only there", () => {
    const excel = "EXCEL.EXE";
    expect(renderPhrase({ key: "press", keys: "Ctrl + G", app: excel }, "en", "casual")).toBe(
      'Press "Ctrl + G" (Go To)',
    );
    expect(renderPhrase({ key: "press", keys: "Ctrl + D", app: "excel.exe" }, "en", "plain")).toBe(
      "Press Ctrl + D (Fill down)",
    );
    // Elsewhere they mean other things: Ctrl + D is a bookmark in a browser, Ctrl + G Find next.
    expect(
      renderPhrase({ key: "press", keys: "Ctrl + D", app: "msedge.exe" }, "en", "casual"),
    ).toBe('Press "Ctrl + D"');
    expect(renderPhrase({ key: "press", keys: "Ctrl + G" }, "en", "casual")).toBe(
      'Press "Ctrl + G"',
    );
    // Everyday shortcuts keep their meaning in Excel too.
    expect(renderPhrase({ key: "press", keys: "Ctrl + B", app: excel }, "de", "formal")).toBe(
      "Drücken Sie Strg + B (Fett).",
    );
  });
});
