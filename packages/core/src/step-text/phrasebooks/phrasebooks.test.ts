import { describe, expect, it } from "vitest";

import { LANGUAGE_CODES } from "../../languages.ts";
import type { ElementKind, LanguagePhrases, Phrasebook, PluralForms } from "../phrase.ts";
import { en } from "./en.ts";
import { PHRASEBOOKS } from "./index.ts";

const KINDS: ElementKind[] = [
  "button",
  "link",
  "menuItem",
  "tab",
  "field",
  "namedField",
  "textArea",
  "checkbox",
  "radio",
  "dropdown",
  "switch",
  "picture",
  "listItem",
  "other",
];

/** `{slots}` in a template, once each, sorted. */
const slots = (text: string) =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join();

const books = LANGUAGE_CODES.filter((code) => code !== "en").map(
  (code) => [code, PHRASEBOOKS[code]] as [string, LanguagePhrases | undefined],
);

describe("phrasebooks", () => {
  it("are one for each of Steps' languages", () => {
    expect(Object.keys(PHRASEBOOKS).sort()).toEqual([...LANGUAGE_CODES].sort());
  });
});

/**
 * Every language words every phrase in every tone, with the same `{slots}` as English and its own
 * plural forms (docs/spec/03-data-and-sharing.md#languages). `-t "de phrasebook"` checks one.
 */
describe.each(books)("%s phrasebook", (code, book) => {
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;

  it("is translated, not English's", () => {
    expect(book).not.toBe(en);
    expect(book?.plain.click.other).not.toBe(en.plain.click.other);
  });

  it.each(["casual", "plain", "formal"] as const)("has every phrase in the %s tone", (tone) => {
    const own: Phrasebook | undefined = book?.[tone];
    expect(own).toBeTruthy();
    if (!own) return;
    const problems: string[] = [];
    const reference = en.plain;
    expect(Object.keys(own).sort()).toEqual(Object.keys(reference).sort());
    for (const key of Object.keys(reference) as (keyof Phrasebook)[]) {
      const want = reference[key];
      const have = own[key] as unknown;
      if (key === "click") {
        const click = have as Record<string, string>;
        if (!click.other) problems.push("click.other: missing");
        for (const [kind, text] of Object.entries(click)) {
          if (!KINDS.includes(kind as ElementKind)) problems.push(`click.${kind}: not a kind`);
          if (slots(text) !== "name") problems.push(`click.${kind}: ${slots(text)}`);
        }
      } else if (typeof want === "string") {
        if (typeof have !== "string" || !have.trim()) problems.push(`${key}: missing`);
        else if (slots(have) !== slots(want)) problems.push(`${key}: ${slots(have)}`);
      } else {
        const forms = have as PluralForms;
        for (const category of categories)
          if (!forms[category]?.trim()) problems.push(`${key}.${category}: missing`);
        for (const [category, text] of Object.entries(forms)) {
          if (!categories.includes(category as Intl.LDMLPluralRule))
            problems.push(`${key}.${category}: not a plural form here`);
          else if (text && !["", "count"].includes(slots(text)))
            problems.push(`${key}.${category}: ${slots(text)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("names every shortcut", () => {
    expect(Object.keys(book?.shortcuts ?? {}).sort()).toEqual(Object.keys(en.shortcuts).sort());
    for (const name of Object.values(book?.shortcuts ?? {})) expect(name.trim()).toBeTruthy();
  });

  it("names the terminals", () => {
    expect(Object.keys(book?.terminals ?? {}).sort()).toEqual(["bash", "cmd", "powershell"]);
    for (const name of Object.values(book?.terminals ?? {})) expect(name.trim()).toBeTruthy();
  });
});
