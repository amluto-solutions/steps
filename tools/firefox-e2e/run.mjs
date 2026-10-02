// End-to-end check of Steps in Firefox: loads the built extension into a real Firefox, records a
// short task on a local test page (with a frame from another site and a reply editor), and checks
// what the recording holds: the steps, the frame click's place, the typing, the screenshots and
// the privacy rules.
//
//   STEPS_E2E=1 npm run build:firefox -w @amluto-steps/chrome
//   node tools/firefox-e2e/run.mjs
//
// The STEPS_E2E build opens the recorder's page in a tab as it's installed, since Firefox's test
// driver may not open an extension's pages itself. Build again without it before zipping.
//
// It uses the installed Firefox (or FIREFOX=<path to firefox.exe>) through WebDriver BiDi, with
// puppeteer-core. Nothing leaves the PC: the pages are served on 127.0.0.1.
/* global document, indexedDB, window -- used inside the pages it drives */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

import puppeteer from "puppeteer-core";

const root = resolve(import.meta.dirname, "..", "..");
const extension = join(root, "apps", "chrome", ".output", "firefox-mv3");
if (!existsSync(join(extension, "manifest.json"))) {
  console.error(
    "Build the extension first: STEPS_E2E=1 npm run build:firefox -w @amluto-steps/chrome",
  );
  process.exit(1);
}
const firefoxPath = process.env.FIREFOX ?? "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
if (!existsSync(firefoxPath)) {
  console.error("No Firefox found: set FIREFOX to a firefox.exe");
  process.exit(1);
}

const PAGE = `<!doctype html><html lang="en"><head><title>Invoices - Finance portal</title></head><body>
<h1>Invoices</h1>
<p>Queries to sam.tester@example.com</p>
<button id="approve"><svg width="10" height="10"></svg> Approve invoice</button>
<p><label for="supplier">Supplier</label> <input id="supplier"></p>
<p><label for="pin">Card PIN</label> <input id="pin" type="password"></p>
<p><button id="save">Save</button></p>
<iframe id="mail" src="__FRAME__" style="position:absolute;left:420px;top:40px;width:360px;height:220px;border:4px solid #888;padding:6px"></iframe>
</body></html>`;

// A mail app from another site in a frame: a button, and a reply editor holding the quoted message.
const FRAME = `<!doctype html><title>Mail</title><body style="margin:0">
<button id="send" style="margin:30px 0 0 40px">Send reply</button>
<div id="reply" contenteditable="true" aria-label="Reply" style="min-height:80px"><p><br></p><blockquote>Old message from Jo</blockquote></div>
</body>`;

const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  const port = server.address().port;
  response.end(
    request.url?.startsWith("/frame")
      ? FRAME
      : PAGE.replace("__FRAME__", `http://localhost:${port}/frame`),
  );
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const site = `http://127.0.0.1:${server.address().port}/invoices?id=42&token=secret`;

// The extension's pages get a fixed address, so the test can open them.
const UUID = "5e7d2a4c-0b1f-4c9a-9a51-7c2f3b1d9e10";
const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: firefoxPath,
  headless: true,
  extraPrefsFirefox: {
    "extensions.webextensions.uuids": JSON.stringify({ "steps@amluto.com": UUID }),
  },
});

const failures = [];
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✔" : "✘"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(what);
};
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

try {
  const id = await browser.installExtension(extension);
  check("Firefox installs the extension", id === "steps@amluto.com", id);

  // The sidebar's page, opened as a tab by the test build: the same code as in the sidebar.
  // Puppeteer reports its address as about:blank, so it's found by what it holds.
  const panelUrl = `moz-extension://${UUID}/sidepanel.html`;
  let panel = null;
  for (let tries = 0; tries < 60 && !panel; tries += 1) {
    for (const page of await browser.pages()) {
      const href = await page.evaluate(() => window.location.href).catch(() => "");
      if (href === panelUrl) panel = page;
    }
    if (!panel) await pause(250);
  }
  if (!panel) throw new Error("The recorder's page didn't open.");
  await panel.waitForFunction(() => document.body.innerText.includes("Start recording"));
  const [keys] = await panel.$$("#panel-keys");
  await keys.click(); // Record what's typed
  const [start] = await panel.$$("xpath/.//button[contains(., 'Start recording')]");
  await start.click();
  await panel.waitForFunction(
    () =>
      document.body.innerText.includes("Recording") ||
      document.body.innerText.includes("needs to see the sites"),
  );
  const refused = await panel.evaluate(() =>
    document.body.innerText.includes("needs to see the sites"),
  );
  check("recording starts, with access to the sites", !refused);

  const tab = await browser.newPage();
  await tab.goto(site);
  await tab.bringToFront();
  await pause(500);
  await tab.click("#approve svg");
  await pause(700);
  await tab.click("#supplier");
  await tab.type("#supplier", "Acme Ltd");
  await pause(700);
  await tab.click("#pin");
  await tab.type("#pin", "4321");
  await pause(700);
  const mail = tab.frames().find((frame) => frame.url().includes("/frame"));
  await mail.click("#send");
  await pause(700);
  await mail.click("#reply p");
  await tab.keyboard.type("Thanks Jo");
  await pause(700);
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
    return { left: box.left, top: box.top };
  });
  await tab.click("#save");
  await pause(900);

  await panel.bringToFront();
  const listed = await panel.$$eval("li", (items) => items.map((item) => item.textContent));
  const [stop] = await panel.$$("xpath/.//button[starts-with(normalize-space(.), 'Stop')]");
  await stop.click();
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
    const chunk = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let at = 12;
      for (let count = 0; count < 8 && at + 8 <= bytes.length; count += 1) {
        const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
        if (tag === "VP8L" || tag === "VP8 ") return tag;
        const size = new DataView(bytes.buffer, at + 4, 4).getUint32(0, true);
        at += 8 + size + (size % 2);
      }
      return "?";
    };
    const facts = (await all("facts")).map((row) => row.fact);
    const images = await Promise.all(
      (await all("images")).map(async (row) => ({
        size: row.image.size,
        type: row.image.type,
        chunk: await chunk(row.image),
      })),
    );
    return { facts, images };
  });
  const records = journal.facts.sort((a, b) => a.sequence - b.sequence).map((fact) => fact.record);
  console.log("  facts:", records.map((record) => record.kind).join(", "));
  console.log("  steps:", JSON.stringify(listed));

  const clicks = records.filter((record) => record.kind === "pageClick");
  check("each click is recorded", clicks.length === 6, `${clicks.length} of 6`);
  check(
    "the click on an icon is the button's",
    clicks[0]?.target?.tagName === "BUTTON" && clicks[0]?.target?.innerText === "Approve invoice",
  );
  const inFrame = clicks.find((record) => record.target?.innerText === "Send reply");
  const expected = {
    x: ((sendAt.x + sendBox.left) / sendAt.width) * 100,
    y: ((sendAt.y + sendBox.top) / sendAt.height) * 100,
  };
  check(
    "a click in a frame from another site is placed where it shows on the tab",
    inFrame?.elementPct != null &&
      Math.abs(inFrame.elementPct.x - expected.x) < 0.5 &&
      Math.abs(inFrame.elementPct.y - expected.y) < 0.5,
    `${JSON.stringify(inFrame?.elementPct)} for ${JSON.stringify(expected)}`,
  );
  const inputs = records.filter((record) => record.kind === "pageInput");
  const supplier = inputs.find((record) => record.target.labelText === "Supplier");
  const pin = inputs.find((record) => record.target.labelText === "Card PIN");
  const reply = inputs.find((record) => record.target.ariaLabel === "Reply");
  check("typing is recorded when asked for", supplier?.value === "Acme Ltd");
  check(
    "typing in a rich-text editor is recorded, without the quoted message",
    reply?.value === "Thanks Jo",
    JSON.stringify(reply?.value),
  );
  check(
    "a secret field's value is never read",
    pin !== undefined && pin.value === null && pin.withheld === "sensitive",
  );
  const leak = JSON.stringify(journal.facts);
  check("no address beyond the site is kept", !leak.includes("token=secret"));
  check(
    "each click has a screenshot",
    journal.images.length >= 3 &&
      journal.images.every((image) => image.size > 1000 && image.type === "image/webp"),
    `${journal.images.length} screenshots: ${journal.images.map((image) => image.chunk).join(" ")}`,
  );
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
process.exit(failures.length ? 1 : 0);
