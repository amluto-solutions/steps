import { calloutOfBlock, languageName, type MarkColour } from "@amluto-steps/core";

import { markSizes } from "../geometry";
import { base64, escapeHtml, richTextToHtml } from "../html";
import {
  richTextWords,
  type RenderCode,
  type RenderModel,
  type RenderStep,
  type RenderedImage,
} from "../model";
import { playerMain, type PlayerData, type PlayerItem } from "./player";
import { walkthroughCss } from "./styles";
import {
  blockLook,
  currentWords,
  EXPORT_WORDS,
  exportWords,
  withWords,
  type ExportWords,
} from "../words";

/** The walkthrough's own words, in the export's language. */
export const walkthroughLabels = (words: ExportWords = currentWords()): Record<string, string> => ({
  ...words.player,
  finished: words.youreDone,
  copy: words.copy,
  copied: words.copied,
});

/** The English ones, as they always were. */
export const WALKTHROUGH_LABELS: Record<string, string> = walkthroughLabels(EXPORT_WORDS);

/** OFL fonts to embed (data URLs, WOFF2). Brand fonts are only named in the CSS, never embedded. */
export interface WalkthroughFonts {
  heading?: string;
  body?: string;
  bodyBold?: string;
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The highlight, arrows, boxes and labels as SVG over the screenshot, in the image's own pixels
 * (the same sizes the PDF draws). The static view shows it as is; the player animates a copy.
 */
export function overlaySvg(image: RenderedImage): string {
  const overlay = image.overlay;
  if (!overlay) return "";
  const { width, height } = image;
  const x = (percent: number) => round((percent / 100) * width);
  const y = (percent: number) => round((percent / 100) * height);
  const scale = Math.max(width, height);
  const { lineWidth: line, fontSize: font } = markSizes(scale);
  const parts: string[] = [];
  // A colour is a class the stylesheet knows (the page's policy allows no inline styles).
  // Escaped though the schema allows only known colours: this text goes into the file as HTML.
  const tint = (mark: { colour?: MarkColour }) =>
    mark.colour ? ` wt-c-${escapeHtml(mark.colour)}` : "";
  for (const mark of overlay.annotations) {
    if (mark.type === "box") {
      parts.push(
        `<rect class="wt-box wt-later${tint(mark)}" x="${x(mark.x)}" y="${y(mark.y)}" width="${x(mark.w)}" height="${y(mark.h)}" rx="${line * 2}" stroke-width="${line}"/>`,
      );
    } else if (mark.type === "arrow") {
      const [fromX, fromY, toX, toY] = [
        x(mark.from[0]),
        y(mark.from[1]),
        x(mark.to[0]),
        y(mark.to[1]),
      ];
      const angle = Math.atan2(toY - fromY, toX - fromX);
      const head = line * 4;
      const tip = (turn: number) =>
        `${round(toX - head * Math.cos(angle + turn))},${round(toY - head * Math.sin(angle + turn))}`;
      parts.push(
        `<g class="wt-arrow wt-later${tint(mark)}"><line x1="${fromX}" y1="${fromY}" x2="${round(toX - Math.cos(angle) * head * 0.6)}" y2="${round(toY - Math.sin(angle) * head * 0.6)}" stroke-width="${line}"/><polygon points="${toX},${toY} ${tip(-0.45)} ${tip(0.45)}"/></g>`,
      );
    }
  }
  if (overlay.highlight) {
    const { shape, x: left, y: top, w, h } = overlay.highlight;
    const stroke = round(line * 1.3);
    parts.push(
      shape === "circle"
        ? `<ellipse class="wt-highlight" cx="${x(left + w / 2)}" cy="${y(top + h / 2)}" rx="${x(w / 2)}" ry="${y(h / 2)}" stroke-width="${stroke}" pathLength="100"/>`
        : `<rect class="wt-highlight" x="${x(left)}" y="${y(top)}" width="${x(w)}" height="${y(h)}" rx="${line * 2}" stroke-width="${stroke}" pathLength="100"/>`,
    );
  }
  for (const mark of overlay.annotations) {
    if (mark.type !== "label") continue;
    // SVG can't measure text before it's shown, so the box is sized from an average letter width.
    const padding = font * 0.5;
    const boxWidth = round(mark.text.length * font * 0.58 + padding * 2);
    const boxHeight = round(font * 1.6);
    parts.push(
      `<g class="wt-label wt-later${tint(mark)}"><rect x="${x(mark.x)}" y="${y(mark.y)}" width="${boxWidth}" height="${boxHeight}" rx="${round(font * 0.35)}" stroke-width="${Math.max(2, round(font / 7))}"/><text x="${round(x(mark.x) + padding)}" y="${round(y(mark.y) + boxHeight / 2)}" font-size="${font}">${escapeHtml(mark.text)}</text></g>`,
    );
  }
  if (parts.length === 0) return "";
  return `<svg class="wt-overlay" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

const sha256 = async (text: string) =>
  base64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

const fontFaces = (fonts: WalkthroughFonts) => {
  const face = (family: string, weight: number, url: string | undefined) =>
    url && /^data:font\/woff2?;base64,[A-Za-z0-9+/=]+$/.test(url)
      ? `@font-face{font-family:"${family}";font-weight:${weight};font-display:swap;src:url("${url}") format("${url.startsWith("data:font/woff2") ? "woff2" : "woff"}")}`
      : "";
  return [
    face("Jost", 700, fonts.heading),
    face("Inter", 400, fonts.body),
    face("Inter", 700, fonts.bodyBold),
  ].join("");
};

/**
 * A step's code block: its label and Copy, the code, and the output folded away with its own Copy
 * (docs/spec/05-export.md#code). Copy needs the page's script, so it starts hidden and the script
 * shows it; without JavaScript the text can still be selected.
 */
export function codeHtml(code: RenderCode | null): string {
  if (!code) return "";
  const copy = `<button type="button" class="wt-copy" hidden>${currentWords().copy}</button>`;
  const label = code.label ? `<span class="wt-code-label">${escapeHtml(code.label)}</span>` : "";
  // Code doesn't wrap (a break after a hyphen would split -Parameter): it scrolls in its box, which
  // can then take the keyboard focus to be scrolled.
  const block = `<div class="wt-code"><div class="wt-code-head">${label}${copy}</div><pre class="wt-code-text" tabindex="0"><code>${escapeHtml(code.text)}</code></pre></div>`;
  if (!code.output) return block;
  const lines = code.output.split("\n").length;
  const count = `${currentWords().outputLines(lines)}${code.outputShortened ? `, ${currentWords().shortened}` : ""}`;
  // Copy sits beside the summary, not in it: a button inside the control that opens the output is
  // read out badly and is easy to hit by mistake.
  return `${block}<div class="wt-output"><details><summary>${currentWords().output} <span class="wt-output-count">(${escapeHtml(count)})</span></summary><pre class="wt-output-text" tabindex="0">${escapeHtml(code.output)}</pre></details>${copy}</div>`;
}

const stepNumbers = (model: RenderModel) =>
  currentWords().coverParts(model.stepCount, model.minutes, model.date).join(" · ");

/** The static view: the whole guide as one page. It is the no-JavaScript fallback and the print view. */
function staticView(model: RenderModel): string {
  return `<div id="static" class="wt-static">${staticInner(model, true)}</div>`;
}

/**
 * The static view's contents. Another language's copy is built with `figures` false: each
 * screenshot is a placeholder the player fills with the page's own, so each is in the file once.
 */
function staticInner(model: RenderModel, figures: boolean): string {
  const logo = model.brand.coverLogo;
  const logoSrc = !logo
    ? null
    : logo.type === "svg"
      ? `data:image/svg+xml;base64,${base64(new TextEncoder().encode(logo.data))}`
      : logo.data;
  const parts = [
    '<header class="wt-static-head">',
    logoSrc
      ? `<img class="wt-logo" src="${escapeHtml(logoSrc)}" alt="${escapeHtml(model.brand.name)}">`
      : "",
    `<h1>${escapeHtml(model.title)}</h1>`,
    model.description ? `<p class="wt-desc">${escapeHtml(model.description)}</p>` : "",
    `<p class="wt-meta">${escapeHtml(stepNumbers(model))}${model.preparedBy ? ` · ${escapeHtml(currentWords().preparedBy(model.preparedBy))}` : ""}</p>`,
    "</header>",
    model.intro
      ? `<section class="wt-static-intro"><h2>${currentWords().beforeYouStart}</h2><div class="wt-notes">${richTextToHtml(model.intro, false)}</div></section>`
      : "",
    '<ol class="wt-steps">',
  ];
  model.items.forEach((item, index) => {
    if (item.kind === "block") {
      // A tip, callout or alert is named even without a heading (the colour alone doesn't say).
      const title =
        item.type === "header" || item.type === "text" ? item.heading : blockLook(item).label;
      const callout = calloutOfBlock(item.type);
      const heading = title
        ? item.type === "header"
          ? `<h2>${escapeHtml(title)}</h2>`
          : `<h3>${escapeHtml(title)}</h3>`
        : "";
      parts.push(
        `<li class="wt-static-block wt-block-${item.type}${callout ? ` wt-callout wt-callout-${callout}` : ""}" data-index="${index}" id="part-${index}">${heading}<div class="wt-notes">${richTextToHtml(item.body, false)}</div></li>`,
      );
      return;
    }
    const figure = !item.image
      ? ""
      : !figures
        ? `<span data-figure="${index}" hidden></span>`
        : `<figure class="wt-figure"><img class="wt-shot" src="${escapeHtml(item.image.dataUrl)}" alt="${escapeHtml(item.altText)}" width="${item.image.width}" height="${item.image.height}">${overlaySvg(item.image)}</figure>`;
    parts.push(
      `<li class="wt-static-step" data-index="${index}" id="step-${item.number}"><div class="wt-step-top"><span class="wt-number" aria-hidden="true">${item.number}</span><h3 class="wt-step-text"><span class="wt-sr">${escapeHtml(currentWords().stepRange(item.number, item.number))}: </span>${escapeHtml(item.text)}</h3></div>${codeHtml(item.code)}${figure}${item.notes ? `<div class="wt-notes">${richTextToHtml(item.notes, false)}</div>` : ""}</li>`,
    );
  });
  parts.push("</ol>");
  if (model.outro)
    parts.push(
      `<section class="wt-static-outro"><h2>${escapeHtml(currentWords().youreDone)}</h2><div class="wt-notes">${richTextToHtml(model.outro, false)}</div></section>`,
    );
  if (model.madeWith)
    parts.push(
      `<p class="wt-made"><a href="${currentWords().madeWithUrl}" target="_blank" rel="noopener">${escapeHtml(currentWords().madeWith)}</a></p>`,
    );
  return parts.join("");
}

function playerData(model: RenderModel): PlayerData {
  const items = model.items.map((item, index): PlayerItem => {
    if (item.kind === "block") {
      return {
        kind: "block",
        index,
        type: item.type,
        heading:
          item.type === "header" || item.type === "text" ? item.heading : blockLook(item).label,
        ...(calloutOfBlock(item.type) ? { callout: calloutOfBlock(item.type) ?? "note" } : {}),
        words: item.heading.split(/\s+/).filter(Boolean).length + richTextWords(item.body),
        width: 0,
        height: 0,
        click: null,
      };
    }
    const step: RenderStep = item;
    return {
      kind: "step",
      index,
      number: step.number,
      text: step.text,
      alt: step.altText,
      words: step.text.split(/\s+/).filter(Boolean).length + richTextWords(step.notes),
      width: step.image?.width ?? 0,
      height: step.image?.height ?? 0,
      click: step.image?.overlay?.click ?? null,
      camera: step.image?.camera ?? null,
      motion: step.motion,
      // Where the typing shows on the screenshot: the highlighted field.
      ...(step.motion?.type === "typed" && step.image?.overlay?.highlight
        ? { field: step.image.overlay.highlight }
        : {}),
    };
  });
  return { title: model.title, stepCount: model.stepCount, labels: walkthroughLabels(), items };
}

/**
 * The interactive walkthrough: one self-contained HTML file (docs/spec/05-export.md). Screenshots
 * must be rendered with `marks = false` (blur and crop burned in, marks drawn live here). It makes
 * no network requests: the CSP allows only this file's own script and styles, by hash.
 */
export async function renderWalkthrough(
  model: RenderModel,
  fonts: WalkthroughFonts = {},
  /**
   * The same guide in other languages (docs/spec/05-export.md#languages): the page carries each,
   * with a language picker, and opens in the viewer's browser language when it has it.
   */
  languages: RenderModel[] = [],
): Promise<string> {
  const css = walkthroughCss(model.brand, fontFaces(fonts));
  const script = `(${playerMain.toString()})();`;
  // "<" is escaped so no text in the guide can close the data block.
  // Built in the model's language (docs/spec/05-export.md#languages).
  const [view, data] = withWords(
    exportWords(model.language),
    () => [staticView(model), playerData(model)] as const,
  );
  const others = languages
    .filter((other) => other.language !== model.language)
    .map((other) =>
      withWords(exportWords(other.language), () => ({
        code: other.language,
        inner: staticInner(other, false),
        data: playerData(other),
      })),
    );
  if (others.length > 0) {
    data.language = model.language;
    data.languages = [model.language, ...others.map((other) => other.code)].map((code) => ({
      code,
      name: languageName(code === "en-GB" ? "en" : code),
    }));
    data.translations = Object.fromEntries(others.map((other) => [other.code, other.data]));
  }
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const csp = [
    "default-src 'none'",
    "img-src data:",
    "font-src data:",
    `style-src 'sha256-${await sha256(css)}'`,
    `script-src 'sha256-${await sha256(script)}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return [
    "<!DOCTYPE html>",
    `<html lang="${escapeHtml(model.language)}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Steps">',
    `<title>${escapeHtml(model.title)}</title>`,
    `<style>${css}</style>`,
    "</head>",
    "<body>",
    view,
    '<div id="player" class="wt-player" hidden></div>',
    // Each other language's "All steps" view, inert until the player swaps one in.
    ...others.map(
      (other) =>
        `<template id="wt-lang-${escapeHtml(other.code)}" lang="${escapeHtml(other.code)}">${other.inner}</template>`,
    ),
    `<script type="application/json" id="guide-data">${json}</script>`,
    `<script>${script}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
