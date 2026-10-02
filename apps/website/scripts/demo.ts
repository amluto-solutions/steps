// The website's live demo: a real interactive web-page export, made by the app's own exporter
// (`packages/export`) from a guide whose screenshots are the app itself (`scripts/capture.mjs`).
// Run from the repo root: `npx jiti apps/website/scripts/demo.ts`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Guide, GuideStep, RichText } from "@amluto-steps/core";

import { overlayOf, planImage } from "../../../packages/export/src/geometry";
import { buildRenderModel, type RenderedImage } from "../../../packages/export/src/model";
import { renderWalkthrough } from "../../../packages/export/src/walkthrough/render";

const root = join(import.meta.dirname, "..");
const shots = join(root, "src", "assets", "shots");
const out = join(root, "public", "demo");
const modules = join(root, "..", "..", "node_modules");

const dataUrl = (path: string, type: string) =>
  `data:${type};base64,${readFileSync(path).toString("base64")}`;
const text = (value: string): RichText => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
});

const at = "2026-09-29T09:00:00.000Z";
const guide: Guide = {
  id: "demo",
  title: "From recording to a finished guide",
  description: "How a guide is made in Steps, recorded in Steps.",
  intro: text("You need Steps on a Windows PC, and a task to show someone."),
  outro: text(
    "The export opens in any browser, with no connection needed. Send it, or put it on your intranet.",
  ),
  brandProfileId: null,
  tags: [],
  owner: "Amluto",
  reviewBy: null,
  createdAt: at,
  createdBy: "Amluto",
  updatedAt: at,
  updatedBy: "Amluto",
  formatVersion: 1,
};

interface DemoStep {
  shot: string;
  width: number;
  height: number;
  wording: string;
  note?: string;
  /** The highlight, as percentages of the screenshot. */
  box: { x: number; y: number; w: number; h: number; shape?: "box" | "circle" };
}

// Positions read off the 2880 x 1800 captures (the recording bar's is 1018 x 160).
const demo: DemoStep[] = [
  {
    shot: "library-light.webp",
    width: 2880,
    height: 1800,
    wording: 'Press "New recording", then do the task the way you always do',
    note: "Choose whether to record what you type. It's off every time unless you tick it.",
    box: { x: 0.8, y: 7.5, w: 13.5, h: 5.6 },
  },
  {
    shot: "recorder-bar-light.webp",
    width: 1018,
    height: 160,
    wording: "Each click becomes a step with its own screenshot. Press Stop when you're done",
    box: { x: 90.9, y: 13, w: 8, h: 52, shape: "circle" },
  },
  {
    shot: "editor-light.webp",
    width: 2880,
    height: 1800,
    wording: 'Check each step, then choose "Blur all" to hide personal details in one go',
    note: "Reword steps, add notes and coloured boxes, draw arrows and crop. Everything can be undone.",
    box: { x: 83, y: 1.2, w: 7, h: 4.3 },
  },
  {
    shot: "editor-light.webp",
    width: 2880,
    height: 1800,
    wording: 'Choose "Export", then PDF, Word, a web page like this one, or copy and paste',
    box: { x: 90.5, y: 1.2, w: 8.4, h: 4.3 },
  },
  {
    shot: "export-review-light.webp",
    width: 2880,
    height: 1800,
    wording: "See every screenshot as it will look, pick a brand, and export",
    note: "The checklist names anything still to look at: personal details, typed values, missing alt text.",
    box: { x: 75.6, y: 62.1, w: 6.8, h: 4.3 },
  },
];

const steps: GuideStep[] = [];
const images = new Map<string, RenderedImage>();
demo.forEach((item, index) => {
  const id = `demo-${index + 1}`;
  const step: GuideStep = {
    id,
    sortKey: String(index + 1).padStart(3, "0"),
    kind: "interaction",
    action: "click",
    actionText: item.wording,
    textParts: { verb: "click", target: "", kind: "button" },
    showValue: false,
    textEdited: true,
    notes: item.note ? text(item.note) : null,
    altText: null,
    context: { app: "amluto-steps.exe", windowTitle: "Steps" },
    target: null,
    media: { id, width: item.width, height: item.height, scale: 2, captureRect: null },
    highlight: {
      shape: item.box.shape ?? "box",
      x: item.box.x,
      y: item.box.y,
      w: item.box.w,
      h: item.box.h,
    },
    crop: null,
    redactions: [],
    annotations: [],
    block: null,
    capturedAt: at,
    updatedAt: at,
    updatedBy: "Amluto",
    formatVersion: 1,
  } as GuideStep;
  steps.push(step);
  images.set(id, {
    dataUrl: dataUrl(join(shots, item.shot), "image/webp"),
    width: item.width,
    height: item.height,
    overlay: overlayOf(planImage(step, item.width, item.height)),
  });
});

const model = buildRenderModel(guide, steps, images, {
  preparedBy: "Amluto",
  now: new Date(at),
});
// The same OFL fonts the app embeds in its web pages (packages/ui/src/export/fonts.ts).
const font = (file: string) => dataUrl(join(modules, file), "font/woff2");
const html = await renderWalkthrough(model, {
  heading: font("@fontsource/jost/files/jost-latin-700-normal.woff2"),
  body: font("@fontsource/inter/files/inter-latin-400-normal.woff2"),
  bodyBold: font("@fontsource/inter/files/inter-latin-700-normal.woff2"),
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), html);
console.log(`demo: ${Math.round(html.length / 1024)} KB, ${steps.length} steps`);
