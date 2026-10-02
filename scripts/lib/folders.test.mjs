import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  folderBytes,
  folderDifferences,
  oldReleases,
  removeFolder,
  staleTemporaries,
} from "./folders.mjs";

const made = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A temporary folder holding `files` ({ "a/b.txt": "text" }). */
function folder(files) {
  const root = mkdtempSync(join(tmpdir(), "folders-test-"));
  made.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

describe("folder sizes and comparisons", () => {
  it("adds up every file, nested or not", () => {
    expect(folderBytes(folder({ "a.txt": "12345", "b/c.txt": "123" }))).toBe(8);
    expect(folderBytes(join(tmpdir(), "no-such-folder-here"))).toBe(0);
  });

  it("finds missing, extra and changed files, and nothing in a copy", () => {
    const built = folder({ "manifest.json": "{}", "assets/app.js": "one" });
    expect(
      folderDifferences(built, folder({ "manifest.json": "{}", "assets/app.js": "one" })),
    ).toEqual([]);
    expect(folderDifferences(built, folder({ "manifest.json": "{ }", "extra.js": "" }))).toEqual([
      "assets/app.js is missing",
      "manifest.json differs",
      "extra.js is extra",
    ]);
  });

  it("removes a folder and everything in it", () => {
    const root = folder({ "deep/er/file.txt": "x" });
    expect(removeFolder(root)).toBe(true);
    expect(folderBytes(root)).toBe(0);
  });
});

describe("tidying up", () => {
  it("keeps the newest releases by version, not by name, and leaves other folders alone", () => {
    const names = ["0.2.10", "0.2.9", "0.5.1", "0.4.2", "msix", "0.10.0"];
    expect(oldReleases(names, 2)).toEqual(["0.4.2", "0.2.10", "0.2.9"]);
    expect(oldReleases(["0.5.1"], 2)).toEqual([]);
  });

  it("finds only our own temporary folders, and only once they've been left for long enough", () => {
    const hour = 60 * 60 * 1000;
    const now = 100 * hour;
    const entries = [
      { name: "amluto-steps-release-0.5.0-1", modified: now - 30 * hour },
      { name: "amluto-steps-release-0.5.1-2", modified: now - hour },
      { name: "someone-elses-folder", modified: 0 },
    ];
    expect(staleTemporaries(entries, ["amluto-steps-release-"], now, 12 * hour)).toEqual([
      "amluto-steps-release-0.5.0-1",
    ]);
  });
});
