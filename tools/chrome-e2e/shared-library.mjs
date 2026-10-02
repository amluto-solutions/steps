// End to end: a shared library in Steps for Chrome (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome).
//
// A real Chromium with the extension, built for the test (`STEPS_E2E=1 npm run build -w
// @amluto-steps/chrome`), which picks a folder in the browser's private file system: no test
// driver can answer the folder picker, and the private file system has the same API. The folder
// starts as the shared-library fixture the desktop writes (packages/core/test-vectors/library-folder:
// Sam is editing a guide on another PC, with conflict copies, a step brought back, comments, a
// draft and a version). In the Steps tab, the test adds the folder as a library, makes it the one
// new recordings go to, opens Sam's guide read-only, takes over editing, settles every conflict
// and closes the guide; then records in a page and saves. Last, the folder is copied out to disk
// and the desktop's library code reads it (crates/library/tests/library_folder.rs).
//
// `node tools/chrome-e2e/shared-library.mjs` (Chromium from Playwright's cache, or CHROMIUM).
/* global chrome, document -- used inside the pages it drives */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import puppeteer from "puppeteer-core";

const root = resolve(import.meta.dirname, "..", "..");
const extension = join(root, "apps", "chrome", ".output", "chrome-mv3");
const fixture = join(root, "packages", "core", "test-vectors", "library-folder");
if (!existsSync(join(extension, "manifest.json"))) {
  console.error("Build the extension first: STEPS_E2E=1 npm run build -w @amluto-steps/chrome");
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

/** Every file under `folder`, relative with `/`, as base64. */
function filesOf(folder) {
  const found = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        found[relative(folder, path).replaceAll("\\", "/")] = readFileSync(path).toString("base64");
    }
  };
  walk(folder);
  return found;
}

const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(
    `<!doctype html><title>Payroll - HR portal</title><h1>Payroll</h1><button id="run">Run payroll</button> <button id="send">Send payslips</button>`,
  );
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const site = `http://127.0.0.1:${server.address().port}/payroll`;

const profile = mkdtempSync(join(tmpdir(), "steps-e2e-shared-"));
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
const text = (page) => page.evaluate(() => document.body.innerText);
/** Clicks the first button whose words are `wanted` (or start with it); false when there's none. */
const clickButton = (page, wanted, { starts = false } = {}) =>
  page.$$eval(
    "button",
    (buttons, [label, prefix]) => {
      const found = buttons.find((button) => {
        const words = button.textContent?.trim() ?? "";
        return (prefix ? words.startsWith(label) : words === label) && !button.disabled;
      });
      found?.click();
      return Boolean(found);
    },
    [wanted, starts],
  );
const waitForText = (page, wanted, timeout = 15_000) =>
  // Timed polling: animation frames, the default, don't run in a tab that isn't in front.
  page.waitForFunction(
    (words) => document.body.innerText.includes(words),
    { timeout, polling: 250 },
    wanted,
  );

/** The test folder's files, read back through the browser's private file system. */
const folderFiles = (page) =>
  page.evaluate(async () => {
    const found = {};
    const walk = async (dir, prefix) => {
      for await (const [name, child] of dir.entries()) {
        if (child.kind === "directory") await walk(child, `${prefix}${name}/`);
        else {
          const bytes = new Uint8Array(await (await child.getFile()).arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          found[`${prefix}${name}`] = btoa(binary);
        }
      }
    };
    const top = await navigator.storage.getDirectory();
    await walk(await top.getDirectoryHandle("Shared guides"), "");
    return found;
  });
const jsonOf = (files, path) =>
  files[path] ? JSON.parse(Buffer.from(files[path], "base64").toString("utf8")) : null;

try {
  const worker = await browser.waitForTarget(
    (target) => target.type() === "service_worker" && target.url().endsWith("background.js"),
  );
  const id = new URL(worker.url()).host;
  const app = await browser.newPage();
  await app.setViewport({ width: 1280, height: 900 });
  await app.goto(`chrome-extension://${id}/app.html`);

  // Robin, and the folder as the desktop left it on Sam's PC.
  await app.evaluate(async (files) => {
    await chrome.storage.local.set({
      preferences: { displayName: "Robin Hale", libraryFolder: "browser" },
    });
    const top = await navigator.storage.getDirectory();
    const folder = await top.getDirectoryHandle("Shared guides", { create: true });
    for (const [path, data] of Object.entries(files)) {
      const parts = path.split("/");
      let dir = folder;
      for (const part of parts.slice(0, -1))
        dir = await dir.getDirectoryHandle(part, { create: true });
      const file = await dir.getFileHandle(parts.at(-1), { create: true });
      const writable = await file.createWritable();
      await writable.write(Uint8Array.from(atob(data), (character) => character.charCodeAt(0)));
      await writable.close();
    }
  }, filesOf(fixture));
  await app.reload();
  // Started: the library has been listed.
  await waitForText(app, "0 guides");

  // Settings → Libraries → Add a library…
  await app.$eval('[data-tour="settings"]', (button) => button.click());
  await waitForText(app, "Libraries");
  check("Settings has Libraries in Chrome", await clickButton(app, "Libraries"));
  await waitForText(app, "In this browser");
  await clickButton(app, "Add a library…");
  await waitForText(app, "Shared guides");
  await waitForText(app, "2 guides");
  check("the folder is a library, with the desktop's two guides", true);
  await clickButton(app, "Use for new recordings");
  await pause(500);
  const libraries = await text(app);
  check(
    "it is where new recordings go",
    /Shared guides[\s\S]*New recordings go here/.test(libraries),
  );

  // Back to the guides, in the shared library.
  await clickButton(app, "Guides");
  await app.waitForSelector("select");
  const choice = await app.$$eval(
    "select option",
    (options) => options.find((option) => option.textContent === "Shared guides")?.value,
  );
  await app.select("select", choice);
  await waitForText(app, "Pay a supplier invoice");
  const cards = await text(app);
  check(
    "the guides the desktop wrote are listed",
    cards.includes("Pay a supplier invoice") && cards.includes("Claim expenses"),
  );

  // Sam is editing it: read-only, with every conflict shown.
  await app.$$eval("button, a, [role=button]", (items) =>
    items.find((item) => item.textContent?.includes("Pay a supplier invoice"))?.click(),
  );
  await waitForText(app, "Sam Jones is editing this guide");
  check("a guide someone else is editing opens read-only", true);
  await waitForText(app, "deleted the step");
  const opened = await text(app);
  check(
    "the sync conflicts and the restored step are shown",
    (opened.match(/changed in two places at once/g) ?? []).length === 2 &&
      opened.includes("deleted the step"),
  );
  // Reading it writes nothing: no step re-saved, no draft (the notes editor once re-saved a
  // note as soon as it was shown, which a read-only guide turned into a draft).
  await pause(3000);
  const read = await folderFiles(app);
  const unchanged = (path) => read[path] === filesOf(join(fixture))[path];
  check(
    "reading a guide someone else is editing changes nothing",
    unchanged("guides/payroll/steps/step-1.json") &&
      unchanged("guides/payroll/guide.json") &&
      Object.keys(read).filter((path) => path.startsWith("guides/payroll/drafts/")).length === 1,
    Object.keys(read)
      .filter((path) => path.startsWith("guides/payroll/drafts/"))
      .join(" "),
  );
  await clickButton(app, "Take over editing");
  await waitForText(app, "Take over editing from Sam Jones?");
  await app.$$eval("[role=alertdialog] button", (buttons) =>
    buttons.find((button) => button.textContent?.trim() === "Take over editing")?.click(),
  );
  await app.waitForFunction(
    () => !document.body.innerText.includes("Sam Jones is editing this guide"),
    { timeout: 15_000, polling: 250 },
  );
  const taken = jsonOf(await folderFiles(app), "guides/payroll/.lock");
  check(
    "taking over writes Robin's lock",
    taken?.name === "Robin Hale" &&
      taken.session !== "sam-session" &&
      taken.pc.startsWith("browser-"),
    JSON.stringify(taken),
  );

  // Settle each: both versions of step 1, the guide's own details, and keep the step Sam changed.
  check("keep both versions of the step", await clickButton(app, "Keep both"));
  await pause(800);
  check(
    "keep the guide details in the guide",
    await clickButton(app, 'Keep "Pay a supplier invoice"', { starts: true }),
  );
  await pause(800);
  check("keep the step that came back", await clickButton(app, "Keep it"));
  await app.waitForFunction(
    () =>
      !document.body.innerText.includes("changed in two places at once") &&
      !document.body.innerText.includes("deleted the step"),
    { timeout: 15_000, polling: 250 },
  );
  const settled = await folderFiles(app);
  check(
    "each conflict copy and delete note is gone once settled",
    !Object.keys(settled).some(
      (path) =>
        path.startsWith("guides/payroll/") &&
        (path.includes("SAMS-PC") || path.startsWith("guides/payroll/deleted/")),
    ),
    Object.keys(settled)
      .filter((path) => path.startsWith("guides/payroll/"))
      .join(" "),
  );

  // Close the guide: the lock goes.
  await clickButton(app, "Guides");
  await waitForText(app, "Claim expenses");
  await pause(800);
  check(
    "closing the editor lets go of the lock",
    !Object.hasOwn(await folderFiles(app), "guides/payroll/.lock"),
  );

  // A recording, saved into the shared library (the default).
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await waitForText(panel, "Start recording");
  await clickButton(panel, "Start recording");
  await waitForText(panel, "Recording");
  const tab = await browser.newPage();
  await tab.goto(site);
  await tab.bringToFront();
  await pause(500);
  await tab.click("#run");
  await pause(900);
  await tab.click("#send");
  await pause(900);
  await panel.bringToFront();
  await clickButton(panel, "Stop", { starts: true });
  await waitForText(panel, "ready to review");
  await app.bringToFront();
  await app.reload();
  await waitForText(app, "A recording is not saved yet");
  await clickButton(app, "Review and save");
  await waitForText(app, "Save guide");
  await clickButton(app, "Save guide");
  await app.waitForFunction(() => !document.body.innerText.includes("Save guide"), {
    timeout: 15_000,
    polling: 250,
  });
  const after = await folderFiles(app);
  const recorded = Object.keys(after)
    .filter((path) => path.endsWith("/guide.json") && path.startsWith("guides/"))
    .map((path) => path.split("/")[1])
    .filter((guide) => !["payroll", "expenses", "holidays-SAMS-PC"].includes(guide));
  check(
    "Save puts the recording in the shared library",
    recorded.length === 1 &&
      Object.keys(after).some((path) => path.startsWith(`guides/${recorded[0]}/media/`)),
    recorded.join(" "),
  );
  check(
    "nothing half-written is left behind",
    !Object.keys(after).some((path) => /(\.crswap|\.tmp|\/\.copying)$/.test(path)),
  );

  // The desktop reads what Chrome wrote.
  const out = mkdtempSync(join(tmpdir(), "steps-e2e-chrome-wrote-"));
  for (const [path, data] of Object.entries(after)) {
    const target = join(out, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(data, "base64"));
  }
  try {
    execFileSync(
      "cargo",
      [
        "test",
        "-p",
        "library",
        "--test",
        "library_folder",
        "--locked",
        "--",
        "--ignored",
        "--exact",
        "the_desktop_reads_what_chrome_wrote",
      ],
      {
        cwd: join(root, "apps", "desktop", "src-tauri"),
        env: { ...process.env, STEPS_LIBRARY_DIR: out },
        stdio: "pipe",
      },
    );
    check("the desktop reads, and exports, the library Chrome wrote", true);
  } catch (error) {
    check(
      "the desktop reads, and exports, the library Chrome wrote",
      false,
      String(error.stdout ?? error).slice(-1500),
    );
  }
  rmSync(out, { recursive: true, force: true });
} catch (error) {
  // What each Steps page showed when a wait gave up.
  for (const page of await browser.pages())
    console.log(`--- ${page.url()}
${(await text(page).catch(() => "")).slice(0, 1500)}`);
  throw error;
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} failed` : "\nAll checks passed.");
process.exit(failures.length ? 1 : 0);
