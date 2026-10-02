import { describe, expect, it } from "vitest";
import { CODE_LANGUAGE_LABELS, LANGUAGE_CODES, type PluralForms } from "@amluto-steps/core";

import { en } from "./en";
import { EXPORT_WORD_TEMPLATES } from "./index";
import type { ExportWordTemplates } from "./types";

/** `{slots}` in a template, once each, sorted. */
const slots = (text: string) =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join();

const tables = LANGUAGE_CODES.filter((code) => code !== "en").map(
  (code) => [code, EXPORT_WORD_TEMPLATES[code]] as [string, ExportWordTemplates | undefined],
);

describe("export words", () => {
  it("are one table for each of Steps' languages", () => {
    expect(Object.keys(EXPORT_WORD_TEMPLATES).sort()).toEqual([...LANGUAGE_CODES].sort());
  });
});

const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const isPlural = (value: object) =>
  "other" in value && Object.keys(value).every((key) => PLURAL_CATEGORIES.includes(key));

/**
 * Every language has every export word, with English's `{slots}` and its own plural forms
 * (docs/spec/05-export.md#languages). `-t "de export words"` checks one.
 */
describe.each(tables)("%s export words", (code, table) => {
  const categories: string[] = new Intl.PluralRules(code).resolvedOptions().pluralCategories;

  it("is translated, not English's", () => {
    expect(table).not.toBe(en);
    expect(table?.beforeYouStart).not.toBe(en.beforeYouStart);
  });

  it("has every word, with the same slots", () => {
    const problems: string[] = [];
    const walk = (want: unknown, have: unknown, path: string) => {
      if (typeof want === "string") {
        if (typeof have !== "string" || !have.trim()) problems.push(`${path}: missing`);
        else if (slots(have) !== slots(want)) problems.push(`${path}: ${slots(have)}`);
        return;
      }
      if (!have || typeof have !== "object") {
        problems.push(`${path}: missing`);
        return;
      }
      if (path === "codeLabels") {
        for (const [language, label] of Object.entries(have as Record<string, string>))
          if (!(language in CODE_LANGUAGE_LABELS) || !label.trim())
            problems.push(`codeLabels.${language}`);
        return;
      }
      if (want && typeof want === "object" && isPlural(want)) {
        const forms = have as PluralForms;
        const other = (want as PluralForms).other;
        for (const category of categories)
          if (!forms[category as Intl.LDMLPluralRule]?.trim())
            problems.push(`${path}.${category}: missing`);
        for (const [category, text] of Object.entries(forms)) {
          if (!categories.includes(category)) problems.push(`${path}.${category}: not used here`);
          else if (
            text &&
            ![
              slots(other),
              slots(other)
                .replace(/(^|,)count(,|$)/, "$1")
                .replace(/,$/, ""),
            ].includes(slots(text))
          )
            problems.push(`${path}.${category}: ${slots(text)}`);
        }
        return;
      }
      const wantKeys = Object.keys(want as object).sort();
      const haveKeys = Object.keys(have).sort();
      if (wantKeys.join() !== haveKeys.join()) problems.push(`${path}: keys ${haveKeys.join(",")}`);
      for (const key of wantKeys)
        walk(
          (want as Record<string, unknown>)[key],
          (have as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
    };
    walk(en, table, "");
    expect(problems).toEqual([]);
  });
});
