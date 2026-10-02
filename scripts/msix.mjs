// `npm run msix`: packs the release build as the Microsoft Store package
// (docs/spec/10-distribution.md#microsoft-store).
//
//   npm run msix                 uses apps/desktop/msix/identity.json (from Partner Center)
//   npm run msix -- --check      uses a fake identity, to check the package builds; never upload it
//   npm run msix -- --exe <path> packs that amluto-steps.exe instead of this checkout's release build
//
// It lays out the exe, the Store logos and the filled-in manifest, then packs them with makeappx
// from the Windows SDK (which also checks the manifest). The package is left unsigned: the Store
// signs it after certification. Output: release-out/msix/.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHECK_IDENTITY, fillManifest, identityProblems, storeVersion } from "./lib/msix.mjs";
import { unstampFile } from "./lib/stamp.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const desktop = join(repo, "apps", "desktop");
const args = process.argv.slice(2);
const check = args.includes("--check");
const exeArg = args.indexOf("--exe");
const exe =
  exeArg >= 0
    ? resolve(args[exeArg + 1] ?? "")
    : join(desktop, "src-tauri", "target", "release", "amluto-steps.exe");

function fail(message) {
  console.error(`\n✘ MSIX stopped: ${message}`);
  process.exit(1);
}

/** The newest x64 makeappx.exe in the Windows 10/11 SDK. */
function makeappx() {
  const bin = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = existsSync(bin)
    ? readdirSync(bin)
        .filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    : [];
  const found = versions
    .reverse()
    .map((version) => join(bin, version, "x64", "makeappx.exe"))
    .find((path) => existsSync(path));
  if (!found)
    fail(
      "makeappx.exe wasn't found. Install the Windows SDK (it comes with Visual Studio's C++ tools).",
    );
  return found;
}

const identity = check
  ? CHECK_IDENTITY
  : JSON.parse(readFileSync(join(desktop, "msix", "identity.json"), "utf8"));
const problems = identityProblems(identity);
if (problems.length) {
  fail(
    `apps/desktop/msix/identity.json isn't filled in yet:\n  - ${problems.join("\n  - ")}\n` +
      "Use --check to test the package with a fake identity instead.",
  );
}
if (!existsSync(exe)) fail(`${exe} doesn't exist. Build it first (npm run tauri -- build).`);

const conf = JSON.parse(readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"));
const version = storeVersion(conf.version);
const manifest = fillManifest(readFileSync(join(desktop, "msix", "AppxManifest.xml"), "utf8"), {
  ...identity,
  version,
});

const out = join(repo, "release-out", "msix");
const layout = join(out, "layout");
rmSync(layout, { recursive: true, force: true });
mkdirSync(layout, { recursive: true });
copyFileSync(exe, join(layout, "amluto-steps.exe"));
// The Store updates this copy: stamped "unknown", it never asks steps.amluto.com, even before
// the app sees it is running in a package (docs/spec/10-distribution.md#updates-for-the-exe).
unstampFile(join(layout, "amluto-steps.exe"));
for (const logo of ["StoreLogo.png", "Square150x150Logo.png", "Square44x44Logo.png"]) {
  copyFileSync(join(desktop, "src-tauri", "icons", logo), join(layout, logo));
}
writeFileSync(join(layout, "AppxManifest.xml"), manifest);

const name = `Steps_${conf.version}_x64${check ? "_check" : ""}.msix`;
const target = join(out, name);
console.log(`▶ makeappx pack → release-out\\msix\\${name}`);
const result = spawnSync(makeappx(), ["pack", "/d", layout, "/p", target, "/o", "/h", "SHA256"], {
  encoding: "utf8",
});
if (result.status !== 0) fail(`makeappx refused the package:\n${result.stdout}\n${result.stderr}`);
rmSync(layout, { recursive: true, force: true });
console.log(`\n✔ ${target}`);
console.log(
  check
    ? "  A local check only (fake identity): don't upload it."
    : "  Unsigned: upload it to Partner Center, which signs it after certification.",
);
