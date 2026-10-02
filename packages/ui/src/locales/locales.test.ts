import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every key of every object in some JSON text that appears twice in that same object. */
function repeatedKeys(source: string): string[] {
  const repeated: string[] = [];
  const stack: Set<string>[] = [];
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"\s*:|[{}]/g)) {
    if (match[0] === "{") stack.push(new Set());
    else if (match[0] === "}") stack.pop();
    else {
      const keys = stack.at(-1);
      const key = match[1] ?? "";
      if (keys?.has(key)) repeated.push(key);
      keys?.add(key);
    }
  }
  return repeated;
}

/**
 * JSON keeps the last of two keys with the same name without a word, so a second "page" in the
 * export wording silently replaced the page options' heading (29/09/2026).
 */
describe("the wording file", () => {
  it("has no key twice in the same place", () => {
    expect(repeatedKeys('{"a": {"b": 1, "b": 2}, "c": {"b": 3}}')).toEqual(["b"]);
    expect(repeatedKeys(readFileSync(new URL("./en.json", import.meta.url), "utf8"))).toEqual([]);
  });
});

type Tree = { [key: string]: string | Tree };

const read = (code: string): string =>
  readFileSync(new URL(`./${code}.json`, import.meta.url), "utf8");

/** Every string in a wording file, by its dotted path. */
function leaves(tree: Tree, prefix = "", into = new Map<string, unknown>()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") leaves(value, path, into);
    else into.set(path, value);
  }
  return into;
}

const PLURAL = /_(zero|one|two|few|many|other)$/;
/** `{{slots}}` in a string, once each, sorted. */
const slots = (text: string) =>
  [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]))].sort();

const english = leaves(JSON.parse(read("en")) as Tree);
/** English's counted words, by their path without the plural ending, with their `other` form. */
const counted = new Map<string, string>();
for (const [path, value] of english)
  if (PLURAL.test(path)) {
    const base = path.replace(PLURAL, "");
    if (path.endsWith("_other") || !counted.has(base)) counted.set(base, String(value));
  }

const languages = readdirSync(new URL(".", import.meta.url))
  .filter((name) => name.endsWith(".json") && name !== "en.json")
  .map((name) => name.replace(/\.json$/, ""));

/**
 * Each language has every one of English's words (01/10/2026: the app in 38 languages, step
 * text too), with its own plural forms and the same `{{slots}}`, and nothing English hasn't.
 * `npx vitest run packages/ui/src/locales -t "de wording"` checks one.
 */
describe.each(languages)("%s wording", (code) => {
  const source = read(code);
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;

  it("is JSON with no key twice in the same place", () => {
    expect(() => JSON.parse(source) as unknown).not.toThrow();
    expect(repeatedKeys(source)).toEqual([]);
  });

  it("has every word English has, in each plural form the language uses", () => {
    const own = leaves(JSON.parse(source) as Tree);
    const missing: string[] = [];
    for (const [path] of english) {
      if (PLURAL.test(path)) continue;
      if (!own.has(path)) missing.push(path);
    }
    for (const base of counted.keys())
      for (const category of categories)
        if (!own.has(`${base}_${category}`)) missing.push(`${base}_${category}`);
    expect(missing).toEqual([]);
  });

  it("has nothing English hasn't, and keeps each text's {{slots}}", () => {
    const own = leaves(JSON.parse(source) as Tree);
    const extra: string[] = [];
    const wrong: string[] = [];
    for (const [path, value] of own) {
      if (typeof value !== "string" || !value.trim()) {
        wrong.push(`${path}: empty`);
        continue;
      }
      const base = path.replace(PLURAL, "");
      const plural = PLURAL.test(path) && counted.has(base);
      const original = plural ? counted.get(base) : english.get(path);
      if (
        original === undefined ||
        (plural && !categories.includes(path.split("_").at(-1) as Intl.LDMLPluralRule))
      ) {
        extra.push(path);
        continue;
      }
      const want = slots(String(original));
      const have = slots(value);
      // A singular may say "a minute" rather than "1 minute"; every other slot stays.
      const fits = plural
        ? have.every((slot) => want.includes(slot)) &&
          want.every((slot) => slot === "count" || have.includes(slot))
        : want.join() === have.join();
      if (!fits) wrong.push(`${path}: ${have.join(",")} instead of ${want.join(",")}`);
    }
    expect(extra).toEqual([]);
    expect(wrong).toEqual([]);
  });
});
