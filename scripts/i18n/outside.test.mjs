import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { OUTSIDE } from "./languages.mjs";

/**
 * Steps' words outside the app, in every language (01/10/2026): the setup .exe, the
 * extension's name and description, and the store listings to paste. `-t "de "` checks one.
 */
const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const codes = Object.keys(OUTSIDE).filter((code) => code !== "en");

// ----- The setup .exe (apps/desktop/src-tauri/nsis) -----

/** Each `LangString` in an NSIS language file: its id, the language it's for, and its text. */
function langStrings(text) {
  const strings = new Map();
  for (const match of text.matchAll(/^LangString (\w+) \$\{LANG_(\w+)\} "(.*)"[ \t]*\r?$/gm))
    strings.set(match[1], { language: match[2], text: match[3] });
  return strings;
}
/** What NSIS and Tauri fill in or read specially: `${DEFINES}`, `{{slots}}`, `$R4`, `$0`, `$\n`. */
const tokens = (text) =>
  [...new Set([...text.matchAll(/\$\{\w+\}|\{\{\w+\}\}|\$R\d|\$\d|\$\\n/g)].map((m) => m[0]))]
    .sort()
    .join(" ");
const english = langStrings(read("apps/desktop/src-tauri/nsis/English.nsh"));

describe("the setup's languages", () => {
  it("are each in tauri.conf.json, with their own file", () => {
    const nsis = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).bundle.windows.nsis;
    const files = readdirSync(new URL("apps/desktop/src-tauri/nsis/", root))
      .filter((name) => name.endsWith(".nsh"))
      .map((name) => name.replace(/\.nsh$/, ""))
      .sort();
    expect(Object.keys(nsis.customLanguageFiles).sort()).toEqual(files);
    expect([...(nsis.languages ?? ["English"])].sort()).toEqual(files);
    for (const [name, path] of Object.entries(nsis.customLanguageFiles))
      expect(path).toBe(`nsis/${name}.nsh`);
  });
});

describe.each(codes.filter((code) => OUTSIDE[code].nsis))("%s setup", (code) => {
  const name = OUTSIDE[code].nsis;
  const path = `apps/desktop/src-tauri/nsis/${name}.nsh`;

  it("has every message English has, with the same things filled in", () => {
    expect(existsSync(new URL(path, root))).toBe(true);
    const own = langStrings(read(path));
    const problems = [];
    for (const [id, { text }] of english) {
      const mine = own.get(id);
      if (!mine) problems.push(`${id}: missing`);
      else if (mine.language !== name.toUpperCase()) problems.push(`${id}: LANG_${mine.language}`);
      else if (tokens(mine.text) !== tokens(text)) problems.push(`${id}: ${tokens(mine.text)}`);
      // A quotation mark inside the text must be written $\" or the string ends there.
      else if (mine.text.replace(/\$\\"/g, "").includes('"')) problems.push(`${id}: bare "`);
    }
    for (const id of own.keys()) if (!english.has(id)) problems.push(`${id}: not in English`);
    expect(problems).toEqual([]);
  });
});

// ----- The extension's name and description (apps/chrome/public/_locales) -----

const messages = (folder) =>
  JSON.parse(read(`apps/chrome/public/_locales/${folder}/messages.json`));
const englishMessages = messages("en");

describe("the extension's languages", () => {
  it("are the browsers' own codes for Steps' languages", () => {
    const folders = readdirSync(new URL("apps/chrome/public/_locales/", root)).sort();
    const expected = Object.values(OUTSIDE)
      .map((item) => item.extension)
      .filter(Boolean)
      .sort();
    expect(folders).toEqual(expected);
  });
});

describe.each(codes.filter((code) => OUTSIDE[code].extension))("%s extension", (code) => {
  it("has a name and descriptions that fit the stores", () => {
    const own = messages(OUTSIDE[code].extension);
    expect(Object.keys(own).sort()).toEqual(Object.keys(englishMessages).sort());
    for (const [key, entry] of Object.entries(own)) {
      expect(entry.message.trim(), key).toBeTruthy();
      // The stores' limits: a name of 75 characters, a description of 132.
      expect(entry.message.length, key).toBeLessThanOrEqual(key === "extName" ? 75 : 132);
      expect(entry.message, key).not.toMatch(/\$/);
    }
  });
});

// ----- The store listings to paste (store/listings) -----

/** A listing's sections (each "### …"), with the lines under each. */
function sections(text) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^### /.test(line)) found.push([]);
    else found.at(-1)?.push(line);
  }
  return found;
}
/** The text of the fenced block in a section, or null. */
function fenced(lines) {
  const start = lines.findIndex((line) => line.startsWith("```"));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("```"));
  return start < 0 || end < 0 ? null : lines.slice(start + 1, end).join("\n");
}
const englishBlocks = sections(read("store/listings/en.md")).map(fenced);
/** Each section's limit in characters, in the order en.md has them. */
const LIMITS = [
  10000, // Microsoft Store: description
  1500, // what's new
  null, // product features: each line up to 200
  null, // screenshot captions: each line up to 200
  null, // search terms: up to 7, each up to 30
  132, // Chrome Web Store and Edge: summary
  16000, // description
  250, // Firefox: summary
  null, // Firefox: added to the description
];

describe.each(codes)("%s store listing", (code) => {
  const path = `store/listings/${code}.md`;

  it("has every section English has, in the stores' limits", () => {
    expect(existsSync(new URL(path, root))).toBe(true);
    const blocks = sections(read(path)).map(fenced);
    expect(blocks.length).toBe(englishBlocks.length);
    blocks.forEach((block, index) => {
      expect(block, `section ${index + 1}`).not.toBeNull();
      const limit = LIMITS[index];
      if (limit) expect((block ?? "").length, `section ${index + 1}`).toBeLessThanOrEqual(limit);
    });
    for (const index of [2, 3]) {
      const lines = (blocks[index] ?? "").split("\n").filter(Boolean);
      const want = (englishBlocks[index] ?? "").split("\n").filter(Boolean);
      expect(lines.length, `section ${index + 1}`).toBe(want.length);
      for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(200);
    }
    const terms = (blocks[4] ?? "").split("\n").filter(Boolean);
    expect(terms.length).toBeLessThanOrEqual(7);
    for (const term of terms) expect(term.length, term).toBeLessThanOrEqual(30);
  });
});

// ----- The Microsoft Store package (apps/desktop/msix/AppxManifest.xml) -----

describe("the Store package", () => {
  it("declares every language, English first, so each can have a Store listing", () => {
    const manifest = read("apps/desktop/msix/AppxManifest.xml");
    const declared = [...manifest.matchAll(/<Resource Language="([^"]+)"/g)].map((m) => m[1]);
    expect(declared).toEqual(Object.values(OUTSIDE).map((item) => item.store));
  });
});
