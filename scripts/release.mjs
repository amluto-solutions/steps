// `npm run release -- v1.2.3`: builds a release from a clean clone of a tagged commit
// (decision D4; docs/engineering.md#gates, docs/spec/10-distribution.md#release-checks).
//
// It never builds from this working copy: it clones the tag into a new temporary folder, installs
// from the lockfiles, runs the full gate there, builds every installer, checks them, and writes
// the artefacts, checksums, SBOMs, notices and the provenance record back here:
//   release-out/<version>/…      the files to publish (git-ignored)
//   release-out/<version>/browser/ the extension for the Chrome Web Store, Edge Add-ons and
//                                addons.mozilla.org (with its sources, rebuilt to check them)
//   release-out/<version>/download/ the files for the GitHub Release (scripts/publish-github.mjs)
//   release-out/<version>/update/ the manifest for steps.amluto.com/update (not for pre-releases)
//   releases/<version>.md        the provenance record, to review and commit
// Anything that fails stops the release. The manual steps are printed at the end.
//
// It tidies up after itself: its temporary folders go however it ends (and any left by a release
// that was killed are removed at the start), the clone's development build goes once the gate has
// passed, and release-out keeps only the newest two versions (the rest are published already).
//
// The updater key (docs/release-runbook.md#the-updater-key) signs the setup .exe. It is read from
// %USERPROFILE%\.tauri\amluto-steps.key (or AMLUTO_UPDATER_KEY), its password is asked for (or
// taken from TAURI_SIGNING_PRIVATE_KEY_PASSWORD), and both reach only the one build that signs,
// through environment variables: never the command line, the repo or the clone.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestProblems } from "./lib/extension.mjs";
import { releaseAsset, releasePage, REPOSITORY } from "./lib/github.mjs";
import {
  filesIn,
  folderBytes,
  folderDifferences,
  oldReleases,
  removeFolder,
  staleTemporaries,
} from "./lib/folders.mjs";
import { parsePublicKey, signedVersion, verifySignature } from "./lib/minisign.mjs";
import { identityProblems } from "./lib/msix.mjs";
import {
  ATTRIBUTIONS_PATH,
  npmPackages,
  renderAttributions,
  renderNotices,
  rustPackages,
} from "./lib/notices.mjs";
import { peImports } from "./lib/pe.mjs";
import { unstampFile } from "./lib/stamp.mjs";
import { changelogNotes, latestJson, UPDATE_HTACCESS } from "./lib/update.mjs";
import { msiCodes, PACKAGE_ID, wingetManifests } from "./lib/winget.mjs";

// No trailing separator: a path ending in a backslash would escape its closing quote.
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const tag = args.find((arg) => !arg.startsWith("--"));
const keepClone = args.includes("--keep-clone");
// The Linux beta's .deb and AppImage too, built in WSL from the same tag (scripts/linux/release.sh).
const linux = args.includes("--linux");

const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
/**
 * The updater key's password (and any key given in the environment) is kept out of every command
 * except the two that sign, which get it through `secrets`. Otherwise `npm ci` in the clone (where
 * packages run install scripts) and every Rust build script would see it.
 */
const SIGNING_VARIABLES = new Set([
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
]);
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !SIGNING_VARIABLES.has(key.toUpperCase())),
  ),
  [pathKey]: [join(homedir(), ".cargo", "bin"), process.env[pathKey]].join(delimiter),
};

/** The temporary clone, once made. */
let work = null;
/**
 * Every temporary folder this release makes (the clone, the key check, the unzipped extension):
 * removed on the way out, however the release ends. node_modules and target make the clone and the
 * Firefox sources' rebuild gigabytes, so a failed or stopped release mustn't leave them.
 */
const temporaries = [];
const TEMPORARY_PREFIXES = [
  "amluto-steps-release-",
  "amluto-steps-key-check-",
  "amluto-steps-firefox-sources-",
];
process.on("exit", () => {
  for (const folder of temporaries) {
    if (!existsSync(folder)) continue;
    if (keepClone && folder === work) {
      console.log(`\nThe clone is kept at ${folder}`);
      continue;
    }
    if (!removeFolder(folder)) console.error(`\n✘ Couldn't remove ${folder}: delete it by hand.`);
  }
});
// Ctrl+C (or the window closing) ends the release through process.exit, so the folders above
// still go: without these, Node would stop at once and leave them.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(130));

function fail(message) {
  console.error(`\n✘ Release stopped: ${message}`);
  process.exit(1);
}

/**
 * Runs a fixed command (no user text reaches a shell except the validated tag). `secrets` are
 * extra environment variables for this command alone, never printed.
 */
function run(command, cwd, { capture = false, secrets = {} } = {}) {
  console.log(`\n▶ ${command}${cwd === repo ? "" : `   (in ${cwd})`}`);
  const result = spawnSync(command, {
    cwd,
    env: { ...env, ...secrets },
    shell: true,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (capture) console.error(result.stdout, result.stderr);
    fail(`${command} exited with ${result.status}`);
  }
  return capture ? result.stdout.trim() : "";
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Asks for a password in the terminal without showing it. */
function askHidden(question) {
  return new Promise((resolveAnswer) => {
    if (!process.stdin.isTTY) fail("no terminal to ask for the updater key's password in");
    process.stdout.write(question);
    let answer = "";
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolveAnswer(answer);
          return;
        }
        if (character === "\u0003") process.exit(130);
        answer =
          character === "\b" || character === "\u007f" ? answer.slice(0, -1) : answer + character;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ----- 1. What is being released -----
if (!tag || !/^v\d+\.\d+\.\d+(-(rc|beta)\.\d+)?$/.test(tag)) {
  fail("give the tag to release, e.g. npm run release -- v0.2.0 (pre-releases: v0.2.0-rc.1)");
}
const version = tag.slice(1).replace(/-.*$/, "");

// Folders left by a release that was killed outright (a machine that restarted mid-build), once
// they're half a day old.
const stale = staleTemporaries(
  readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, modified: statSync(join(tmpdir(), entry.name)).mtimeMs })),
  TEMPORARY_PREFIXES,
  Date.now(),
  12 * 60 * 60 * 1000,
);
for (const name of stale) {
  console.log(`• Removing ${name}, left in ${tmpdir()} by an earlier release`);
  removeFolder(join(tmpdir(), name));
}

// Every tool is checked before the long part, so a missing one doesn't waste a build.
const tools = [
  ["git", "git --version"],
  ["node", "node --version"],
  ["npm", "npm --version"],
  ["rustc", "rustc --version"],
  ["cargo", "cargo --version"],
  ["cargo-deny", "cargo deny --version"],
  ["cargo-audit", "cargo audit --version"],
  ["cargo-cyclonedx (cargo install --locked cargo-cyclonedx)", "cargo cyclonedx --version"],
];
const toolVersions = {};
for (const [name, command] of tools) {
  const result = spawnSync(command, { env, shell: true, encoding: "utf8" });
  if (result.status !== 0) fail(`${name} is needed`);
  toolVersions[name.split(" ")[0]] = result.stdout.trim().split("\n")[0];
}
const defender = join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "Windows Defender",
  "MpCmdRun.exe",
);
if (!existsSync(defender)) fail(`Microsoft Defender's scanner isn't at ${defender}`);

const commit = run(`git rev-parse "${tag}^{commit}"`, repo, { capture: true });

// ----- The updater key, checked before the long part -----
// Pre-releases are signed too (so they are tested the same way) but get no update folder.
const preRelease = tag.includes("-");
const updater = JSON.parse(
  run(`git show "${tag}:apps/desktop/src-tauri/tauri.conf.json"`, repo, { capture: true }),
).plugins?.updater;
if (!updater?.pubkey || !updater.endpoints?.[0])
  fail("the tag's tauri.conf.json has no updater key or address");
// The update manifest is named after the address the app asks (not latest.json: SiteGround refuses
// every file with that name).
const manifestName = basename(new URL(updater.endpoints[0]).pathname);
if (!/^[a-z0-9-]+\.json$/.test(manifestName) || manifestName === "latest.json")
  fail(`the updater address must end in a .json name other than latest.json, not ${manifestName}`);
const keyId = parsePublicKey(updater.pubkey).keyId;
const keyPath = process.env.AMLUTO_UPDATER_KEY ?? join(homedir(), ".tauri", "amluto-steps.key");
if (!existsSync(keyPath))
  fail(`the updater key isn't at ${keyPath} (docs/release-runbook.md#the-updater-key)`);
const signing = {
  TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8").trim(),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??
    (await askHidden(`Password for the updater key ${keyId}: `)),
};
// A wrong password, or a key that isn't the one the app trusts, stops the release here.
const keyCheck = mkdtempSync(join(tmpdir(), "amluto-steps-key-check-"));
temporaries.push(keyCheck);
const probe = join(keyCheck, "key-check.txt");
writeFileSync(probe, `Steps ${version}: updater key check`);
run(
  `npx --no-install tauri signer sign --app-version ${version} "${probe}"`,
  join(repo, "apps", "desktop"),
  { capture: true, secrets: signing },
);
try {
  verifySignature(readFileSync(probe), readFileSync(`${probe}.sig`, "utf8"), updater.pubkey);
} catch (error) {
  fail(`the updater key isn't the one tauri.conf.json trusts (${error.message})`);
}
rmSync(keyCheck, { recursive: true, force: true });

// ----- 2. A clean clone of exactly that tag -----
work = join(tmpdir(), `amluto-steps-release-${version}-${Date.now()}`);
temporaries.push(work);
run(`git clone --quiet --no-local --branch "${tag}" "${repo}" "${work}"`, repo);
const tauriDir = join(work, "apps", "desktop", "src-tauri");
if (run("git rev-parse HEAD", work, { capture: true }) !== commit)
  fail("the clone isn't at the tag");
if (run("git describe --exact-match --tags HEAD", work, { capture: true }) !== tag) {
  fail("the clone's HEAD isn't exactly the tag");
}
if (run("git status --porcelain --ignored", work, { capture: true }) !== "")
  fail("the clone isn't clean");

// The version in every manifest must match the tag.
const json = (path) => JSON.parse(readFileSync(join(work, path), "utf8"));
const cargoVersion = /\[workspace\.package\][^[]*?version = "([^"]+)"/.exec(
  readFileSync(join(tauriDir, "Cargo.toml"), "utf8"),
)?.[1];
const versions = {
  "package.json": json("package.json").version,
  "tauri.conf.json": json("apps/desktop/src-tauri/tauri.conf.json").version,
  "apps/desktop/package.json": json("apps/desktop/package.json").version,
  "apps/chrome/package.json": json("apps/chrome/package.json").version,
  "Cargo.toml (workspace)": cargoVersion,
  // The version Settings > About shows.
  "packages/ui/src/version.ts": /APP_VERSION = "([^"]+)"/.exec(
    readFileSync(join(work, "packages/ui/src/version.ts"), "utf8"),
  )?.[1],
};
for (const [file, found] of Object.entries(versions)) {
  if (found !== version) fail(`${file} says ${found}, the tag says ${version}`);
}

const lockfiles = ["package-lock.json", "apps/desktop/src-tauri/Cargo.lock"];
const lockHashes = Object.fromEntries(lockfiles.map((file) => [file, sha256(join(work, file))]));

// ----- 3. Install from the lockfiles, build the browser extension, run the full gate -----
run("npm ci --no-fund --no-audit", work);

// The extension's store files, straight after the install as docs/firefox-add-ons.md builds them,
// so nothing the gate leaves behind ends up in the Firefox sources. No STEPS_E2E: that build is
// for the tests alone, and manifestProblems refuses it.
const extensionOutput = join(work, "apps", "chrome", ".output");
run("npm run zip -w @amluto-steps/chrome", work);
run("npm run zip:firefox -w @amluto-steps/chrome", work);
const extensionZips = {
  chrome: join(extensionOutput, `steps-chrome-${version}.zip`),
  firefox: join(extensionOutput, `steps-firefox-${version}.zip`),
  sources: join(extensionOutput, `steps-firefox-${version}-sources.zip`),
};
for (const path of Object.values(extensionZips)) {
  if (!existsSync(path)) fail(`${basename(path)} wasn't built`);
}
/** Unzips with Windows' own tar (bsdtar, which reads zips) into a new temporary folder. */
const unzip = (zip, prefix) => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(folder);
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  run(`"${tar}" -xf "${zip}" -C "${folder}"`, repo, { capture: true });
  return folder;
};
// Each zip holds exactly what was built, with a manifest fit for its store.
for (const browser of ["chrome", "firefox"]) {
  const unzipped = unzip(extensionZips[browser], "amluto-steps-release-zip-");
  const differences = folderDifferences(join(extensionOutput, `${browser}-mv3`), unzipped);
  if (differences.length > 0)
    fail(`steps-${browser}-${version}.zip isn't the build: ${differences.join("; ")}`);
  const problems = manifestProblems(
    JSON.parse(readFileSync(join(unzipped, "manifest.json"), "utf8")),
    { browser, version },
  );
  if (problems.length > 0) fail(`the ${browser} manifest: ${problems.join("; ")}`);
  removeFolder(unzipped);
}
// addons.mozilla.org rebuilds the add-on from its sources and rejects it if the result differs,
// so the release does the same first: unzipped into an empty folder, npm ci, build, compare.
const sourcesDir = unzip(extensionZips.sources, "amluto-steps-firefox-sources-");
run("npm ci --no-fund --no-audit", sourcesDir);
run("npm run build:firefox -w @amluto-steps/chrome", sourcesDir);
const rebuilt = join(sourcesDir, "apps", "chrome", ".output", "firefox-mv3");
const rebuildDifferences = folderDifferences(join(extensionOutput, "firefox-mv3"), rebuilt);
if (rebuildDifferences.length > 0)
  fail(`the Firefox sources don't rebuild the add-on: ${rebuildDifferences.join("; ")}`);
const rebuiltFiles = filesIn(rebuilt).length;
removeFolder(sourcesDir);

run("npm run check", work);
// The gate's development build is gigabytes the installers don't use.
removeFolder(join(tauriDir, "target", "debug"));

// ----- 4. Build every installer with locked dependencies -----
const bundleDir = join(tauriDir, "target", "release", "bundle");
// Only this build signs: it writes the updater signature next to each installer.
writeFileSync(
  join(work, "updater.json"),
  JSON.stringify({ bundle: { createUpdaterArtifacts: true } }),
);
run(`npm run tauri -- build --config "${join(work, "updater.json")}" -- --locked`, work, {
  secrets: signing,
});
const built = (folder, pattern) =>
  existsSync(join(bundleDir, folder))
    ? readdirSync(join(bundleDir, folder))
        .filter((name) => pattern.test(name))
        .map((name) => join(bundleDir, folder, name))
    : [];
const [msi] = built("msi", /\.msi$/i);
const [nsis] = built("nsis", /-setup\.exe$/i);
if (!msi || !nsis) fail("the .msi or the .exe installer wasn't built");

// The setup's signature must be exactly what the app will accept: Amluto's key, this version.
if (!existsSync(`${nsis}.sig`)) fail("the setup .exe wasn't signed for the updater");
const setupSignature = readFileSync(`${nsis}.sig`, "utf8").trim();
let signedFor = null;
try {
  signedFor = signedVersion(verifySignature(readFileSync(nsis), setupSignature, updater.pubkey));
} catch (error) {
  fail(`the setup .exe's signature doesn't verify (${error.message})`);
}
if (signedFor !== version)
  fail(`the setup .exe was signed for version ${signedFor}, not ${version}`);

const out = join(repo, "release-out", version);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const artefacts = [];
const keep = (source, name) => {
  const target = join(out, name);
  copyFileSync(source, target);
  artefacts.push(target);
  return target;
};
mkdirSync(join(out, "browser"));
for (const path of Object.values(extensionZips)) keep(path, join("browser", basename(path)));
const keptMsi = keep(msi, `Steps ${version} x64.msi`);
const keptSetup = keep(nsis, `Steps ${version} x64 setup.exe`);
const exe = keep(join(tauriDir, "target", "release", "amluto-steps.exe"), "amluto-steps.exe");
// The loose copy carries no installer's stamp, whatever the CLI left in it (the setup's own copy
// is stamped inside the installer): that is how it knows it is the portable program, which updates
// only itself, and how the Store package made from it knows not to (the Store updates that).
const buildStamp = unstampFile(exe);

// The portable program updates itself from its own entry in release.json
// (docs/spec/10-distribution.md#the-portable-program-updates-itself): signed with the updater key
// for exactly this version, and checked as the setup is. Signed after the stamp came out, so the
// signature is of the very bytes published.
run(
  `npx --no-install tauri signer sign --app-version ${version} "${exe}"`,
  join(work, "apps", "desktop"),
  { capture: true, secrets: signing },
);
const portableSignature = readFileSync(`${exe}.sig`, "utf8").trim();
rmSync(`${exe}.sig`);
let portableSignedFor = null;
try {
  portableSignedFor = signedVersion(
    verifySignature(readFileSync(exe), portableSignature, updater.pubkey),
  );
} catch (error) {
  fail(`the portable program's signature doesn't verify (${error.message})`);
}
if (portableSignedFor !== version)
  fail(`the portable program was signed for version ${portableSignedFor}, not ${version}`);

// The offline .msi carries the WebView2 runtime for locked-down networks.
const offline = JSON.stringify({
  bundle: { windows: { webviewInstallMode: { type: "offlineInstaller" } } },
});
writeFileSync(join(work, "offline.json"), offline);
rmSync(join(bundleDir, "msi"), { recursive: true, force: true });
run(
  `npm run tauri -- build --bundles msi --config "${join(work, "offline.json")}" -- --locked`,
  work,
);
const [offlineMsi] = built("msi", /\.msi$/i);
if (!offlineMsi) fail("the offline .msi wasn't built");
keep(offlineMsi, `Steps ${version} x64 offline.msi`);

// The Store package, once apps/desktop/msix/identity.json has the Partner Center identity.
const msixIdentity = JSON.parse(
  readFileSync(join(work, "apps", "desktop", "msix", "identity.json"), "utf8"),
);
const msixReady = identityProblems(msixIdentity).length === 0;
if (msixReady) {
  run(`node scripts/msix.mjs --exe "${exe}"`, work);
  const msixDir = join(work, "release-out", "msix");
  const [msix] = readdirSync(msixDir).filter((name) => name.endsWith(".msix"));
  if (!msix) fail("the .msix wasn't built");
  keep(join(msixDir, msix), `Steps ${version} x64.msix`);
} else {
  console.log("\n• MSIX skipped: apps/desktop/msix/identity.json isn't filled in yet.");
}

/** The Linux packages' update entries, for release.json. */
const linuxUpdates = [];
// The Linux beta's packages: WSL clones the same tag, checks it on Linux, builds the .deb and the
// AppImage signed for updates, and records tasks with the AppImage (docs/release-runbook.md#linux-beta).
if (linux) {
  const linuxOut = join(out, "linux");
  mkdirSync(linuxOut, { recursive: true });
  const inWsl = (path) => run(`wsl -d Ubuntu -- wslpath -a "${path}"`, repo, { capture: true });
  run(
    `wsl -d Ubuntu -- bash "${inWsl(join(repo, "scripts", "linux", "release.sh"))}" "${tag}" "${inWsl(linuxOut)}"`,
    repo,
    // The key and its password reach WSL through WSLENV, for this command alone.
    {
      secrets: {
        ...signing,
        WSLENV: "TAURI_SIGNING_PRIVATE_KEY/u:TAURI_SIGNING_PRIVATE_KEY_PASSWORD/u",
      },
    },
  );
  const packages = readdirSync(linuxOut).filter((name) => /\.(deb|AppImage)$/.test(name));
  if (packages.length !== 2) fail("the Linux packages weren't both built");
  // Each must be signed exactly as the app will accept: Amluto's key, this version.
  const signatures = join(linuxOut, "signatures");
  for (const name of packages) {
    const signature = readFileSync(join(signatures, `${name}.sig`), "utf8").trim();
    let signedAs = null;
    try {
      signedAs = signedVersion(
        verifySignature(readFileSync(join(linuxOut, name)), signature, updater.pubkey),
      );
    } catch (error) {
      fail(`${name}'s signature doesn't verify (${error.message})`);
    }
    if (signedAs !== version) fail(`${name} was signed for version ${signedAs}, not ${version}`);
    linuxUpdates.push({
      bundle: name.endsWith(".deb") ? "deb" : "appimage",
      // Updates come straight from the GitHub Release: nothing is uploaded twice.
      url: releaseAsset(version, name),
      signature,
    });
    artefacts.push(join(linuxOut, name));
  }
  rmSync(signatures, { recursive: true, force: true });
}

// The update manifest for installed copies: what goes in steps.amluto.com/update
// (docs/spec/10-distribution.md#updates-for-the-exe). It points at the files on the GitHub Release,
// which go up first. Never for a pre-release, which would otherwise reach everyone.
const setupName = `amluto-steps-${version}-x64-setup.exe`;
let latest = null;
if (!preRelease) {
  const updateDir = join(out, "update");
  mkdirSync(updateDir);
  const changelog = join(work, "CHANGELOG.md");
  latest = latestJson({
    version,
    notes: existsSync(changelog) ? changelogNotes(readFileSync(changelog, "utf8"), version) : null,
    published: new Date(),
    url: releaseAsset(version, setupName),
    signature: setupSignature,
    portable: {
      url: releaseAsset(version, `amluto-steps-${version}-x64-portable.exe`),
      signature: portableSignature,
    },
    linux: linuxUpdates,
  });
  writeFileSync(join(updateDir, manifestName), latest);
  writeFileSync(join(updateDir, ".htaccess"), UPDATE_HTACCESS);
}

// ----- 5. Check what was built -----
// Version info: every field set, versions matching (Tauri used to leave OriginalFilename empty).
const info = JSON.parse(
  run(
    `powershell -NoProfile -Command "[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Item -LiteralPath '${exe}').VersionInfo | Select-Object CompanyName,FileDescription,FileVersion,InternalName,LegalCopyright,OriginalFilename,ProductName,ProductVersion | ConvertTo-Json"`,
    repo,
    { capture: true },
  ),
);
for (const [field, value] of Object.entries(info)) {
  if (!value) fail(`the .exe's version info has no ${field}`);
}
if (info.FileVersion !== version || info.ProductVersion !== version)
  fail("the .exe's version info doesn't match the tag");

// The test driver's input injection must never reach the app. SendInput itself is imported by
// Tauri's window and menu libraries (tao, muda), so the check is on what only our driver uses.
const imported = [...peImports(exe).values()].flat();
const injection = ["InjectTouchInput", "InitializeTouchInjection"].filter((name) =>
  imported.includes(name),
);
if (injection.length > 0)
  fail(`the .exe imports ${injection.join(" and ")}: the test driver reached the app`);

// Microsoft Defender scans every artefact (exit code 2 means something was found).
const scans = [];
for (const path of artefacts) {
  const result = spawnSync(
    defender,
    ["-Scan", "-ScanType", "3", "-File", path, "-DisableRemediation"],
    {
      encoding: "utf8",
    },
  );
  scans.push({ file: basename(path), clean: result.status === 0, output: result.stdout.trim() });
  if (result.status !== 0) fail(`Defender reported ${basename(path)}:\n${result.stdout}`);
}

// ----- 6. SBOMs, notices, checksums, provenance -----
run(`npm sbom --sbom-format cyclonedx --omit dev > "${join(out, "sbom-npm.cdx.json")}"`, work);
run("cargo cyclonedx --format json --target x86_64-pc-windows-msvc --no-build-deps", tauriDir);
copyFileSync(join(tauriDir, "amluto-steps.cdx.json"), join(out, "sbom-rust.cdx.json"));
const components = [...rustPackages(tauriDir), ...npmPackages(work)];
writeFileSync(join(out, "THIRD-PARTY-NOTICES.txt"), renderNotices(version, components));
// Settings > About lists the same components; a release can't ship a list that's out of date.
if (readFileSync(join(work, ATTRIBUTIONS_PATH), "utf8") !== renderAttributions(components))
  fail(`${ATTRIBUTIONS_PATH} is out of date: run npm run attributions on dev and commit it`);
const unlicensed = components.filter((item) => item.files.length === 0);

const published = filesIn(out)
  .filter((name) => name !== "SHA256SUMS.txt")
  .sort();
const sums = published.map((name) => `${sha256(join(out, name))}  ${name}`);
writeFileSync(join(out, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);

// The files for the GitHub Release, under the names the download page, the update manifest and
// winget use. Its SHA256SUMS.txt also goes to steps.amluto.com/download, which the download page
// reads (a page may only fetch from its own site). Releases stay on GitHub for good, which winget's
// manifests rely on.
const downloadDir = join(out, "download");
mkdirSync(downloadDir);
const downloads = {
  [`amluto-steps-${version}-x64-setup.exe`]: keptSetup,
  [`amluto-steps-${version}-x64-portable.exe`]: exe,
  [`amluto-steps-${version}-x64.msi`]: keptMsi,
};
if (linux) {
  for (const name of [
    `amluto-steps-${version}-amd64.deb`,
    `amluto-steps-${version}-x86_64.AppImage`,
  ])
    downloads[name] = join(out, "linux", name);
}
for (const [name, source] of Object.entries(downloads))
  copyFileSync(source, join(downloadDir, name));
copyFileSync(join(out, "THIRD-PARTY-NOTICES.txt"), join(downloadDir, "THIRD-PARTY-NOTICES.txt"));
const downloadSums = Object.keys(downloads)
  .sort()
  .map((name) => `${sha256(join(downloadDir, name))}  ${name}`);
writeFileSync(join(downloadDir, "SHA256SUMS.txt"), `${downloadSums.join("\n")}\n`);

// The winget manifests (docs/spec/10-distribution.md#winget), checked by winget itself, to submit
// to microsoft/winget-pkgs once the downloads are live. Not for pre-releases.
let wingetDir = null;
if (!preRelease) {
  const changelog = join(work, "CHANGELOG.md");
  const files = wingetManifests({
    version,
    released: new Date(),
    setup: {
      url: releaseAsset(version, `amluto-steps-${version}-x64-setup.exe`),
      sha256: sha256(keptSetup),
    },
    msi: {
      url: releaseAsset(version, `amluto-steps-${version}-x64.msi`),
      sha256: sha256(keptMsi),
      ...msiCodes(keptMsi),
    },
    notes: existsSync(changelog) ? changelogNotes(readFileSync(changelog, "utf8"), version) : null,
  });
  wingetDir = join(out, "winget", ...PACKAGE_ID.split("."), version);
  mkdirSync(wingetDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(wingetDir, name), text);
  const check = spawnSync("winget", ["validate", "--manifest", wingetDir], { encoding: "utf8" });
  if (check.error) fail("winget isn't installed, so the winget manifests can't be checked");
  if (check.status !== 0) fail(`winget validate refused the manifests:\n${check.stdout}`);
}

// The lockfiles must be exactly what was committed: nothing was resolved afresh.
for (const [file, hash] of Object.entries(lockHashes)) {
  if (sha256(join(work, file)) !== hash) fail(`${file} changed during the build`);
}

const date = new Date();
const pad = (value) => String(value).padStart(2, "0");
const record = `# Steps ${version}

Built ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} by \`npm run release -- ${tag}\` from a clean clone.

| | |
|---|---|
| Tag | \`${tag}\` |
| Commit | \`${commit}\` |
${Object.entries(toolVersions)
  .map(([name, value]) => `| ${name} | ${value} |`)
  .join("\n")}
| Rust toolchain file | \`${readFileSync(join(work, "rust-toolchain.toml"), "utf8").match(/channel = "([^"]+)"/)?.[1] ?? "?"}\` |
${Object.entries(lockHashes)
  .map(([file, hash]) => `| \`${file}\` SHA-256 | \`${hash}\` |`)
  .join("\n")}

**Checks:** \`npm ci\` from the lockfile, then \`npm run check\` (all steps passed); every installer built with \`--locked\`; the lockfiles were unchanged afterwards.

**Version info** of \`amluto-steps.exe\`: ${Object.entries(info)
  .map(([field, value]) => `${field} "${value}"`)
  .join(", ")}.

**Imports:** no \`InjectTouchInput\` or \`InitializeTouchInjection\` (the test driver isn't in the app). \`SendInput\` ${imported.includes("SendInput") ? "is imported, by Tauri's tao and muda libraries (expected)" : "isn't imported"}.

**Microsoft Defender:** ${scans.map((scan) => `${scan.file}: no threats`).join("; ")}.

**Updater:** the setup \`.exe\` is signed with key \`${keyId}\` for version ${signedFor}, verified against the public key in \`tauri.conf.json\`. The loose \`amluto-steps.exe\` came out of the build stamped \`${buildStamp}\` and is stamped unknown, so it never updates itself. ${latest ? `\`update/${manifestName}\` announces ${version} at \`${JSON.parse(latest).platforms["windows-x86_64-nsis"].url}\`.` : "No update folder: this is a pre-release."}

**Browser extension:** \`release-out/${version}/browser/\` holds \`steps-chrome-${version}.zip\` (the Chrome Web Store and Edge Add-ons) and \`steps-firefox-${version}.zip\` with its \`-sources.zip\` (addons.mozilla.org), built from the tag straight after \`npm ci\`. Each zip is exactly its build, with Manifest V3, version ${version} and no native messaging asked for up front; the Firefox sources, unzipped into an empty folder, rebuilt the add-on byte for byte (${rebuiltFiles} files).

**Downloads:** \`release-out/${version}/download/\` holds the files for the GitHub Release (${releasePage(version)}), under the names the download page, the update manifest and winget use, with its own \`SHA256SUMS.txt\`, which also goes to steps.amluto.com/download for the download page.

**Winget:** ${wingetDir ? `manifests for \`${PACKAGE_ID}\` ${version} (the setup per person, the \`.msi\` per machine) in \`release-out/${version}/winget/\`, passed \`winget validate\`.` : "none: this is a pre-release."}

**Artefacts (SHA-256):**

${sums.map((line) => `- \`${line.replace("  ", "` ")}`).join("\n")}

**Components:** ${components.length} (${components.filter((item) => item.ecosystem === "cargo").length} Rust crates, ${components.filter((item) => item.ecosystem === "npm").length} npm packages); MPL-2.0: ${
  components
    .filter((item) => /MPL/i.test(item.licence))
    .map((item) => item.name)
    .join(", ") || "none"
}. Without a licence file in the package (checked by hand against the licence named): ${unlicensed.map((item) => `${item.name} ${item.version}`).join(", ") || "none"}.

**Manual steps** (tick when done):
- [ ] Microsoft Security Intelligence submission for the \`.msi\`, offline \`.msi\` and setup \`.exe\`
- [ ] VirusTotal look at the major engines; each detection resolved or recorded as an accepted exception
- [ ] \`cargo fuzz\` on the archive extractor
- [ ] the manual rows of \`docs/test-matrix.md\` on Windows 11
- [ ] ${msixReady ? "upload the `.msix` to Partner Center (hidden listing for the pilot)" : "MSIX for the Store: fill in `apps/desktop/msix/identity.json` from Partner Center, then release again"}
- [ ] the components without a licence file above checked
- [ ] once each store lists it: \`browser/steps-chrome-${version}.zip\` to the Chrome Web Store and Edge Add-ons (docs/chrome-web-store.md); \`browser/steps-firefox-${version}.zip\` with its sources to addons.mozilla.org (docs/firefox-add-ons.md)
- [ ] \`CHANGELOG.md\` entry; checksums published with the release notes
- [ ] push the release's commit and tag to ${REPOSITORY}, then \`node scripts/publish-github.mjs ${version}\`: the GitHub Release with every file in \`download/\`, each checked from outside
- [ ] upload \`release-out/${version}/download/SHA256SUMS.txt\` to the \`download\` folder on steps.amluto.com (the download page reads it)
${wingetDir ? "- [ ] once the downloads are live, submit the winget manifests to microsoft/winget-pkgs (docs/release-runbook.md#winget)\n" : ""}${latest ? `- [ ] once the GitHub Release is live, upload \`release.json\` and \`.htaccess\` from \`release-out/${version}/update/\` to the \`update\` folder on steps.amluto.com; then ${updater.endpoints[0]} must show ${version} (purge SiteGround's cache if it doesn't)\n` : ""}`;
mkdirSync(join(repo, "releases"), { recursive: true });
writeFileSync(join(repo, "releases", `${version}.md`), record);

// release-out keeps this version and the one before: the older ones are on GitHub Releases
// already (and can be rebuilt from their tags), and each is half a gigabyte.
const releaseOut = join(repo, "release-out");
const dropped = oldReleases(
  readdirSync(releaseOut, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
  2,
).filter((name) => name !== version);
const freed = dropped.reduce((total, name) => total + folderBytes(join(releaseOut, name)), 0);
for (const name of dropped) removeFolder(join(releaseOut, name));

console.log(`\n✔ Release ${version} built from ${tag} (${commit.slice(0, 8)}).`);
console.log(`  Files:      ${out}`);
console.log(`  Provenance: releases/${version}.md (review and commit it)`);
if (dropped.length > 0)
  console.log(
    `  Tidied:     release-out/${dropped.join(", ")} (${(freed / 1024 ** 3).toFixed(1)} GB, published already)`,
  );
console.log("\nStill to do by hand (listed in the provenance record):");
console.log("  - Microsoft Security Intelligence submission and a VirusTotal look");
console.log("  - cargo fuzz on the archive extractor; the manual test-matrix rows");
console.log(
  msixReady
    ? "  - upload the .msix to Partner Center; CHANGELOG.md; publish the checksums"
    : "  - MSIX: fill in apps/desktop/msix/identity.json first; CHANGELOG.md; publish the checksums",
);
console.log(`  - push the tag to ${REPOSITORY}, then node scripts/publish-github.mjs ${version}`);
console.log("  - SHA256SUMS.txt to steps.amluto.com/download");
if (latest)
  console.log(`  - then release-out/${version}/update/ to steps.amluto.com/update, and check it`);
console.log("  - the browser zips to their stores, once each is listed");
