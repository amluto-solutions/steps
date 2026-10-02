// The Store's art and screenshots at the sizes Partner Center asks for, all drawn in headless
// Edge: `node store/art/render.mjs` from the repo root. Run it after
// `node apps/website/scripts/capture.mjs` (so the screenshots show the current app) and with the
// website's dev server up (`npm run dev -w @amluto-steps/website`, for the web-export demo).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import puppeteer from "puppeteer-core";

const root = join(import.meta.dirname, "..", "..");
const art = join(root, "store", "art");
const shots = join(root, "store", "screenshots");
const captures = join(root, "apps", "website", "src", "assets", "shots");
const SITE = process.env.SITE_URL ?? "http://localhost:4175/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9351;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const file = (path) => pathToFileURL(path).href;

spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "steps-store-"))}`,
    "--allow-file-access-from-files",
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

/** A page of the given size; the first screenshot of a new page can come out tiled. */
async function page(width, height, scale = 1) {
  const tab = await browser.newPage();
  await tab.setViewport({ width, height, deviceScaleFactor: scale });
  return tab;
}
async function save(tab, path) {
  await tab.screenshot({ type: "png" });
  await tab.screenshot({ path, type: "png" });
  await tab.close();
  console.log(path.slice(root.length + 1));
}
/** An image file drawn to fill a page of exactly its size, saved as PNG. */
async function asPng(image, path, width, height, scale = 1) {
  const tab = await page(width, height, scale);
  await tab.goto(file(image));
  await tab.addStyleTag({
    content: `html,body{margin:0;background:#fff}img{display:block;width:${width}px;height:${height}px}`,
  });
  await save(tab, path);
}

try {
  // Edge's first double-resolution screenshot in a session can come out tiled (a grid of repeated
  // fragments), whatever the page: take one to throw away before any that are kept.
  const warmUp = await page(1440, 900, 2);
  await warmUp.goto(file(join(captures, "library-light.webp")));
  await warmUp.screenshot({ type: "png" });
  await warmUp.screenshot({ type: "png" });
  await warmUp.close();

  // Box and poster art.
  for (const [shape, width, height, name] of [
    ["box", 2160, 2160, "box-art-2160.png"],
    ["poster", 1440, 2160, "poster-art-1440x2160.png"],
    // The browser stores' small promo tile (docs/chrome-web-store.md).
    ["tile", 440, 280, "promo-tile-440x280.png"],
  ]) {
    const tab = await page(width, height);
    await tab.goto(`${file(join(art, "art.html"))}?shape=${shape}`, { waitUntil: "networkidle0" });
    await tab.evaluate(() => globalThis.document.fonts.ready);
    await save(tab, join(art, name));
  }
  // The Store logo: the app's own icon.
  await asPng(
    join(root, "apps", "desktop", "src-tauri", "icons", "icon.png"),
    join(art, "store-logo-300.png"),
    300,
    300,
  );

  // Screenshots, 2880 × 1800, in the listing's order. The web export is the demo itself.
  mkdirSync(join(shots, "dark"), { recursive: true });
  const order = [
    "editor",
    "library",
    "export-review",
    "web-export",
    "brand-editor",
    "start-dialog",
  ];
  for (const [index, name] of order.entries()) {
    const target = `${String(index + 1).padStart(2, "0")}-${name}.png`;
    for (const [theme, folder] of [
      ["light", shots],
      ["dark", join(shots, "dark")],
    ]) {
      if (name === "web-export") {
        // An exported guide has the brand's own (light) colours in either theme.
        const tab = await page(1440, 900, 2);
        await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
        await tab.goto(new URL("demo/index.html", SITE).href, { waitUntil: "networkidle0" });
        await tab.keyboard.press("ArrowRight");
        await pause(2500);
        await save(tab, join(folder, target));
      } else {
        await asPng(join(captures, `${name}-${theme}.webp`), join(folder, target), 1440, 900, 2);
      }
    }
  }
} finally {
  await browser.close();
}
