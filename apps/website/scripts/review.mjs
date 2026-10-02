// Full-page screenshots of the website for review: desktop and phone, light and dark, reduced
// motion (so every section is drawn in place). `node apps/website/scripts/review.mjs [outDir]`.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = process.env.SITE_URL ?? "http://localhost:4175/";
const OUT = process.argv[2] ?? join(tmpdir(), "amluto-site-review");
mkdirSync(OUT, { recursive: true });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const profile = mkdtempSync(join(tmpdir(), "amluto-review-"));
const PORT = 9335;
spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
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

const sizes = [
  { name: "desktop", width: 1440, height: 900, scale: 1 },
  { name: "phone", width: 390, height: 844, scale: 2 },
];
try {
  for (const size of sizes) {
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
      await page.setViewport({
        width: size.width,
        height: size.height,
        deviceScaleFactor: size.scale,
      });
      await page.emulateMediaFeatures([
        { name: "prefers-color-scheme", value: theme },
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);
      await page.goto(URL, { waitUntil: "networkidle0" });
      // Lazy pictures would still be empty in a screenshot that never scrolls to them.
      await page.evaluate(() => {
        for (const image of globalThis.document.querySelectorAll("img[loading=lazy]")) {
          image.loading = "eager";
        }
      });
      await pause(2000);
      const path = join(OUT, `${size.name}-${theme}.png`);
      await page.screenshot({ path, fullPage: true });
      // Each section on its own too, to look at in detail.
      const blocks = await page.$$("header, main > section, footer");
      for (const [index, block] of blocks.entries()) {
        // A block with no size (hidden at this width) can't be photographed: skip it.
        await block
          .screenshot({ path: join(OUT, `${size.name}-${theme}-${index}.png`) })
          .catch(() => undefined);
      }
      const width = await page.evaluate(() => globalThis.document.documentElement.scrollWidth);
      console.log(
        `${path} scrollWidth=${width}${width > size.width ? " (SIDEWAYS SCROLL)" : ""}`,
        errors.length ? `errors: ${errors.join(" | ")}` : "",
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
  await pause(800);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
}
