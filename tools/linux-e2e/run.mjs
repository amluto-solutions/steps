// End-to-end check of Steps on Linux (X11): runs the built app on a virtual display, records a
// short task in a GTK window, and checks the steps, screenshots and privacy rules, then saves
// the guide and checks the library on disk, and that a Wayland session is refused.
//
//   scripts/linux/with-display.sh node tools/linux-e2e/run.mjs
//   APP=/usr/bin/amluto-steps scripts/linux/with-display.sh node tools/linux-e2e/run.mjs
//
// Needs (docs/engineering.md#linux): a debug build (`npx tauri build --debug --no-bundle` in
// apps/desktop), tauri-driver (`cargo install tauri-driver --locked`), WebKitWebDriver
// (`webkitgtk-webdriver`), xdotool, python3-gi with GTK 3, and ImageMagick's `import` for
// SHOTS=<folder> pictures. Nothing leaves the computer.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { harness, pause, root } from "./harness.mjs";

const test = harness("tools/linux-e2e/run.mjs");
const { check, click, clickButton, home, shot, text, waitFor, waitForText, xdotool } = test;
const places = join(home, "places.json");

try {
  const main = await test.openApp(4444);
  const { offered } = await test.welcome();
  check("the first run offers to start at sign-in, not with Windows", offered);

  // The window to record in.
  test.start("python3", [join(root, "tools", "linux-e2e", "test-app.py"), places]);
  await waitFor("the test window", () => existsSync(places), 15_000);
  const at = JSON.parse(readFileSync(places, "utf8"));

  await test.startRecording(main, true);
  shot("3-recording");

  // The task: approve, type a supplier, type a PIN, save.
  click(at.approve);
  await pause(900);
  click(at.supplier);
  await pause(400);
  xdotool("type", "--delay", "40", "Acme Ltd");
  await pause(400);
  click(at.pin);
  await pause(400);
  xdotool("type", "--delay", "40", "4321");
  await pause(400);
  click(at.save);
  await pause(1_500);
  shot("4-after-task");

  check("the recording bar stops the recording", await test.stopRecording(main));

  // The review: every step, worded as the desktop's are.
  const steps = await test.reviewSteps();
  shot("5-review");
  console.log("  steps:", JSON.stringify(steps));
  const has = (wanted) => steps.some((step) => step.includes(wanted));
  check("the click on a button is named", has('Click "Approve invoice"'));
  check("typing is recorded when asked for", has('Type "Acme Ltd" in "Supplier" field'));
  check(
    "a password field's value is never read",
    has('"Card PIN" field') && !steps.some((step) => step.includes("4321")),
  );
  check("the Save click is named", has('Click "Save"'));
  const indexOf = (wanted) => steps.findIndex((step) => step.includes(wanted));
  check(
    "typing sits before the click that took focus from the field",
    indexOf('Type "Acme Ltd"') >= 0 && indexOf('Type "Acme Ltd"') < indexOf('Click "Card PIN"'),
  );
  check(
    "each field left makes one step",
    steps.filter((step) => step.includes('Type in "Card PIN" field')).length === 1,
  );

  await clickButton("Save guide");
  await waitFor("the guide to be saved", async () => !(await text()).includes("Save guide"));

  // The guide on disk, with its screenshots.
  const library = join(home, "Documents", "Steps", "guides");
  const guides = existsSync(library) ? readdirSync(library) : [];
  const guideFolder = guides[0] ? join(library, guides[0]) : "";
  const media =
    guideFolder && existsSync(join(guideFolder, "media"))
      ? readdirSync(join(guideFolder, "media"))
      : [];
  check(
    "Save puts the guide in the library, with its screenshots",
    guides.length === 1 && media.length >= 3,
    `${guides.length} guide, ${media.length} screenshots`,
  );
  const saved = guideFolder ? readFileSync(join(guideFolder, "guide.json"), "utf8") : "";
  check("the PIN is nowhere in the guide", !saved.includes("4321"));

  // In a Wayland session there's nothing to record from: Steps says so instead of starting.
  await test.closeApp();
  await test.openApp(4446, { XDG_SESSION_TYPE: "wayland" });
  await waitForText("New recording");
  await clickButton("Not now");
  await clickButton("New recording");
  await waitForText("Record what's typed");
  await clickButton("Start recording");
  const refused = await waitForText("X11 session", 10_000).catch(() => false);
  shot("6-wayland");
  check("a Wayland session is refused, with how to record", Boolean(refused));
  await test.finish();
} catch (error) {
  await test.finish(error);
}
