// Puts a published release's files on steps.amluto.com, last of all (docs/release-runbook.md):
//
//   node scripts/publish-site.mjs 1.2.3
//
// SHA256SUMS.txt goes into /download (the download page reads it), then release.json and
// .htaccess from release-out/<version>/update/ into /update (a pre-release has none, and the
// installed copies keep the version they have). Each is then fetched from the site, plain and with
// a cache-busting query, and must be byte for byte what was built. The server and key come from
// apps/website/scripts/deploy.local.json, as for the website's own deploy.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error("Usage: node scripts/publish-site.mjs <version>");
  process.exit(1);
}
const out = join(repo, "release-out", version);
const config = join(repo, "apps", "website", "scripts", "deploy.local.json");
if (!existsSync(config)) {
  console.error(`No ${config}: see apps/website/scripts/deploy.mjs.`);
  process.exit(1);
}
const { host, port, key, site } = JSON.parse(readFileSync(config, "utf8"));
// The key is named in the config and kept with the user's SSH keys.
const keyPath = join(homedir(), ".ssh", key);

const uploads = [{ file: join(out, "download", "SHA256SUMS.txt"), to: "download" }];
if (existsSync(join(out, "update", "release.json")))
  uploads.push(
    { file: join(out, "update", "release.json"), to: "update" },
    { file: join(out, "update", ".htaccess"), to: "update" },
  );
for (const { file } of uploads)
  if (!existsSync(file)) throw new Error(`No ${file}: build the release first.`);

for (const { file, to } of uploads) {
  const result = spawnSync(
    "scp",
    [
      "-q",
      "-o",
      "BatchMode=yes",
      "-P",
      String(port),
      "-i",
      keyPath,
      file,
      `${host}:${site}/${to}/`,
    ],
    { encoding: "utf8", shell: false },
  );
  if (result.status !== 0) throw new Error(`scp ${file}: ${result.stderr.trim()}`);
}

// .htaccess isn't served; the other two must be, as built, even where a cache sits in front.
for (const { file, to } of uploads.filter(({ file }) => !file.endsWith(".htaccess"))) {
  const name = file.split(/[\\/]/).at(-1);
  const want = readFileSync(file);
  for (const query of ["", `?fresh=${Date.now()}`]) {
    const url = `https://steps.amluto.com/${to}/${name}${query}`;
    const response = await fetch(url);
    const got = Buffer.from(await response.arrayBuffer());
    if (!response.ok || !got.equals(want))
      throw new Error(
        `${url} isn't the built file (${response.status}): purge the cache (Site Tools → Speed → Caching) and run this again`,
      );
  }
  console.log(`✔ ${to}/${name}`);
}
console.log(`\nsteps.amluto.com has ${version}.`);
