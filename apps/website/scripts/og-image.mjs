// Draws the picture shown when steps.amluto.com is shared (og/og-image.html) into
// public/og-image.jpg at 2400 × 1260: twice 1200 × 630, so it stays sharp on high-density screens.
// `node apps/website/scripts/og-image.mjs` from the repo root. It uses Playwright's Chromium from
// %LOCALAPPDATA%\ms-playwright (or CHROMIUM=<path to chrome.exe>), as the end-to-end tests do.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import puppeteer from "puppeteer-core";

const site = join(import.meta.dirname, "..");

function chromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  const found = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .map((name) => join(cache, name, "chrome-win64", "chrome.exe"))
    .filter(existsSync)
    .at(-1);
  if (!found) throw new Error("No Chromium found: set CHROMIUM to a chrome.exe");
  return found;
}

const profile = mkdtempSync(join(tmpdir(), "og-"));
const browser = await puppeteer.launch({
  executablePath: chromium(),
  headless: true,
  userDataDir: profile,
  args: ["--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
  await page.bringToFront();
  await page.goto(pathToFileURL(join(site, "og", "og-image.html")).href, {
    waitUntil: "networkidle0",
  });
  await page.evaluate(() => globalThis.document.fonts.ready);
  // The first screenshot of a new page can come out unfinished: take one to throw away.
  await page.screenshot({ type: "jpeg", quality: 88 });
  const image = await page.screenshot({ type: "jpeg", quality: 88 });
  writeFileSync(join(site, "public", "og-image.jpg"), image);
  console.log(`public/og-image.jpg: ${Math.round(image.length / 1024)} KB`);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
