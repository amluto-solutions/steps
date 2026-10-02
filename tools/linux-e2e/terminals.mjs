// Commands run in Linux terminals (the Phase 10 checklist): with "Record what's typed" on, a
// command typed into the Xfce terminal and one into GNOME Terminal each become a "Run in Bash"
// step holding the command, read from the terminal's own text over AT-SPI.
//
//   scripts/linux/with-display.sh node tools/linux-e2e/terminals.mjs
//
// Needs, besides what run.mjs needs: xfce4-terminal and gnome-terminal.
import { execFileSync } from "node:child_process";

import { harness, pause } from "./harness.mjs";

const test = harness("tools/linux-e2e/terminals.mjs");
const { check, shot, xdotool } = test;

const TERMINALS = [
  {
    name: "the Xfce terminal",
    app: "Xfce Terminal",
    windowClass: "Xfce4-terminal",
    start: () => test.start("xfce4-terminal", ["--disable-server", "--geometry=90x20+0+80"]),
    command: "echo steps-from-xfce",
  },
  {
    name: "GNOME Terminal",
    app: "Terminal",
    windowClass: "Gnome-terminal",
    start: () => test.start("gnome-terminal", ["--geometry=90x20+0+80"]),
    command: "echo steps-from-gnome",
  },
];

const windowOf = (windowClass) =>
  execFileSync("xdotool", ["search", "--onlyvisible", "--class", windowClass], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];

try {
  const main = await test.openApp(4444);
  await test.welcome();
  await test.startRecording(main, true);

  for (const terminal of TERMINALS) {
    terminal.start();
    const id = await test.waitFor(terminal.name, () => windowOf(terminal.windowClass), 30_000);
    xdotool("windowactivate", "--sync", id);
    // The shell's prompt first: Enter at a line without one is a reply, not a command.
    await pause(2_500);
    xdotool("type", "--delay", "40", terminal.command);
    xdotool("key", "Return");
    // The output settles (1.5 s by default) before the step is made.
    await pause(3_500);
    shot(`terminals-${terminal.windowClass}`);
  }

  check("the recording bar stops the recording", await test.stopRecording(main));
  const steps = await test.reviewSteps();
  shot("terminals-review");
  console.log("  steps:", JSON.stringify(steps));
  for (const terminal of TERMINALS) {
    const opened = steps.findIndex((step) => step.includes(`Open "${terminal.app}"`));
    check(`${terminal.name} opens as "${terminal.app}"`, opened >= 0);
    check(
      `${terminal.name}: the command is a Run in Bash step`,
      Boolean(steps[opened + 1]?.includes(`Run in Bash: ${terminal.command}`)),
    );
  }
  check(
    "no command is typed out keystroke by keystroke as well",
    !steps.some((step) => step.includes("Type") && step.includes("steps-from")),
  );
  await test.finish();
} catch (error) {
  await test.finish(error);
}
