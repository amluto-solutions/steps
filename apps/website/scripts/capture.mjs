// Screenshots of the real app for the website, taken from the desktop app's browser preview
// (`npm run vite:dev -w @amluto-steps/desktop`, then this). Headless Edge, 2x pixels, light and
// dark. Run from the repo root: `node apps/website/scripts/capture.mjs`.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = process.env.PREVIEW_URL ?? "http://localhost:1420/preview.html";
const OUT = join(import.meta.dirname, "..", "src", "assets", "shots");
mkdirSync(OUT, { recursive: true });

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Clicks the first button, link or menu item whose name or text matches. */
async function click(page, pattern) {
  const found = await page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const items = [
      ...globalThis.document.querySelectorAll("button, a, [role=menuitem], [role=tab]"),
    ];
    const hit = items.find(
      (item) =>
        re.test(item.getAttribute("aria-label") ?? "") || re.test(item.textContent?.trim() ?? ""),
    );
    hit?.click();
    return Boolean(hit);
  }, pattern.source);
  if (!found) throw new Error(`Nothing to click for ${pattern}`);
  await pause(700);
}

async function shoot(page, name, theme, clip) {
  const path = join(OUT, `${name}-${theme}.webp`);
  await page.screenshot({ path, type: "webp", quality: 88, ...(clip ? { clip } : {}) });
  console.log("saved", path);
}

// Its own profile, so a running Edge (with the user's) isn't joined instead. msedge.exe hands over
// to a browser process and exits at once, so puppeteer.launch sees it "fail": it is started here
// and connected to on its debugging port instead.
const profile = mkdtempSync(join(tmpdir(), "amluto-capture-"));
const PORT = 9334;
spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { detached: true, stdio: "ignore" },
).unref();
let browser;
for (let attempt = 0; attempt < 40 && !browser; attempt += 1) {
  await pause(250);
  browser = await puppeteer
    .connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
    .catch(() => undefined);
}
if (!browser) throw new Error("Headless Edge didn't start.");
try {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: theme },
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    await page.goto(BASE, { waitUntil: "networkidle0" });
    await pause(800);
    // A fresh profile opens the tour's welcome card first.
    await click(page, /^Not now$/).catch(() => undefined);

    // Headless Edge's first screenshot at 2x can come out tiled; one to throw away comes first.
    await page.screenshot({ type: "webp", quality: 10 });
    await pause(400);
    await shoot(page, "library", theme);

    // The start dialog, with "Record what's typed" unticked as it always starts.
    await click(page, /^New recording$/);
    await pause(700);
    await shoot(page, "start-dialog", theme);
    await page.keyboard.press("Escape");
    await pause(500);

    await click(page, /^Open Add a new supplier$/);
    await pause(900);
    await shoot(page, "editor", theme);

    await click(page, /^Export/);
    await click(page, /^PDF/);
    await pause(2500);
    await shoot(page, "export-review", theme);
    await page.keyboard.press("Escape");
    await pause(500);

    await click(page, /^Guides$/);
    await click(page, /^Settings$/);
    await click(page, /^Brand profiles$/);
    await click(page, /^Duplicate Amluto as a new brand$/);
    await pause(900);
    await shoot(page, "brand-editor", theme);
    await page.close();

    // The recording bar, on its own.
    const bar = await browser.newPage();
    await bar.setViewport({ width: 600, height: 140, deviceScaleFactor: 2 });
    await bar.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    await bar.goto(`${BASE}?recorder-bar&keys`, { waitUntil: "networkidle0" });
    await pause(800);
    // The bar's own element, on a clear background (its window is transparent round the pill).
    const pill = await bar.$("body > #root > *");
    const box = await pill?.boundingBox();
    await bar.screenshot({
      path: join(OUT, `recorder-bar-${theme}.webp`),
      type: "webp",
      quality: 88,
      omitBackground: true,
      ...(box ? { clip: { x: 0, y: 0, width: Math.ceil(box.x + box.width + 4), height: 80 } } : {}),
    });
    console.log("saved recorder bar");
    await bar.close();
  }
} finally {
  await browser.close();
  await pause(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
