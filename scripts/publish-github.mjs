// Publishes a built release on GitHub Releases (docs/release-runbook.md#publishing):
//
//   node scripts/publish-github.mjs 1.2.3
//
// The tag v1.2.3 must already be pushed to the public repository. It creates the release with the
// version's CHANGELOG.md entry as its notes, attaches every file in release-out/<version>/download/
// (the installers, the Linux packages, the notices and SHA256SUMS.txt), then downloads each one
// from GitHub, as a visitor would, and checks its SHA-256 against SHA256SUMS.txt. Only then may the
// update manifest that points at them go to steps.amluto.com.
//
// It runs `gh` as whichever account is signed in for it; set GH_TOKEN to publish as another
// (GH_TOKEN="$(gh auth token --user amluto-solutions)").
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseAsset, releasePage, REPOSITORY } from "./lib/github.mjs";
import { changelogNotes } from "./lib/update.mjs";

const repo = join(import.meta.dirname, "..");
const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error("Usage: node scripts/publish-github.mjs <version>");
  process.exit(1);
}
const folder = join(repo, "release-out", version, "download");
if (!existsSync(folder)) {
  console.error(`No ${folder}: build the release first (npm run release -- v${version}).`);
  process.exit(1);
}

const gh = (args) => {
  const result = spawnSync("gh", args, { encoding: "utf8", shell: false });
  if (result.status !== 0)
    throw new Error(`gh ${args[0]} ${args[1] ?? ""}: ${result.stderr.trim()}`);
  return result.stdout;
};

// The expected files and their hashes, from the release's own list.
const sums = new Map(
  readFileSync(join(folder, "SHA256SUMS.txt"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+\*?/))
    .map(([hash, name]) => [name, hash]),
);
const files = readdirSync(folder).sort();
for (const name of sums.keys())
  if (!files.includes(name)) throw new Error(`${name} is in SHA256SUMS.txt but not in ${folder}`);

// The tag must be on GitHub already: the release is made from it, never from a branch.
gh(["api", `repos/${REPOSITORY}/git/ref/tags/v${version}`]);

const notes = changelogNotes(readFileSync(join(repo, "CHANGELOG.md"), "utf8"), version);
const notesFile = join(tmpdir(), `steps-${version}-notes.md`);
writeFileSync(
  notesFile,
  `${notes ?? ""}\n\nEach file's SHA-256 is in SHA256SUMS.txt. Steps is free software under the GNU GPL, version 3 or later.\n`,
);
try {
  gh([
    "release",
    "create",
    `v${version}`,
    "--repo",
    REPOSITORY,
    "--verify-tag",
    "--title",
    `Steps ${version}`,
    "--notes-file",
    notesFile,
    ...(version.includes("-") ? ["--prerelease"] : []),
    ...files.map((name) => join(folder, name)),
  ]);
} finally {
  rmSync(notesFile, { force: true });
}

// From outside, as anyone downloading it would get it.
for (const [name, hash] of sums) {
  const response = await fetch(releaseAsset(version, name), { redirect: "follow" });
  if (!response.ok) throw new Error(`${name}: GitHub answered ${response.status}`);
  const got = createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
  if (got !== hash) throw new Error(`${name} on GitHub isn't the built file (${got})`);
  console.log(`✔ ${name}`);
}
console.log(`\nPublished: ${releasePage(version)}`);
console.log("Next: SHA256SUMS.txt to steps.amluto.com/download, then the update manifest.");
