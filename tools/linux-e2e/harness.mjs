// What the Linux end-to-end tests share (docs/engineering.md#linux): Steps under WebDriver
// (tauri-driver and WebKitWebDriver), a home folder of its own, pointer clicks through xdotool,
// the checks and their report.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..", "..");

/** The app to test: APP=<path> for the installed package or an AppImage, else the debug build. */
export const app =
  process.env.APP ?? join(root, "apps", "desktop", "src-tauri", "target", "debug", "amluto-steps");

export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function harness(name) {
  if (!existsSync(app)) {
    console.error("Build the app first: npx tauri build --debug --no-bundle (in apps/desktop)");
    process.exit(1);
  }
  if (!process.env.DISPLAY) {
    console.error(`Run it on a display: scripts/linux/with-display.sh node ${name}`);
    process.exit(1);
  }

  const failures = [];
  const check = (what, ok, detail = "") => {
    console.log(`${ok ? "✔" : "✘"} ${what}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures.push(what);
  };
  const shots = process.env.SHOTS;
  const shot = (label) => {
    if (shots) execFileSync("import", ["-window", "root", join(shots, `${label}.png`)]);
  };
  const xdotool = (...args) => execFileSync("xdotool", args.map(String));
  /**
   * Clicks at a point as a mouse would. `mousemove` alone warps the pointer, which isn't input: a
   * real mouse sends motion too, and Steps pauses when the pointer moves without any ("Clicks
   * stopped arriving"). A small relative move through XTEST is real motion.
   */
  const click = (point) => {
    xdotool("mousemove", point.x, point.y);
    xdotool("mousemove_relative", "--", 2, 2);
    xdotool("mousemove_relative", "--", -2, -2);
    xdotool("click", 1);
  };

  // A home of its own: a first run, and nothing of the person's touched.
  const home = mkdtempSync(join(tmpdir(), "steps-linux-e2e-"));
  const children = [];
  const start = (command, args, env = {}) => {
    const child = spawn(command, args, {
      env: { ...process.env, HOME: home, ...env },
      stdio: ["ignore", "ignore", process.env.VERBOSE ? "inherit" : "ignore"],
    });
    children.push(child);
    return child;
  };

  // ---------- WebDriver ----------
  let driver = "http://127.0.0.1:4444";
  let session = "";
  async function webdriver(method, path, body) {
    const response = await fetch(`${driver}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const answer = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(answer.value)}`);
    return answer.value;
  }
  const run = (script, ...args) =>
    webdriver("POST", `/session/${session}/execute/sync`, { script, args });
  const text = () => run("return document.body.innerText");
  const waitFor = async (what, test, timeout = 20_000) => {
    const until = Date.now() + timeout;
    for (;;) {
      const value = await Promise.resolve()
        .then(test)
        .catch(() => null);
      if (value) return value;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await pause(250);
    }
  };
  const waitForText = (wanted, timeout) =>
    waitFor(`"${wanted}"`, async () => (await text()).includes(wanted), timeout);
  /** Clicks the first button whose text (or accessible name) starts with `label`. */
  const clickButton = (label) =>
    run(
      `const wanted = arguments[0];
       const button = [...document.querySelectorAll("button")].find((each) =>
         (each.textContent ?? "").trim().startsWith(wanted) ||
         (each.getAttribute("aria-label") ?? "").startsWith(wanted));
       if (!button) return false;
       button.click();
       return true;`,
      label,
    );
  const windowHandles = () => webdriver("GET", `/session/${session}/window/handles`);
  const switchTo = (handle) => webdriver("POST", `/session/${session}/window`, { handle });

  /** Starts Steps under a tauri-driver of its own on `port`; answers the main window's handle. */
  async function openApp(port, env = {}) {
    driver = `http://127.0.0.1:${port}`;
    // Each with its own WebKitWebDriver port (tauri-driver's default, 4445, would clash).
    start("tauri-driver", ["--port", String(port), "--native-port", String(port + 100)], env);
    await waitFor("tauri-driver", () => fetch(`${driver}/status`).then((r) => r.ok), 10_000);
    const created = await webdriver("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: app } } },
    });
    session = created.sessionId;
    return webdriver("GET", `/session/${session}/window`);
  }
  async function closeApp() {
    if (session) await webdriver("DELETE", `/session/${session}`).catch(() => undefined);
    session = "";
    // Steps stays in the tray when its window closes, and since 1.0.0 a second start hands over
    // to the one running and quits, so the next openApp's session never came: end it first.
    const running = () => {
      try {
        execFileSync("pgrep", ["-x", "amluto-steps"]);
        return true;
      } catch {
        return false;
      }
    };
    if (running()) {
      execFileSync("pkill", ["-x", "amluto-steps"]);
      await waitFor("Steps to quit", () => !running(), 10_000);
    }
  }

  /** The first run: a name, then the library, with the tour declined. */
  async function welcome() {
    await waitForText("Let's get you set up");
    shot("1-welcome");
    const offered = (await text()).includes("Start when you sign in");
    await run(
      `const field = document.querySelector("#welcome-name");
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
       setter.call(field, "Sam Tester");
       field.dispatchEvent(new Event("input", { bubbles: true }));`,
    );
    await clickButton("Get started");
    await waitForText("New recording");
    await waitForText("Start the tour", 5_000).catch(() => undefined);
    await clickButton("Not now");
    return { offered };
  }

  /** Starts a recording from the main window, with "Record what's typed" if `keys`. */
  async function startRecording(main, keys) {
    await switchTo(main);
    await clickButton("New recording");
    await waitForText("Record what's typed");
    if (keys)
      await run(
        `const box = [...document.querySelectorAll("input[type=checkbox]")].find((each) =>
           each.closest("label, div")?.textContent?.includes("Record what's typed"));
         if (box && !box.checked) box.click();`,
      );
    await clickButton("Start recording");
    await pause(2_500);
  }

  /** Stops from the recording bar; answers whether its Stop was found. */
  /** Presses Stop on the recording bar; true once the main window shows the review. */
  async function stopRecording(main) {
    for (const handle of await windowHandles()) {
      // The bar closes as its Stop is pressed, which can fail the WebDriver call that pressed it.
      const pressed = await switchTo(handle).then(
        () => clickButton("Stop").catch(() => true),
        () => false,
      );
      if (pressed) break;
    }
    await switchTo(main);
    return waitForText("Save guide", 30_000).then(
      () => true,
      () => false,
    );
  }

  /** The draft's steps, as the review lists them. */
  async function reviewSteps() {
    await waitForText("Save guide", 30_000);
    // KEEP=1: the recording's journal too, copied before Save removes it.
    if (process.env.KEEP) {
      const share = join(home, ".local", "share");
      for (const folder of readdirSync(share)) {
        const recordings = join(share, folder, "recordings");
        if (existsSync(recordings)) cpSync(recordings, join(home, "journal"), { recursive: true });
      }
    }
    return run(
      `return [...document.querySelectorAll("[data-step-button]")].map((each) => each.textContent);`,
    );
  }

  async function finish(error) {
    if (error) {
      failures.push(String(error));
      console.error(error);
      if (session) console.error(await text().catch(() => ""));
    }
    await closeApp();
    for (const child of children) child.kill();
    // KEEP=1 leaves the test's home (the journal, the library, the logs) to look at.
    if (process.env.KEEP) console.log(`  kept: ${home}`);
    else
      try {
        // Retried: a terminal just killed can still be writing its settings into the home (the
        // 1.0.0 release run, 02/10/2026, stopped here after every check had passed).
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (cleanup) {
        console.log(`  couldn't remove ${home}: ${cleanup.code ?? cleanup}`);
      }
    console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
    process.exit(failures.length ? 1 : 0);
  }

  return {
    home,
    check,
    shot,
    click,
    xdotool,
    start,
    run,
    text,
    waitFor,
    waitForText,
    clickButton,
    openApp,
    closeApp,
    welcome,
    startRecording,
    stopRecording,
    reviewSteps,
    finish,
  };
}
