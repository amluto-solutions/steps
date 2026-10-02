import { LANGUAGES, renderPhrase, type Phrase } from "@amluto-steps/core";
import { describe, expect, it } from "vitest";

import { SHOWCASE, SUPPLIER, TONES } from "./showcase";

describe("the site's showcase guide", () => {
  it.each(SHOWCASE.map((language) => [language.code, language] as const))(
    "%s is worded as the app words it",
    (code, language) => {
      const { contacts, newSupplier, supplierName, save } = language.labels;
      const phrases: Phrase[] = [
        { key: "click", kind: "menuItem", name: contacts },
        { key: "click", kind: "button", name: newSupplier },
        { key: "typeValueInField", value: SUPPLIER, field: supplierName },
        { key: "click", kind: "button", name: save },
      ];
      for (const { id } of TONES) {
        expect(language.steps[id]).toEqual(phrases.map((phrase) => renderPhrase(phrase, code, id)));
      }
    },
  );

  it("names each language as Steps lists it", () => {
    for (const language of SHOWCASE) {
      expect(LANGUAGES.find((item) => item.code === language.code)?.name).toBe(language.name);
    }
  });
});
