// Builds the website and publishes it to https://steps.amluto.com/ (SiteGround, over SSH).
// `node apps/website/scripts/deploy.mjs` from the repo root.
//
// The site sits beside the app's own folders there: /download (installers and checksums) and
// /update (the updater's release.json). Neither is touched. New files are uploaded to a staging
// folder first and copied in with the page itself last, so a visitor never gets a page whose
// scripts aren't there yet. Hashed asset names mean older ones can stay without harm.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");
const dist = join(root, "apps", "website", "dist");
// The hosting account's details stay on the PC that deploys, in deploy.local.json beside this
// script (git-ignored): {"host": "user@ssh.example", "port": 22, "key": "file in ~/.ssh",
// "site": "www/steps.amluto.com/public_html"}.
const localConfig = join(import.meta.dirname, "deploy.local.json");
if (!existsSync(localConfig)) throw new Error(`No ${localConfig}: see the comment above it.`);
const { host: HOST, port: PORT, key, site: SITE } = JSON.parse(readFileSync(localConfig, "utf8"));
const KEY = join(homedir(), ".ssh", key);
const SSH = ["-i", KEY, "-o", "BatchMode=yes"];

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", cwd: root, shell: false, ...options });
const ssh = (script) =>
  execFileSync("ssh", [...SSH, "-p", String(PORT), HOST, script], { encoding: "utf8" });

// 1. A fresh build, and the demo it frames (a real export made by the app's exporter).
run("npx", ["jiti", "apps/website/scripts/demo.ts"], { shell: true });
run("npm", ["run", "build", "-w", "@amluto-steps/website"], { shell: true });
const page = readFileSync(join(dist, "index.html"), "utf8");
if (!page.includes("Content-Security-Policy")) throw new Error("The built page has no CSP.");
if (!existsSync(join(dist, "demo", "index.html"))) throw new Error("The demo wasn't built.");

// 2. Upload to a staging folder.
const stage = `tmp/steps-site-${Date.now()}`;
ssh(`mkdir -p ~/${stage}`);
run("scp", [...SSH, "-P", String(PORT), "-r", `${dist}/.`, `${HOST}:${stage}/`]);

// 3. Copy in: everything but the page, then the page. The root .htaccess used to send / to
// /download; the site replaces that.
console.log(
  ssh(`set -e
cd ~/${SITE}
test -d download && test -f update/release.json
cd ~/${stage}
for item in *; do
  [ "$item" = index.html ] && continue
  cp -r "$item" ~/${SITE}/
done
printf '%s\\n' '# steps.amluto.com: the website (index.html). /download has the installers and' '# checksums, and /update the release.json the app checks for new versions.' > ~/${SITE}/.htaccess
cp index.html ~/${SITE}/index.html
# SiteGround's dynamic cache keeps serving the old page until it's flushed.
id=$(site-tools-client domain-all list | sed -n 's/^id=\\([0-9]*\\) name=steps\\.amluto\\.com .*/\\1/p')
test -n "$id" && site-tools-client domain update id=$id flush_cache=1
cd ~ && rm -r ~/${stage}
ls -la ~/${SITE}`),
);

// 4. Check from outside, as a visitor would.
for (const url of [
  "https://steps.amluto.com/",
  "https://steps.amluto.com/demo/index.html",
  "https://steps.amluto.com/it/",
  "https://steps.amluto.com/help/",
  "https://steps.amluto.com/it/amluto-steps-policy-templates.zip",
  "https://steps.amluto.com/it/policy/AmlutoSteps.admx",
  "https://steps.amluto.com/it/policy/en-US/AmlutoSteps.adml",
  "https://steps.amluto.com/update/release.json",
  "https://steps.amluto.com/download/SHA256SUMS.txt",
]) {
  // fetch rather than curl: Windows curl can't write to /dev/null.
  const response = await fetch(url, { cache: "no-store" });
  console.log(response.status, url);
  if (response.status !== 200) throw new Error(`${url} answered ${response.status}`);
  // The page must be the one just built, not a copy from the server's cache.
  if (url === "https://steps.amluto.com/" && (await response.text()) !== page) {
    throw new Error("The site is still serving an older page.");
  }
}
