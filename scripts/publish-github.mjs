// Publishes a built release on GitHub Releases (docs/release-runbook.md#publishing):
//
//   node scripts/publish-github.mjs 1.2.3            a new release
//   node scripts/publish-github.mjs 1.2.3 --replace  the same version rebuilt: its files replaced
//                                                    in place and its notes refreshed
//
// The tag v1.2.3 must already be pushed to the public repository. It creates the release with the
// version's CHANGELOG.md entry as its notes, attaches every file in release-out/<version>/download/
// (the installers, the Linux packages, the notices and SHA256SUMS.txt), then downloads each one
// from GitHub, as a visitor would, and checks its SHA-256 against SHA256SUMS.txt. Only then may the
// update manifest that points at them go to steps.amluto.com.
//
// It publishes as the amluto-solutions account (gh's token for it), or as whichever account
// GH_TOKEN names.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseAsset, releasePage, REPOSITORY } from "./lib/github.mjs";
import { changelogNotes } from "./lib/update.mjs";

const repo = join(import.meta.dirname, "..");
const version = process.argv[2]?.replace(/^v/, "");
const replace = process.argv.includes("--replace");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error("Usage: node scripts/publish-github.mjs <version> [--replace]");
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

// The amluto-solutions account's token, unless GH_TOKEN names one: the release lives on its
// repository, and a plain `node scripts/publish-github.mjs` is easier to allow than an export.
if (!process.env.GH_TOKEN) {
  const token = spawnSync("gh", ["auth", "token", "--user", "amluto-solutions"], {
    encoding: "utf8",
    shell: false,
  });
  if (token.status !== 0 || !token.stdout.trim()) {
    console.error("Sign gh in as amluto-solutions first (gh auth login), or set GH_TOKEN.");
    process.exit(1);
  }
  process.env.GH_TOKEN = token.stdout.trim();
}

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
const exists =
  spawnSync("gh", ["release", "view", `v${version}`, "--repo", REPOSITORY], { shell: false })
    .status === 0;
if (exists !== replace)
  throw new Error(
    exists
      ? `v${version} is already released: add --replace to put this build's files in its place`
      : `v${version} has no release to replace: leave out --replace`,
  );
try {
  if (replace) {
    // A rebuild of a version not yet announced (05/10/2026: 1.0.0 was rebuilt three times):
    // the same names, so the download page and the update manifest still point at them.
    gh(["release", "edit", `v${version}`, "--repo", REPOSITORY, "--notes-file", notesFile]);
    gh([
      "release",
      "upload",
      `v${version}`,
      "--repo",
      REPOSITORY,
      "--clobber",
      ...files.map((name) => join(folder, name)),
    ]);
  } else
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
console.log(`Next: node scripts/publish-site.mjs ${version}`);
