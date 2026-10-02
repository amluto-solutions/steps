import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import en from "../../../packages/ui/src/locales/en.json";

// Every error code the Rust side can send has words in en.json, so no Rust-written sentence
// reaches the user as it is (UI text comes from en.json).
const tauri = fileURLToPath(new URL("../src-tauri/", import.meta.url));
const rustFiles = (folder: string): string[] =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory())
      return ["target", "vendor"].includes(name) ? [] : rustFiles(path);
    return name.endsWith(".rs") ? [path] : [];
  });

const codes = new Set<string>();
for (const file of rustFiles(tauri)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/CommandError::new\(\s*"([A-Za-z]+)"/g))
    codes.add(match[1] ?? "");
  for (const match of text.matchAll(/\bcode: "([A-Za-z]+)"/g)) codes.add(match[1] ?? "");
}
const library = readFileSync(join(tauri, "crates/library/src/error.rs"), "utf8");
for (const match of library.matchAll(/=> "([A-Za-z]+)"/g)) codes.add(match[1] ?? "");

describe("Rust error codes", () => {
  it("all have words in en.json", () => {
    expect(codes.size).toBeGreaterThan(50);
    const worded = new Set(Object.keys(en.errors));
    expect([...codes].filter((code) => !worded.has(code)).sort()).toEqual([]);
  });
});
