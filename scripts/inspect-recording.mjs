// What a recording's steps were made from, step by step: the text each step says beside the click
// (or other fact) behind it, with the timings and what UI Automation found. For working out why
// "step 12" says the wrong thing or shows the wrong picture.
//
//   node scripts/inspect-recording.mjs                    the newest recording
//   node scripts/inspect-recording.mjs <session id>       that one
//   … --steps 12,13,15                                    only those steps (numbered as the editor does)
//   … --mark <folder>                                     each shown step's screenshot as a PNG, the
//                                                         click ringed and the element boxed
//   … --dir <recordings folder>                           a portable copy's "Steps data/recordings"
//
// Recordings are kept until saved or discarded: %APPDATA%\Amluto\Steps\recordings on Windows,
// ~/.local/share/com.amluto.steps/recordings on Linux. A recording's draft (the editor's copy) is
// read when there is one, so the numbers match what's on screen.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const recordings =
  option("--dir") ??
  (process.env.APPDATA
    ? join(process.env.APPDATA, "Amluto", "Steps", "recordings")
    : join(homedir(), ".local", "share", "com.amluto.steps", "recordings"));
if (!existsSync(recordings)) {
  console.error(`No recordings in ${recordings}.`);
  process.exit(1);
}
const named = args.find(
  (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
);
const session =
  named ??
  readdirSync(recordings)
    .filter((name) => statSync(join(recordings, name)).isDirectory())
    .sort(
      (a, b) => statSync(join(recordings, b)).mtimeMs - statSync(join(recordings, a)).mtimeMs,
    )[0];
if (!session) {
  console.error(`No recordings in ${recordings}.`);
  process.exit(1);
}
const folder = join(recordings, session);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const jsonIn = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readJson(join(dir, name)))
    : [];

// Byte order, as the app sorts steps (packages/core/src/sort-key.ts).
const byKey = (a, b) =>
  a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const draft = join(folder, "draft", "steps");
const steps = jsonIn(existsSync(draft) ? draft : join(folder, "steps")).sort(byKey);
// Each fact by the screenshot it took: a step's media id is that file's name.
const facts = new Map();
for (const fact of jsonIn(join(folder, "events"))) {
  const image = fact.record?.capture?.image;
  if (image) facts.set(image.replace(/\.\w+$/, ""), fact);
}

const wanted = option("--steps")
  ?.split(",")
  .map((n) => Number(n.trim()));
const clip = (text, length = 60) => {
  const flat = String(text ?? "").replace(/\s+/g, " ");
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};
const markDir = option("--mark");
const canvas = markDir ? await import("@napi-rs/canvas") : null;
if (markDir) mkdirSync(markDir, { recursive: true });

const session_ = readJson(join(folder, "session.json"));
console.log(`${session} · "${session_.title}" · ${steps.length} steps · ${folder}\n`);
for (const [index, step] of steps.entries()) {
  const number = index + 1;
  if (wanted && !wanted.includes(number)) continue;
  const media = step.media?.id;
  console.log(`${number}. ${step.actionText}${step.reviewRequired ? "  [needs review]" : ""}`);
  const fact = media ? facts.get(media) : undefined;
  const record = fact?.record;
  if (!record) {
    console.log(
      `   ${media ? `picture ${media}` : "no picture"}${step.kind === "block" ? " (a block)" : ""}`,
    );
    continue;
  }
  const window = record.window
    ? `${record.window.exe ?? "?"} "${clip(record.window.title, 50)}"`
    : "";
  const timing = [
    record.queueDelayMs !== undefined && `queue ${record.queueDelayMs} ms`,
    record.screenshotMs !== undefined && `screenshot ${record.screenshotMs} ms`,
    record.uia &&
      `UIA ${record.uia.status} ${record.uia.ms} ms${record.uia.retried ? " (looked again)" : ""}`,
  ].filter(Boolean);
  console.log(
    `   ${record.kind} #${record.id} at ${record.x ?? "-"},${record.y ?? "-"} in ${window}`,
  );
  if (timing.length) console.log(`   ${timing.join(" · ")}`);
  const element = record.element;
  // Recordings made before 06/10/2026 kept one parent; later ones up to four, nearest first.
  const parents = element?.ancestors ?? (element?.parent ? [element.parent] : []);
  if (element)
    console.log(
      `   element ${element.controlType} "${clip(element.name)}" .${clip(element.className, 40)}` +
        parents
          .map((parent) => ` · parent ${parent.controlType} "${clip(parent.name, 40)}"`)
          .join(""),
    );
  if (record.uia?.error) console.log(`   UIA error: ${record.uia.error}`);
  console.log(`   picture media/${record.capture.image}`);

  if (canvas && record.capture?.image) {
    const image = await canvas.loadImage(readFileSync(join(folder, "media", record.capture.image)));
    const surface = canvas.createCanvas(image.width, image.height);
    const draw = surface.getContext("2d");
    draw.drawImage(image, 0, 0);
    draw.lineWidth = Math.max(3, image.width / 400);
    if (record.elementPct) {
      const { x, y, w, h } = record.elementPct;
      draw.strokeStyle = "#ffbf00";
      draw.strokeRect(
        (x * image.width) / 100,
        (y * image.height) / 100,
        (w * image.width) / 100,
        (h * image.height) / 100,
      );
    }
    if (record.clickPct) {
      draw.strokeStyle = "#ff2020";
      draw.beginPath();
      draw.arc(
        (record.clickPct.x * image.width) / 100,
        (record.clickPct.y * image.height) / 100,
        image.width / 80,
        0,
        Math.PI * 2,
      );
      draw.stroke();
    }
    const out = join(markDir, `step-${String(number).padStart(2, "0")}.png`);
    await surface
      .encode("png")
      .then((png) => import("node:fs").then((fs) => fs.writeFileSync(out, png)));
    console.log(`   marked ${out}`);
  }
}
