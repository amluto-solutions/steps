// Steps with Chrome and Firefox on Linux (the Phase 10 checklist). A local page opens in each
// browser and a recording clicks its button; each click must name the button, and each Chrome
// page must become a "Go to" step, read from Chrome's address bar:
//
// - Chrome as most people run it, started before the recording, with its accessibility off:
//   Chrome shows nothing of itself on the AT-SPI bus until something looks it up, which Steps'
//   first lookup does. The test finds the button by OCR (find-text.py), not through AT-SPI.
// - Firefox, which shows its pages on the bus once Steps switches accessibility on.
// - Chrome started during the recording with its accessibility already on (as a screen reader
//   leaves it; here by its flag).
//
//   scripts/linux/with-display.sh node tools/linux-e2e/browsers.mjs
//
// Needs, besides what run.mjs needs: google-chrome-stable (Google's apt repository) and firefox
// (Mozilla's): Ubuntu's own are snaps, which don't run in WSL.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harness, pause, root } from "./harness.mjs";

const test = harness("tools/linux-e2e/browsers.mjs");
const { check, click, shot } = test;

// Each browser gets its own page title, so the steps say which window each click was in.
const page = (title) => `<!doctype html><html lang="en"><head><title>${title}</title></head>
<body style="font: 18px sans-serif; padding: 40px">
<h1>${title}</h1>
<p><button style="font-size: 20px; padding: 12px 24px">Approve invoice</button></p>
</body></html>`;
const TITLES = { "/chrome": "Invoices", "/firefox": "Bills", "/chrome-a11y": "Payments" };
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(page(TITLES[request.url] ?? "Not found"));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const site = `127.0.0.1:${server.address().port}`;

// Firefox's first-run notices open over the page, and its welcome tab in front of it.
const FIREFOX_PREFS = [
  ["browser.aboutwelcome.enabled", false],
  ["browser.shell.checkDefaultBrowser", false],
  ["browser.startup.homepage_override.mstone", '"ignore"'],
  ["datareporting.policy.dataSubmissionPolicyBypassNotification", true],
  ["datareporting.policy.dataSubmissionEnabled", false],
  ["toolkit.telemetry.reportingpolicy.firstRun", false],
  ["termsofuse.bypassNotification", true],
  ["trailhead.firstrun.didSeeAboutWelcome", true],
];

/** A screen point from one of the finders (find.py or find-text.py), or null. */
function locate(finder, ...args) {
  const out = execFileSync("python3", [join(root, "tools", "linux-e2e", finder), ...args], {
    encoding: "utf8",
  }).trim();
  return out ? JSON.parse(out) : null;
}
const windowId = (title) =>
  execFileSync("xdotool", ["search", "--onlyvisible", "--name", title], { encoding: "utf8" })
    .trim()
    .split("\n")[0];
/** Waits for a window, brings it to the front and returns once it's there. */
async function bringForward(title) {
  const id = await test.waitFor(`the "${title}" window`, () => windowId(title), 45_000);
  execFileSync("xdotool", ["windowactivate", "--sync", id]);
  await pause(1_500);
}
function chrome(path, extra = []) {
  test.start("google-chrome", [
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "steps-chrome-"))}`,
    "--window-position=0,80",
    "--window-size=780,600",
    ...extra,
    `http://${site}${path}`,
  ]);
}

try {
  const main = await test.openApp(4444);
  await test.welcome();
  const firefoxProfile = mkdtempSync(join(tmpdir(), "steps-firefox-"));
  writeFileSync(
    join(firefoxProfile, "user.js"),
    FIREFOX_PREFS.map(([name, value]) => `user_pref("${name}", ${value});`).join("\n"),
  );
  chrome("/chrome");
  test.start("firefox", [
    "--no-remote",
    "--profile",
    firefoxProfile,
    "--width",
    "780",
    "--height",
    "600",
    `http://${site}/firefox`,
  ]);
  await bringForward("Invoices - Google Chrome");
  await bringForward("Bills — Mozilla Firefox");

  await test.startRecording(main, false);

  await bringForward("Invoices - Google Chrome");
  const inChrome = await test.waitFor(
    "Chrome's button",
    () => locate("find-text.py", "Invoices - Google Chrome", "Approve invoice"),
    30_000,
  );
  shot("browsers-1-chrome");
  click(inChrome);
  await pause(2_500);

  await bringForward("Bills — Mozilla Firefox");
  const inFirefox = await test.waitFor(
    "Firefox's button",
    () => locate("find.py", "firefox", "push button", "Approve invoice"),
    30_000,
  );
  shot("browsers-2-firefox");
  click(inFirefox);
  await pause(2_500);

  chrome("/chrome-a11y", ["--force-renderer-accessibility"]);
  await bringForward("Payments - Google Chrome");
  const inChromeA11y = await test.waitFor(
    "Chrome's button, with its accessibility on",
    () => locate("find.py", "chrome", "push button", "Approve invoice"),
    30_000,
  );
  shot("browsers-3-chrome-a11y");
  click(inChromeA11y);
  await pause(3_000);

  check("the recording bar stops the recording", await test.stopRecording(main));
  const steps = await test.reviewSteps();
  shot("browsers-4-review");
  console.log("  steps:", JSON.stringify(steps));
  const opened = (app) =>
    steps.flatMap((step, index) => (step.includes(`Open "${app}"`) ? [index] : []));
  const [plainChrome, a11yChrome] = opened("Google Chrome");
  const [firefox] = opened("Firefox");
  // The test opens each page itself, not through the address bar, so no page is a Go to step
  // (04/10/2026: only an address typed or picked in the address bar is one).
  const noGoTo = !steps.some((step) => step.includes("Go to"));
  const named = (index) => Boolean(steps[index]?.includes('Click "Approve invoice"'));
  check("a page not typed in the address bar makes no Go to step", noGoTo);
  check("Chrome, accessibility off: the click names the button", named(plainChrome + 1));
  check("Firefox: the click names the button", named(firefox + 1));
  check("Chrome, accessibility on: the click names the button", named(a11yChrome + 1));
  server.close();
  await test.finish();
} catch (error) {
  server.close();
  await test.finish(error);
}
