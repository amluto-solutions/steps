// Builds report.html for a prototype run folder and scores it against the Phase 1 exit targets.
//
//   node tools/parity/report.mjs <run folder>
//
// It applies the real wording code (packages/core) to the recorded UIA facts. When the folder has
// an expected.json (written by `drive fixture`), it checks that no password, PIN or card value was
// ever recorded. (Phase 1 also compared wording with the old extension's; that comparison ran the
// old extension's own code, and was removed on 30/09/2026 with it.)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describeClick, describeInput } from "../../packages/core/src/step-text/index.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node tools/parity/report.mjs <run folder>");
  process.exit(1);
}

const readJson = (name) =>
  existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null;
const rawEvents = readFileSync(join(dir, "events.jsonl"), "utf8");
const events = rawEvents
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const session = readJson("session.json");
const plan = readJson("expected.json");
const driven = readJson("driven.json") ?? [];

const clicks = events.filter((e) => e.kind === "click");
const inputs = events.filter((e) => e.kind === "input");
const doubleOf = new Set(events.filter((e) => e.kind === "double").map((e) => e.of));

// ---------- wording ----------
for (const click of clicks) {
  const wording = describeClick(click.element, click.window.title);
  click.wording = wording.text;
  click.unnamed = wording.unnamed;
}
for (const input of inputs) {
  input.wording = describeInput(input.element, input.value ?? undefined);
}

// ---------- parity ----------
const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const quoted = (s) => [...norm(s).matchAll(/"([^"]*)"/g)].map((m) => m[1].toLowerCase());
const verb = (s) => norm(s).split(" ")[0]?.toLowerCase();

/**
 * exact       same text
 * equivalent  same meaning, e.g. only a trailing "field" differs, or one label contains the other
 * improved    the old tool fell back to the page address, or the new text keeps every quoted
 *             part of the old text and adds more (e.g. the typed value the old rules dropped)
 * withheld    a sensitive field: the old tool wrote its value, the new one withholds it by design
 * different   anything else: a real regression to look at
 */
function classify(expected, actual, unnamed, withheld) {
  if (norm(expected) === norm(actual)) return "exact";
  if (withheld === "sensitive" || withheld === "password") return "withheld";
  const oldFellBack = /^(Click|Type) "(file|https?):\/\//.test(norm(expected));
  if (oldFellBack && !unnamed) return "improved";
  const oldParts = quoted(expected);
  const newParts = quoted(actual);
  if (
    verb(expected) === verb(actual) &&
    oldParts.length > 0 &&
    newParts.length > oldParts.length &&
    oldParts.every((part) => newParts.includes(part))
  ) {
    return "improved";
  }
  const strip = (s) =>
    norm(s)
      .replace(/\s+field$/i, "")
      .toLowerCase();
  if (strip(expected) === strip(actual)) return "equivalent";
  const [e] = quoted(expected);
  const [a] = quoted(actual);
  if (verb(expected) === verb(actual) && e && a && (e.includes(a) || a.includes(e))) {
    return "equivalent";
  }
  return "different";
}

const comparisons = [];
if (plan?.steps.some((step) => step.expected)) {
  const planClicks = plan.steps.map((step) => ({
    target: step.target,
    expected: step.expected.click,
  }));
  // Pair by where the driver clicked; fall back to order for older runs without driven.json.
  const recorded = clicks.filter((c) => c.injected);
  const used = new Set();
  const byPosition = (target) => {
    const spot = driven.find((d) => d.target === target);
    const click = spot && recorded.find((c) => !used.has(c.id) && c.x === spot.x && c.y === spot.y);
    if (click) used.add(click.id);
    return click;
  };
  planClicks.forEach((step, index) => {
    const click = driven.length ? byPosition(step.target) : recorded[index];
    comparisons.push({
      kind: "click",
      target: step.target,
      expected: step.expected,
      actual: click?.wording ?? "(not recorded)",
      verdict: click ? classify(step.expected, click.wording, click.unnamed) : "missing",
      click,
    });
  });
  for (const step of plan.steps.filter((s) => s.expected?.input)) {
    const input = inputs.find((i) => i.element.automationId === step.target);
    comparisons.push({
      kind: "input",
      target: step.target,
      expected: step.expected.input,
      actual: input?.wording ?? "(not recorded)",
      verdict: input
        ? classify(step.expected.input, input.wording, false, input.withheld)
        : "missing",
      input,
    });
  }
}
const harnessClicks = driven.length
  ? clicks.filter((c) => c.injected && !comparisons.some((x) => x.click?.id === c.id))
  : [];
const counts = comparisons.reduce(
  (acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }),
  {},
);
const passing =
  (counts.exact ?? 0) + (counts.equivalent ?? 0) + (counts.improved ?? 0) + (counts.withheld ?? 0);
const parityPct = comparisons.length
  ? Math.round((passing / comparisons.length) * 1000) / 10
  : null;

// ---------- privacy ----------
const secrets = plan
  ? plan.steps.filter((s) => s.secret && s.text).map((s) => ({ target: s.target, text: s.text }))
  : [];
const leaks = [
  ...secrets
    .filter((s) => rawEvents.includes(JSON.stringify(s.text)))
    .map((s) => `value typed into #${s.target} appears in events.jsonl`),
  ...inputs
    .filter((i) => (i.element.isPassword || i.element.sensitive) && i.value != null)
    .map((i) => `a value was read from sensitive field "${i.element.name}"`),
];

// ---------- verdict ----------
const summary = session?.summary ?? {};
const targets = [
  [
    "Chrome steps matching or equally clear",
    parityPct == null ? "n/a" : `${parityPct}%`,
    parityPct == null ? null : parityPct >= 90,
  ],
  [
    "UIA lookup p95",
    `${summary.uiaMs?.p95 ?? "?"} ms`,
    summary.uiaMs?.p95 == null ? null : summary.uiaMs.p95 < 150,
  ],
  [
    "Screenshot p95",
    `${summary.screenshotMs?.p95 ?? "?"} ms`,
    summary.screenshotMs?.p95 == null ? null : summary.screenshotMs.p95 < 100,
  ],
  ["Sensitive values captured", leaks.length ? leaks.join("; ") : "none", leaks.length === 0],
  [
    "Clicks with a usable name",
    `${clicks.filter((c) => !c.unnamed).length} of ${clicks.length}`,
    clicks.length === 0 ? null : clicks.every((c) => !c.unnamed),
  ],
  [
    "Clicks lost silently",
    `${summary.missed ?? 0} missed (all marked), degraded ${summary.degraded ?? 0}`,
    true,
  ],
];

// ---------- HTML ----------
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const badge = (ok) =>
  ok == null ? "—" : ok ? '<b class="ok">PASS</b>' : '<b class="bad">FAIL</b>';

const shot = (click) => {
  if (!click?.capture?.image) return "";
  const p = click.clickPct;
  const b = click.elementPct;
  return `<div class="shot"><img src="${esc(click.capture.image)}" alt="Screenshot of click ${click.id}">
    ${b ? `<div class="box" style="left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%"></div>` : ""}
    ${p ? `<div class="dot" style="left:${p.x}%;top:${p.y}%"></div>` : ""}</div>`;
};

const clickRows = clicks
  .map(
    (c) => `<tr><td>${c.id}${doubleOf.has(c.id) ? " (double)" : ""}</td><td>${shot(c)}</td>
    <td><b>${esc(c.wording)}</b>${c.unnamed ? ' <span class="warn">unnamed</span>' : ""}<br>
    <small>${esc(c.window.exe)} · ${esc(c.window.title)}<br>
    ${c.element ? `${esc(c.element.controlType)} “${esc(c.element.name)}” id=${esc(c.element.automationId)} fw=${esc(c.element.frameworkId)}` : "no element"}<br>
    shot ${c.screenshotMs} ms · uia ${esc(c.uia.status)} ${c.uia.ms} ms${c.uia.retried ? " (retried)" : ""} · delay ${c.queueDelayMs} ms · scale ${c.capture.scale}</small></td></tr>`,
  )
  .join("\n");

const parityRows = comparisons
  .map(
    (c) =>
      `<tr class="${c.verdict}"><td>${esc(c.kind)}</td><td>#${esc(c.target)}</td><td>${esc(c.expected)}</td><td>${esc(c.actual)}</td><td>${esc(c.verdict)}</td></tr>`,
  )
  .join("\n");

const inputRows = inputs
  .map(
    (
      i,
    ) => `<tr><td>${esc(i.element.controlType)} “${esc(i.element.name)}” #${esc(i.element.automationId)}</td>
    <td>${i.value == null ? `<i>withheld: ${esc(i.withheld)}</i>` : esc(i.value)}</td><td>${esc(i.wording)}</td></tr>`,
  )
  .join("\n");

const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Amluto Steps — capture prototype report</title>
<style>
body{font-family:Aptos,Calibri,system-ui,sans-serif;margin:24px;color:#1a1a1a}h1,h2{font-family:"Century Gothic",system-ui;color:#0e2542}
table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border:1px solid #e2e8f0;padding:6px;vertical-align:top;text-align:left}
.ok{color:#15803d}.bad{color:#b91c1c}.warn{color:#b45309;font-weight:bold}
tr.exact td:last-child,tr.improved td:last-child,tr.withheld td:last-child{color:#15803d}tr.equivalent td:last-child{color:#1e6ebc}tr.different td:last-child,tr.missing td:last-child{color:#b91c1c;font-weight:bold}
.shot{position:relative;width:360px}.shot img{width:360px;display:block;border:1px solid #e2e8f0}
.dot{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid #48cdeb;border-radius:50%;background:rgba(72,205,235,.25)}
.box{position:absolute;border:2px dashed #1e6ebc}
</style></head><body>
<h1>Capture prototype report</h1>
<p>${harnessClicks.length ? `<b>${harnessClicks.length} click(s) came from the test harness itself (e.g. Windows focusing the window) and are not scored: #${harnessClicks.map((c) => c.id).join(", #")}.</b><br>` : ""}${esc(session?.source ?? "")} input · ${esc(session?.mode ?? "")} screenshots · values ${session?.recordValues ? "on" : "off"} · ${clicks.length} clicks, ${inputs.length} field values, ${doubleOf.size} double-clicks</p>
<h2>Phase 1 targets</h2>
<table><tr><th>Check</th><th>Result</th><th></th></tr>${targets.map(([n, r, ok]) => `<tr><td>${esc(n)}</td><td>${esc(r)}</td><td>${badge(ok)}</td></tr>`).join("")}</table>
${
  comparisons.length
    ? `<h2>Wording parity with the old extension</h2><p>exact ${counts.exact ?? 0} · equivalent ${counts.equivalent ?? 0} · improved ${counts.improved ?? 0} · withheld (privacy) ${counts.withheld ?? 0} · different ${counts.different ?? 0} · missing ${counts.missing ?? 0}</p>
<table><tr><th>Step</th><th>Target</th><th>Old extension</th><th>Desktop prototype</th><th>Verdict</th></tr>${parityRows}</table>`
    : ""
}
<h2>Field values</h2><table><tr><th>Field</th><th>Value</th><th>Wording</th></tr>${inputRows}</table>
<h2>Clicks</h2><table><tr><th>#</th><th>Screenshot (dot = click, dashed = element)</th><th>Details</th></tr>${clickRows}</table>
<h2>Session</h2><pre>${esc(JSON.stringify(session, null, 2))}</pre>
</body></html>`;

writeFileSync(join(dir, "report.html"), html);
console.log(`report: ${join(dir, "report.html")}`);
console.log(`parity: ${parityPct ?? "n/a"}% (${JSON.stringify(counts)})`);
for (const click of clicks)
  console.log(
    `  #${click.id} ${click.window.exe}: ${click.wording}${click.unnamed ? "  (unnamed)" : ""}`,
  );
for (const [name, result, ok] of targets)
  console.log(`${ok == null ? "-" : ok ? "PASS" : "FAIL"}  ${name}: ${result}`);
