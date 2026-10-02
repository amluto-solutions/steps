// End to end: Steps for Chrome helping Steps for Windows on the same PC
// (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
//
// A real Chromium with the extension built for the test, which has the native messaging
// permission from the start (no test can answer the browser's question); the real relay, the
// desktop's development build, started by Chromium as Chrome starts it; and a stand-in for the
// desktop app on the link's pipe, here. The development build meets the pipe named by
// AMLUTO_STEPS_LINK_PIPE, so a running Steps isn't disturbed. The host is registered for Chromium
// only (HKCU\Software\Chromium\NativeMessagingHosts), and whatever was there is put back after.
//
//   STEPS_E2E=1 npm run build -w @amluto-steps/chrome
//   cargo build --locked            (in apps/desktop/src-tauri)
//   node tools/chrome-e2e/desktop-link.mjs
//
// Chromium from Playwright's cache, or CHROMIUM=<path to chrome.exe>. Nothing leaves the PC.
/* global chrome, document -- used inside the pages it drives */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createPipeServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import puppeteer from "puppeteer-core";

const root = resolve(import.meta.dirname, "..", "..");
const extension = join(root, "apps", "chrome", ".output", "chrome-mv3");
const relay = join(root, "apps", "desktop", "src-tauri", "target", "debug", "amluto-steps.exe");
const manifestFile = join(extension, "manifest.json");
if (
  !existsSync(manifestFile) ||
  !JSON.parse(readFileSync(manifestFile, "utf8")).permissions?.includes("nativeMessaging")
) {
  console.error(
    "Build the extension for the test first: STEPS_E2E=1 npm run build -w @amluto-steps/chrome",
  );
  process.exit(1);
}
if (!existsSync(relay)) {
  console.error("Build the desktop app first: cargo build --locked (in apps/desktop/src-tauri)");
  process.exit(1);
}

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

// A page on 127.0.0.1 with a frame from another site (localhost), and a page on a site the
// person doesn't record (bank.localhost, which Chromium sends to 127.0.0.1 too).
const PAGE = `<!doctype html><title>Invoices - Finance portal</title><h1>Invoices</h1>
<button id="approve"><svg width="10" height="10"></svg> Approve invoice</button>
<iframe id="mail" src="__FRAME__" style="width:360px;height:120px"></iframe>`;
const FRAME = `<!doctype html><title>Mail</title><button id="send">Send reply</button>`;
const BANK = `<!doctype html><title>Bank</title><button id="pay">Pay supplier</button>`;
const http = createHttpServer((request, response) => {
  const port = http.address().port;
  response.setHeader("content-type", "text/html");
  response.end(
    request.headers.host?.startsWith("bank.")
      ? BANK
      : request.url?.startsWith("/frame")
        ? FRAME
        : PAGE.replace("__FRAME__", `http://localhost:${port}/frame`),
  );
});
await new Promise((ok) => http.listen(0, "127.0.0.1", ok));
const port = http.address().port;

// The stand-in for the desktop app: the link's protocol over the pipe
// (src-tauri/src/browser_link/protocol.rs).
const pipeName = `\\\\.\\pipe\\amluto-steps-link-e2e-${process.pid}`;
const heard = [];
let appEnd = null;
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  appEnd?.write(Buffer.concat([head, body]));
};
const app = createPipeServer((socket) => {
  appEnd = socket;
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      heard.push(message);
      if (message.type === "hello") send({ type: "hello", protocol: 1, version: "0.4.3" });
    }
  });
  socket.on("close", () => {
    if (appEnd === socket) appEnd = null;
  });
});

// The host, registered for Chromium only, as the app registers it for Chrome and Edge.
const HOST_KEY = "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.amluto.steps";
const reg = (...args) => execFileSync("reg.exe", args, { encoding: "utf8", stdio: "pipe" });
let previous = null;
try {
  previous = /REG_SZ\s+(.+)/.exec(reg("query", HOST_KEY, "/ve"))?.[1]?.trim() ?? null;
} catch {
  previous = null;
}
const scratch = mkdtempSync(join(tmpdir(), "steps-e2e-link-"));

const profile = join(scratch, "profile");
const browser = await puppeteer.launch({
  executablePath: chromium(),
  headless: true,
  userDataDir: profile,
  protocolTimeout: 30_000,
  env: { ...process.env, AMLUTO_STEPS_LINK_PIPE: pipeName },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

const failures = [];
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✔" : "✘"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(what);
};
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
const waitFor = async (test, timeout = 10_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (test()) return true;
    await pause(100);
  }
  return false;
};
const waitForText = (page, wanted, timeout = 15_000) =>
  page
    .waitForFunction(
      (words) => document.body.innerText.includes(words),
      { timeout, polling: 250 },
      wanted,
    )
    .then(
      () => true,
      () => false,
    );
const clicks = () => heard.filter((message) => message.type === "click");

try {
  const worker = await browser.waitForTarget(
    (target) => target.type() === "service_worker" && target.url().endsWith("background.js"),
  );
  const id = new URL(worker.url()).host;
  const manifest = join(scratch, "com.amluto.steps.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      name: "com.amluto.steps",
      description: "Steps by Amluto (end-to-end test)",
      path: relay,
      type: "stdio",
      allowed_origins: [`chrome-extension://${id}/`],
    }),
  );
  reg("add", HOST_KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f");

  // Settings > Recording in the Steps tab.
  const steps = await browser.newPage();
  await steps.setViewport({ width: 1280, height: 900 });
  await steps.goto(`chrome-extension://${id}/app.html`);
  // Past the first run: a name, and the library in this browser.
  await steps.evaluate(() =>
    chrome.storage.local.set({
      preferences: { displayName: "Robin Hale", libraryFolder: "browser" },
    }),
  );
  await steps.reload();
  await waitForText(steps, "0 guides");
  await steps.$eval('[data-tour="settings"]', (button) => button.click());
  await waitForText(steps, "Recording");
  await steps.$$eval("button", (buttons) =>
    buttons.find((button) => button.textContent?.trim() === "Recording")?.click(),
  );
  check(
    "the extension offers to help Steps for Windows",
    await waitForText(steps, "Help Steps for Windows"),
  );

  // Switched on with no app on the pipe: the relay says so.
  const linkSwitch = () =>
    steps.$eval('[role="switch"][aria-labelledby="link-label"]', (toggle) => toggle.click());
  await linkSwitch();
  check(
    "with no app running, it says Steps for Windows isn't running",
    await waitForText(steps, "isn't running"),
  );

  // The app starts; switched off and on, it connects.
  await new Promise((ok) => app.listen(pipeName, ok));
  await linkSwitch();
  await pause(300);
  await linkSwitch();
  check(
    "it connects to the app and says so",
    await waitForText(steps, "Connected to Steps for Windows."),
  );
  const hello = heard.find((message) => message.type === "hello");
  check(
    "it says hello with the protocol and the browser",
    hello?.protocol === 1 && hello?.browser === "chrome" && typeof hello?.version === "string",
    JSON.stringify(hello),
  );

  // A site the person doesn't record, added in Settings.
  const [siteInput] = await steps.$$("input[placeholder]");
  const inputs = await steps.$$("input");
  let added = false;
  for (const input of inputs) {
    const label = await input.evaluate((element) => element.getAttribute("aria-label") ?? "");
    if (/site/i.test(label)) {
      await input.type("bank.localhost");
      await input.press("Enter");
      added = true;
      break;
    }
  }
  if (!added && siteInput) {
    await siteInput.type("bank.localhost");
    await siteInput.press("Enter");
  }
  check("a site not to record is added", await waitForText(steps, "bank.localhost"));

  // The app starts recording: pages report their clicks.
  send({ type: "recording", on: true });
  await pause(800);
  const tab = await browser.newPage();
  await tab.goto(`http://127.0.0.1:${port}/invoices?id=42&token=secret`);
  await pause(500);
  await tab.click("#approve svg");
  check("a click in a page reaches the app", await waitFor(() => clicks().length >= 1));
  const [approve] = clicks();
  check(
    "with the element the click meant, the tab's title and how long ago",
    approve?.target?.tagName === "BUTTON" &&
      approve?.target?.innerText === "Approve invoice" &&
      approve?.title === "Invoices - Finance portal" &&
      approve?.ageMs >= 0 &&
      approve?.ageMs < 5_000,
    JSON.stringify(approve),
  );
  check("never the page's address", !JSON.stringify(heard).includes("token=secret"));

  const mail = tab.frames().find((frame) => frame.url().includes("/frame"));
  await mail.click("#send");
  check(
    "a click in a frame from another site reaches it too",
    await waitFor(() => clicks().length >= 2),
  );
  check(
    "with the frame's element",
    clicks()[1]?.target?.innerText === "Send reply",
    JSON.stringify(clicks()[1]),
  );

  await tab.goto(`http://bank.localhost:${port}/pay`);
  await pause(500);
  await tab.click("#pay");
  await pause(800);
  check(
    "nothing from a site not recorded",
    clicks().length === 2,
    JSON.stringify(clicks().slice(2)),
  );

  // The app stops: clicks aren't reported.
  send({ type: "recording", on: false });
  await pause(800);
  await tab.goto(`http://127.0.0.1:${port}/invoices`);
  await pause(500);
  await tab.click("#approve");
  await pause(800);
  check("nothing once the app has stopped recording", clicks().length === 2);
  const stillIn = await tab.evaluate(() => Boolean(globalThis.__stepsCapture));
  check("and the capture script isn't in new pages", !stillIn);

  // Switched off in Settings: the connection closes.
  await steps.bringToFront();
  await linkSwitch();
  check("switched off, the connection closes", await waitFor(() => appEnd === null));
} catch (error) {
  check("the run finished", false, String(error?.stack ?? error));
} finally {
  await browser.close().catch(() => undefined);
  app.close();
  http.close();
  try {
    if (previous) reg("add", HOST_KEY, "/ve", "/t", "REG_SZ", "/d", previous, "/f");
    else reg("delete", HOST_KEY, "/f");
  } catch {
    // Nothing there to remove.
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(
  failures.length === 0 ? "\nAll checks passed." : `\n${failures.length} check(s) failed.`,
);
process.exit(failures.length === 0 ? 0 : 1);
