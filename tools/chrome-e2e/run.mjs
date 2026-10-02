// End-to-end check of Steps for Chrome: loads the built extension into a real Chromium, records a
// short task on a local test page, and checks the steps, screenshots, privacy rules and exports.
//
//   npm run build -w @amluto-steps/chrome
//   node tools/chrome-e2e/run.mjs
//
// QUALITY=original records at "Original" screenshot quality, and checks each screenshot is
// lossless WebP.
//
// It uses Playwright's Chromium from %LOCALAPPDATA%\ms-playwright (or CHROMIUM=<path to chrome.exe>)
// and puppeteer-core. Nothing leaves the PC: the pages are served on 127.0.0.1.
/* global document, indexedDB, window -- used inside the pages it drives */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import puppeteer from "puppeteer-core";

const root = resolve(import.meta.dirname, "..", "..");
const extension = join(root, "apps", "chrome", ".output", "chrome-mv3");
if (!existsSync(join(extension, "manifest.json"))) {
  console.error("Build the extension first: npm run build -w @amluto-steps/chrome");
  process.exit(1);
}

function chromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  const versions = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort();
  const found = versions
    .map((name) => join(cache, name, "chrome-win64", "chrome.exe"))
    .filter(existsSync)
    .at(-1);
  if (!found) throw new Error("No Chromium found: set CHROMIUM to a chrome.exe");
  return found;
}

const PAGE = `<!doctype html><html lang="en"><head><title>Invoices - Finance portal</title></head><body>
<h1>Invoices</h1>
<p>Queries to sam.tester@example.com</p>
<button id="approve"><svg width="10" height="10"></svg> Approve invoice</button>
<p><label for="supplier">Supplier</label> <input id="supplier"></p>
<p><label for="pin">Card PIN</label> <input id="pin" type="password"></p>
<p><button id="save">Save</button> <a id="away" href="__OTHER__">Bank</a></p>
<iframe id="mail" src="__FRAME__" style="position:absolute;left:420px;top:40px;width:360px;height:220px;border:4px solid #888;padding:6px"></iframe>
</body></html>`;

// A mail app from another site in a frame: a button, and a reply editor holding the quoted message.
const FRAME = `<!doctype html><title>Mail</title><body style="margin:0">
<button id="send" style="margin:30px 0 0 40px">Send reply</button>
<div id="reply" contenteditable="true" aria-label="Reply" style="min-height:80px"><p><br></p><blockquote>Old message from Jo</blockquote></div>
</body>`;

// Two origins: the page, and a second site to go to.
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  const other = `http://localhost:${server.address().port}/bank`;
  response.end(
    request.url?.startsWith("/bank")
      ? `<!doctype html><title>Bank</title><button id="pay">Pay</button>`
      : request.url?.startsWith("/frame")
        ? FRAME
        : PAGE.replace("__OTHER__", other).replace(
            "__FRAME__",
            `http://localhost:${server.address().port}/frame`,
          ),
  );
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const site = `http://127.0.0.1:${server.address().port}/invoices?id=42&token=secret`;

const profile = mkdtempSync(join(tmpdir(), "steps-e2e-"));
const browser = await puppeteer.launch({
  executablePath: chromium(),
  headless: true,
  userDataDir: profile,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

const failures = [];
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✔" : "✘"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(what);
};
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

try {
  const worker = await browser.waitForTarget(
    (target) => target.type() === "service_worker" && target.url().endsWith("background.js"),
  );
  const id = new URL(worker.url()).host;

  // The side panel, opened as a page: the same code as in Chrome's panel.
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  // In front: the test build also opens the recorder in a tab as it's installed (for Firefox's
  // driver), and a tab behind it draws no frames, which the waits below poll on (02/10/2026).
  await panel.bringToFront();
  await panel.waitForFunction(() => document.body.innerText.includes("Start recording"));
  const original = process.env.QUALITY === "original";
  if (original)
    await panel.evaluate(() =>
      window.localStorage.setItem("amluto-steps-screenshot-quality", "original"),
    );
  const [keys] = await panel.$$("#panel-keys");
  await keys.click(); // Record what's typed
  await panel.$$eval("button", (buttons) =>
    buttons.find((button) => button.textContent?.includes("Start recording"))?.click(),
  );
  await panel.waitForFunction(() => document.body.innerText.includes("Recording"));

  const tab = await browser.newPage();
  await tab.goto(site);
  await tab.bringToFront();
  await pause(300);
  await tab.click("#approve svg");
  await pause(700);
  await tab.click("#supplier");
  await tab.type("#supplier", "Acme Ltd");
  await pause(700);
  await tab.click("#pin");
  await tab.type("#pin", "4321");
  await pause(700);
  // Inside the frame from another site: a click, then typing in its rich-text editor.
  const mail = tab.frames().find((frame) => frame.url().includes("/frame"));
  await mail.click("#send");
  await pause(700);
  await mail.click("#reply p");
  await tab.keyboard.type("Thanks Jo");
  await pause(700);
  // Where the Send button shows on the tab, as percentages of the view.
  const sendAt = await tab.evaluate(() => {
    const frame = document.getElementById("mail");
    const box = frame.getBoundingClientRect();
    return {
      x: box.left + frame.clientLeft + 6,
      y: box.top + frame.clientTop + 6,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  const sendBox = await mail.$eval("#send", (button) => {
    const box = button.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  });
  await tab.click("#save");
  await pause(700);
  await tab.click("#away");
  await tab.waitForSelector("#pay");
  await pause(700);
  await tab.click("#pay");
  await pause(700);

  await panel.bringToFront();
  // The panel lists the steps as they're recorded, worded by the shared rules.
  const listed = await panel.$$eval("li", (items) => items.map((item) => item.textContent));
  // SHOTS=<folder> keeps pictures of the side panel and the Steps tab, to look at.
  const shots = process.env.SHOTS;
  if (shots) {
    await panel.setViewport({ width: 400, height: 640 });
    await panel.screenshot({ path: join(shots, "panel-recording.png") });
  }
  // Stop recording the second site from the panel: a click there afterwards isn't kept.
  const offered = await panel.$$eval("button", (buttons) => {
    const exclude = buttons.find((button) =>
      button.textContent?.trim().startsWith("Don't record localhost"),
    );
    exclude?.click();
    return Boolean(exclude);
  });
  check("the panel offers to stop recording the site", offered);
  await panel.waitForFunction(() => document.body.innerText.includes("won't be recorded"));
  const remembered = await panel.evaluate(() =>
    window.localStorage.getItem("amluto-steps-excluded-sites"),
  );
  check("the site stays excluded for next time", remembered === '["localhost"]', remembered);
  await tab.bringToFront();
  await tab.click("#pay");
  await pause(700);
  await panel.bringToFront();

  await panel.$$eval("button", (buttons) =>
    buttons.find((button) => button.textContent?.trim().startsWith("Stop"))?.click(),
  );
  await panel.waitForFunction(() => document.body.innerText.includes("ready to review"));

  // What the recording holds, read from its journal in the extension's storage.
  const journal = await panel.evaluate(async () => {
    const db = await new Promise((ok, fail) => {
      const request = indexedDB.open("steps-recordings");
      request.onsuccess = () => ok(request.result);
      request.onerror = () => fail(request.error);
    });
    const all = (store) =>
      new Promise((ok) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => ok(request.result);
      });
    const facts = (await all("facts")).map((row) => row.fact);
    // The image chunk's id: VP8L is lossless, "VP8 " lossy (after VP8X and ICCP, if any).
    const chunk = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let at = 12;
      for (let count = 0; count < 8 && at + 8 <= bytes.length; count += 1) {
        const id = String.fromCharCode(...bytes.subarray(at, at + 4));
        if (id === "VP8L" || id === "VP8 ") return id;
        const size = new DataView(bytes.buffer, at + 4, 4).getUint32(0, true);
        at += 8 + size + (size % 2);
      }
      return "?";
    };
    const images = await Promise.all(
      (await all("images")).map(async (row) => ({
        size: row.image.size,
        type: row.image.type,
        width: row.width,
        chunk: await chunk(row.image),
      })),
    );
    return { facts, images };
  });
  const records = journal.facts.sort((a, b) => a.sequence - b.sequence).map((fact) => fact.record);
  const kinds = records.map((record) => record.kind);
  console.log("  facts:", kinds.join(", "));

  const clicks = records.filter((record) => record.kind === "pageClick");
  check("each click is recorded", clicks.length === 8, `${clicks.length} of 8`);
  const inFrame = clicks.find((record) => record.target?.innerText === "Send reply");
  const expected = {
    x: ((sendAt.x + sendBox.left) / sendAt.width) * 100,
    y: ((sendAt.y + sendBox.top) / sendAt.height) * 100,
  };
  check(
    "a click in a frame from another site is placed where it shows on the tab",
    inFrame?.elementPct !== null &&
      inFrame?.elementPct !== undefined &&
      Math.abs(inFrame.elementPct.x - expected.x) < 0.5 &&
      Math.abs(inFrame.elementPct.y - expected.y) < 0.5,
    `${JSON.stringify(inFrame?.elementPct)} for ${JSON.stringify(expected)}`,
  );
  check(
    "the click on an icon is the button's",
    clicks[0]?.target?.tagName === "BUTTON" && clicks[0]?.target?.innerText === "Approve invoice",
  );
  const inputs = records.filter((record) => record.kind === "pageInput");
  const supplier = inputs.find((record) => record.target.labelText === "Supplier");
  const pin = inputs.find((record) => record.target.labelText === "Card PIN");
  check("typing is recorded when asked for", supplier?.value === "Acme Ltd");
  const reply = inputs.find((record) => record.target.ariaLabel === "Reply");
  check(
    "typing in a rich-text editor is recorded, without the quoted message",
    reply?.value === "Thanks Jo",
    JSON.stringify(reply?.value),
  );
  const editorClick = clicks.find((record) => record.target?.ariaLabel === "Reply");
  check(
    "a click in an editor never carries its words",
    editorClick !== undefined && editorClick.target.innerText === undefined,
  );
  check(
    "a secret field's value is never read",
    pin !== undefined && pin.value === null && pin.withheld === "sensitive",
  );
  const sites = records
    .filter((record) => record.kind === "pageNavigation")
    .map((record) => record.origin);
  check(
    "changing site is a step",
    sites.some((origin) => origin.startsWith("http://localhost")),
    sites.join(" "),
  );
  const leak = JSON.stringify(journal.facts);
  const at = leak.indexOf("token=secret");
  check(
    "no address beyond the site is kept",
    at < 0,
    at < 0 ? "" : leak.slice(Math.max(0, at - 200), at + 40),
  );
  check(
    original
      ? "each screenshot is lossless (Original)"
      : "each screenshot is lossy WebP (Balanced)",
    journal.images.every((image) => image.chunk === (original ? "VP8L" : "VP8 ")),
    journal.images.map((image) => image.chunk).join(" "),
  );
  check(
    "each click has a screenshot",
    journal.images.length >= 3 &&
      journal.images.every((image) => image.size > 1000 && image.type === "image/webp"),
    `${journal.images.length} WebP screenshots`,
  );

  console.log("  steps:", JSON.stringify(listed));
  check(
    "the steps read as the desktop's would",
    listed.includes('Click "Approve invoice"') && listed.includes('Click "Save"'),
  );

  // Review and save in the Steps tab: the recording becomes a guide in the library.
  const app = await browser.newPage();
  await app.goto(`chrome-extension://${id}/app.html`);
  const clickText = (text) =>
    app.$$eval(
      "button",
      (buttons, wanted) => buttons.find((button) => button.textContent?.trim() === wanted)?.click(),
      text,
    );
  // A first run asks for a name.
  const welcome = await app
    .waitForFunction(
      () =>
        document.body.innerText.includes("A recording is not saved yet") ||
        document.querySelector("#welcome-name"),
      { timeout: 10_000 },
    )
    .then(() => app.$("#welcome-name"));
  if (welcome) {
    await welcome.type("Sam Tester");
    await app.$$eval("button[type=submit], button", (buttons) =>
      buttons
        .find((button) => /continue|get started|save/i.test(button.textContent ?? ""))
        ?.click(),
    );
  }
  await app.waitForFunction(
    () => document.body.innerText.includes("A recording is not saved yet"),
    { timeout: 10_000 },
  );
  await clickText("Review and save");
  await app.waitForFunction(() => document.body.innerText.includes("Save guide"), {
    timeout: 10_000,
  });
  const draftSteps = await app.$$eval("[data-step-button]", (buttons) =>
    buttons.map((button) => button.textContent),
  );
  check("the draft opens with every step", draftSteps.length >= 9, `${draftSteps.length} steps`);
  check(
    "typing sits before the click that ended it",
    draftSteps.findIndex((text) => text?.includes("Acme Ltd")) <
      draftSteps.findIndex((text) => text?.includes('"Save"')),
  );
  await clickText("Save guide");
  await app.waitForFunction(() => !document.body.innerText.includes("Save guide"), {
    timeout: 10_000,
  });
  const saved = await app.evaluate(async () => {
    const db = await new Promise((ok) => {
      const request = indexedDB.open("steps-library");
      request.onsuccess = () => ok(request.result);
    });
    const all = (store) =>
      new Promise((ok) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => ok(request.result);
      });
    return {
      guides: await all("guides"),
      steps: (await all("steps")).length,
      media: (await all("media")).length,
    };
  });
  check(
    "Save puts the guide in the library, with its screenshots",
    saved.guides.length === 1 && saved.steps >= 9 && saved.media >= 3,
    `${saved.guides.length} guide, ${saved.steps} steps, ${saved.media} screenshots, by ${saved.guides[0]?.guide.owner}`,
  );

  // Each export format lands in Chrome's downloads.
  const downloads = mkdtempSync(join(tmpdir(), "steps-e2e-downloads-"));
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  // "Use my installed fonts", allowed as a person would from the brand editor: the Amluto
  // brand's Century Gothic then goes into the PDF from this PC's fonts, where it's installed.
  await cdp.send("Browser.grantPermissions", {
    origin: `chrome-extension://${id}`,
    permissions: ["localFonts"],
  });
  const gothic = existsSync(join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "GOTHIC.TTF"));
  const formats = [
    { item: "PDF", button: "Export PDF", extension: ".pdf", magic: "%PDF" },
    { item: "Word document", button: "Export Word", extension: ".docx", magic: "PK" },
    { item: "Web page", button: "Export web page", extension: ".html", magic: "<!doctype" },
  ];
  for (const format of formats) {
    // Save opens the guide in the editor; its Export menu (or the library card's) has the formats.
    await app.$$eval("button", (buttons) =>
      buttons
        .find(
          (button) => button.dataset.tour === "export" || button.textContent?.trim() === "Export",
        )
        ?.click(),
    );
    // An entry is enabled once the guide is ready to export.
    await app.waitForFunction(
      (wanted) => {
        const item = [...document.querySelectorAll("[role=menuitem]")].find(
          (each) => each.querySelector(".font-medium")?.textContent === wanted,
        );
        if (!item || item.disabled) return false;
        item.click();
        return true;
      },
      { timeout: 30_000 },
      format.item,
    );
    await app.waitForFunction(
      (wanted) =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === wanted && !button.disabled,
        ),
      { timeout: 30_000 },
      format.button,
    );
    if (format.item === "PDF") {
      // The review reads each screenshot's words (the page's own text, kept as it was taken)
      // and flags the email address on the invoice page as not blurred.
      const review = await app
        .waitForFunction(
          () => {
            const text = document.body.innerText;
            if (text.includes("Looking for personal data")) return null;
            return /possible personal details? (isn|aren)/.test(text)
              ? "flagged"
              : text.includes("No personal data was found")
                ? "nothing found"
                : null;
          },
          { timeout: 30_000 },
        )
        .then((handle) => handle.jsonValue());
      check("the export review flags an email shown on the page", review === "flagged", review);
    }
    await clickText(format.button);
    let file;
    for (let tries = 0; tries < 60 && !file; tries += 1) {
      await pause(500);
      file = readdirSync(downloads).find((name) => name.endsWith(format.extension));
    }
    const bytes = file ? readFileSync(join(downloads, file)) : Buffer.alloc(0);
    const head = bytes.subarray(0, 9).toString("latin1");
    if (format.item === "PDF") {
      // Tagged, from the browser's own build of pdfmake (docs/spec/05-export.md#tagged-pdf): a
      // structure tree with the title as its heading and each screenshot a figure. (Page
      // furniture is marked inside the compressed page streams: pdf-tags.test.ts reads those.)
      const raw = bytes.toString("latin1");
      const figures = (raw.match(/\/S \/Figure/g) ?? []).length;
      check(
        "the PDF is tagged, with a figure for each screenshot",
        raw.includes("/StructTreeRoot") &&
          /\/Marked true/.test(raw) &&
          raw.includes("/S /H1") &&
          figures === saved.media,
        `${figures} figures for ${saved.media} screenshots`,
      );
    }
    if (format.item === "PDF" && gothic)
      check(
        "the PDF embeds the brand's installed font",
        /\/FontName \/[A-Z]{6}\+CenturyGothic/.test(bytes.toString("latin1")),
      );
    check(
      `${format.item} export downloads`,
      head.toLowerCase().startsWith(format.magic.toLowerCase()),
      file ?? "nothing downloaded",
    );
    await app.waitForFunction(() => !document.querySelector("#export-title"), {
      timeout: 10_000,
    });
  }
  rmSync(downloads, { recursive: true, force: true });

  if (process.env.SHOTS) {
    await app.setViewport({ width: 1280, height: 800 });
    await pause(500);
    await app.screenshot({ path: join(process.env.SHOTS, "app-library.png") });
    await clickText("Settings");
    await pause(500);
    await app.screenshot({ path: join(process.env.SHOTS, "app-settings.png") });
  }
} catch (error) {
  failures.push(String(error));
  console.error(error);
  // What the last page showed, to see where it stopped.
  const last = (await browser.pages()).at(-1);
  const shown = await last?.evaluate(() => document.body.innerText).catch(() => "");
  console.error(`  ${last?.url()} shows:
${shown?.slice(0, 1500)}`);
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
process.exit(failures.length ? 1 : 0);
