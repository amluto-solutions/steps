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
    expect(renderPhrase({ key: "press", keys: "Ctrl + S" }, "en", "casual")).toBe(
      'Press "Ctrl + S"',
    );
  });
});
