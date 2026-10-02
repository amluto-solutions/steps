// The Linux self-update, driven through the app (run by update.sh, which builds the two
// AppImages and serves the newer one): Steps finds and downloads the update after opening, then
// Restart now replaces the AppImage with the new version, which opens.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { app, harness, pause } from "./harness.mjs";

const test = harness("tools/linux-e2e/update.mjs");
const { check, clickButton, shot, waitForText } = test;
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const newAppImage = process.env.NEW_APPIMAGE ?? "";
const before = hash(app);

try {
  await test.openApp(4444);
  await test.welcome();

  // It looks 15 seconds after opening, and downloads straight away.
  await waitForText("is ready", 60_000);
  check("the update is found and downloaded, its signature checked", true);
  await clickButton("Settings");
  await clickButton("About");
  await waitForText("Restart now", 10_000);
  shot("update-1-ready");
  await clickButton("Restart now");
  await pause(6_000);

  check("the AppImage is replaced by the new version", hash(app) === hash(newAppImage));
  check("the old AppImage is gone", hash(app) !== before);
  const running = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
  check(
    "the new version opens",
    running
      .split("\n")
      .some((line) => line.includes("Steps.AppImage") || line.includes("amluto-steps")),
  );
  shot("update-2-after");
  await test.finish();
} catch (error) {
  await test.finish(error);
}
