import { describe, expect, it } from "vitest";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { GuideConflict } from "@amluto-steps/ui";

import expected from "../../../../packages/core/test-vectors/library-folder.expected.json";
import type { ImageCodec } from "../library/images";

import { listComments } from "./comments";
import { memoryDir, type Dir } from "./dir";
import { listVersions } from "./history";
import { FolderLibrary } from "./library";
import { listConflicts, listDrafts, mayWrite, readLock } from "./sharing";

/**
 * The shared library in `packages/core/test-vectors/library-folder`, as the desktop writes one,
 * read by Steps for Chrome. The desktop reads the same folder in
 * `crates/library/tests/library_folder.rs`; both must give `library-folder.expected.json`.
 */

const FIXTURE = join(import.meta.dirname, "../../../../packages/core/test-vectors/library-folder");

/** The fixture's files, loaded into folders in memory. */
async function load(from: string, into: Dir) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await load(join(from, entry.name), await into.makeFolder(entry.name));
    else await into.write(entry.name, new Uint8Array(readFileSync(join(from, entry.name))));
  }
}

const noCodec = {} as ImageCodec;

const summary = (conflict: GuideConflict) =>
  conflict.kind === "step"
    ? { kind: "step", file: conflict.file, id: conflict.id, from: conflict.from }
    : conflict.kind === "guide"
      ? { kind: "guide", file: conflict.file, from: conflict.from }
      : { kind: "restored", id: conflict.id, deletedBy: conflict.deletedBy };

describe("the shared library fixture", () => {
  it("reads as the desktop reads it", async () => {
    const root = memoryDir();
    await load(FIXTURE, root);
    const library = new FolderLibrary(root, noCodec);

    expect(await library.guideCount()).toBe(expected.guideCount);
    expect(await library.listGuides()).toEqual(expected.guides);
    expect((await listConflicts(library, "payroll")).map(summary)).toEqual(expected.conflicts);
    expect(await listComments(library, "payroll", { name: "Robin Hale", pc: "ROBINS-PC" })).toEqual(
      expected.commentsForRobin,
    );
    expect(await listVersions(library, "payroll")).toEqual(expected.versions);
    expect(await listDrafts(library, "payroll")).toEqual(expected.drafts);
    expect(await readLock(library, "payroll")).toEqual(expected.lock);
    expect(await mayWrite(library, "payroll", "robin-session")).toBe(false);
    expect(await library.listTrash()).toEqual(expected.trash);
    expect(await library.search("supplier")).toEqual(expected.searchSupplier);
  });
});
