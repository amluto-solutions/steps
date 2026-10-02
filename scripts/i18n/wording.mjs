#!/usr/bin/env node
/**
 * Keeps the app's wording in every language (packages/ui/src/locales/<code>.json) in step with
 * English. Each language must have every English text (packages/ui/src/locales/locales.test.ts),
 * so a new or changed text is translated in the same commit:
 *
 *   node scripts/i18n/wording.mjs missing de            English texts German hasn't, as JSON
 *   node scripts/i18n/wording.mjs merge de part.json…   adds translated texts to German
 *   node scripts/i18n/wording.mjs same de               German texts still the same as English
 *
 * `merge` takes JSON shaped like en.json (any part of it), keeps English's order, and drops keys
 * English hasn't; counted texts need the language's own plural forms (`_one`, `_few`, `_other`…,
 * from Intl.PluralRules).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const folder = new URL("../../packages/ui/src/locales/", import.meta.url);
const PLURAL = /_(zero|one|two|few|many|other)$/;

const load = (code) => {
  const url = new URL(`${code}.json`, folder);
  return existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : {};
};
const english = load("en");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** English's tree with each counted text in `code`'s plural forms (from its `_other`). */
function shapeFor(code) {
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  const walk = (tree) => {
    const out = {};
    for (const [key, value] of Object.entries(tree)) {
      if (isObject(value)) out[key] = walk(value);
      else if (PLURAL.test(key)) {
        const base = key.replace(PLURAL, "");
        const other = tree[`${base}_other`] ?? value;
        for (const category of categories) out[`${base}_${category}`] ??= other;
      } else out[key] = value;
    }
    return out;
  };
  return walk(english);
}

/** `own` in `shape`'s order, with only `shape`'s keys. */
function ordered(shape, own) {
  const out = {};
  for (const [key, value] of Object.entries(shape)) {
    if (!(key in own)) continue;
    if (isObject(value)) {
      if (isObject(own[key])) {
        const inner = ordered(value, own[key]);
        if (Object.keys(inner).length) out[key] = inner;
      }
    } else if (typeof own[key] === "string") out[key] = own[key];
  }
  return out;
}

function deepMerge(into, from) {
  for (const [key, value] of Object.entries(from)) {
    if (isObject(value)) into[key] = deepMerge(isObject(into[key]) ? into[key] : {}, value);
    else into[key] = value;
  }
  return into;
}

/** The parts of `shape` that `own` hasn't got. */
function missing(shape, own) {
  const out = {};
  for (const [key, value] of Object.entries(shape)) {
    if (isObject(value)) {
      const inner = missing(value, isObject(own?.[key]) ? own[key] : {});
      if (Object.keys(inner).length) out[key] = inner;
    } else if (typeof own?.[key] !== "string") out[key] = value;
  }
  return out;
}

/** Texts in `own` that are word for word English's (longer than a word or two). */
function same(shape, own, prefix, into) {
  for (const [key, value] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(value)) same(value, own?.[key], path, into);
    else if (own?.[key] === value && /\s\S+\s/.test(value)) into.push(`${path}: ${value}`);
  }
  return into;
}

const [command, code, ...files] = process.argv.slice(2);
if (!code || code === "en") {
  console.error("Usage: wording.mjs missing|merge|same <code> [part.json…]");
  process.exit(1);
}
const shape = shapeFor(code);
if (command === "missing") {
  console.log(JSON.stringify(missing(shape, load(code)), null, 2));
} else if (command === "merge") {
  let merged = load(code);
  for (const file of files) merged = deepMerge(merged, JSON.parse(readFileSync(file, "utf8")));
  const result = ordered(shape, merged);
  writeFileSync(new URL(`${code}.json`, folder), `${JSON.stringify(result, null, 2)}\n`);
  const left = JSON.stringify(missing(shape, result)).match(/":"/g)?.length ?? 0;
  console.log(`${code}.json written; ${left} texts still to translate.`);
} else if (command === "same") {
  console.log(same(shape, load(code), "", []).join("\n") || "None.");
} else {
  console.error(`Unknown command ${command}.`);
  process.exit(1);
}
