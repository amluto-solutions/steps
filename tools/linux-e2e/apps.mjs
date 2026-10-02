// Steps with real Linux apps (the Phase 10 checklist, in part): LibreOffice Writer (its own
// toolkit, through GTK 3) and Files (GTK 4) on a virtual display. A recording clicks a menu and a
// toolbar button in Writer and the sidebar in Files, and the steps must name what was clicked.
// The menu is Help: the recording bar starts over the left of a full-screen window's menu bar,
// and a click on the bar is Steps' own, never a step.
//
//   scripts/linux/with-display.sh node tools/linux-e2e/apps.mjs
//
// Needs, besides what run.mjs needs: `libreoffice-writer`, `libreoffice-gtk3`, `nautilus` and
// `gir1.2-atspi-2.0` (for find.py).
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { harness, pause, root } from "./harness.mjs";

const test = harness("tools/linux-e2e/apps.mjs");
const { check, click, shot, xdotool } = test;

/** The screen point of a control, found through AT-SPI (find.py), or null. */
function find(app, role, name) {
  const out = execFileSync(
    "python3",
    [join(root, "tools", "linux-e2e", "find.py"), app, role, name],
    {
      encoding: "utf8",
    },
  ).trim();
  return out ? JSON.parse(out) : null;
}

/** A shown window's client area, by a part of its title. */
function windowArea(title) {
  const id = execFileSync("xdotool", ["search", "--onlyvisible", "--name", title], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
  const info = execFileSync("xwininfo", ["-id", id], { encoding: "utf8" });
  const number = (label) => Number(new RegExp(`${label}:\\s+(-?\\d+)`).exec(info)?.[1] ?? 0);
  return {
    id,
    x: number("Absolute upper-left X"),
    y: number("Absolute upper-left Y"),
    width: number("Width"),
    height: number("Height"),
  };
}

try {
  const main = await test.openApp(4444);
  await test.welcome();

  test.start("soffice", ["--writer", "--norestore", "--nologo"], { SAL_USE_VCLPLUGIN: "gtk3" });
  test.start("nautilus", ["--new-window"]);
  const help = await test.waitFor(
    "Writer's Help menu",
    () => find("soffice", "menu", "Help"),
    60_000,
  );
  const bold = await test.waitFor(
    "Writer's Bold button",
    () => find("soffice", "toggle button", "Bold") ?? find("soffice", "push button", "Bold"),
    30_000,
  );
  await test.waitFor("the Files window", () => windowArea("Home"), 30_000);

  await test.startRecording(main, false);
  shot("apps-1-recording");

  // Writer: open the Help menu and close it, then press Bold.
  xdotool("windowactivate", "--sync", windowArea("LibreOffice Writer").id);
  await pause(800);
  click(help);
  await pause(1_000);
  shot("apps-menu-open");
  xdotool("key", "Escape");
  await pause(600);
  click(bold);
  await pause(1_000);

  // Files: the sidebar's second row, whatever it's called here.
  const files = windowArea("Home");
  xdotool("windowactivate", "--sync", files.id);
  await pause(800);
  click({ x: files.x + 90, y: files.y + 120 });
  await pause(1_500);
  shot("apps-2-after");

  check("the recording bar stops the recording", await test.stopRecording(main));
  const steps = await test.reviewSteps();
  shot("apps-3-review");
  console.log("  steps:", JSON.stringify(steps));
  const has = (wanted) => steps.some((step) => step.includes(wanted));
  check("a LibreOffice menu is named", has('Click "Help"'));
  check("a LibreOffice toolbar button is named", has('"Bold"'));
  check("LibreOffice opens as itself", has('Open "LibreOffice'));
  check("Files opens as itself", has('Open "Files"'));
  const inFiles = steps.slice(steps.findIndex((step) => step.includes('Open "Files"')));
  check(
    "a click in Files (GTK 4) is named, not left unnamed",
    inFiles.some((step) => /Click "[^"]+"/.test(step) && !step.includes("Click in")),
    inFiles.join(" | "),
  );
  await test.finish();
} catch (error) {
  await test.finish(error);
}
