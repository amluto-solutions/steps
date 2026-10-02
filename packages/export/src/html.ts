import { isSafeHref, type RichText } from "@amluto-steps/core";

import { safeFontName, type RenderModel } from "./model";
import {
  blockLook,
  CALLOUT_LOOK,
  calloutName,
  CODE_FONTS,
  EXPORT_PALETTE,
  exportWords,
  withWords,
  currentWords,
} from "./words";

export const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

/** Every piece of guide text is escaped: guide files can come from anyone (hostile-file rules). */
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const safeHref = (href: string) => (isSafeHref(href) ? escapeHtml(href) : null);

/**
 * Rich text as HTML. `styled` puts a coloured box's colours inline, for places that drop
 * stylesheets (the clipboard); the walkthrough's policy allows no inline styles, so it styles the
 * box's classes instead.
 */
export function richTextToHtml(node: RichText | null, styled = true): string {
  if (!node) return "";
  const children = (items: RichText[] = []) =>
    items.map((item) => richTextToHtml(item, styled)).join("");
  switch (node.type) {
    case "callout": {
      // Only the four known kinds reach the HTML, whatever an in-memory document holds.
      const kind = node.attrs?.kind && node.attrs.kind in CALLOUT_LOOK ? node.attrs.kind : "note";
      const look = CALLOUT_LOOK[kind];
      const style = styled
        ? ` style="border-left:4px solid ${look.bar};background:${look.fill};padding:6px 12px;margin:8px 0"`
        : "";
      // Its kind is said in words too: the colour alone doesn't tell everyone (WCAG 1.4.1). The
      // walkthrough draws the icon from its stylesheet; pasted HTML carries it as a character.
      const name = escapeHtml(calloutName(kind));
      const label = styled
        ? `<p><strong style="color:${look.ink}">${look.symbol} ${name}</strong></p>`
        : `<p class="wt-callout-label"><strong>${name}</strong></p>`;
      return `<div class="wt-callout wt-callout-${kind}"${style}>${label}${children(node.content)}</div>`;
    }
    case "doc":
      return children(node.content);
    case "paragraph":
      return `<p>${children(node.content)}</p>`;
    case "heading":
      return node.attrs?.level === 3
        ? `<h4>${children(node.content)}</h4>`
        : `<h3>${children(node.content)}</h3>`;
    case "bulletList":
      return `<ul>${children(node.content)}</ul>`;
    case "orderedList":
      return `<ol start="${Number(node.attrs?.start ?? 1)}">${children(node.content)}</ol>`;
    case "listItem":
      return `<li>${children(node.content)}</li>`;
    case "hardBreak":
      return "<br>";
    case "text": {
      let html = escapeHtml(node.text ?? "");
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold") html = `<strong>${html}</strong>`;
        if (mark.type === "italic") html = `<em>${html}</em>`;
        if (mark.type === "link") {
          const href = safeHref(mark.attrs.href);
          if (href) html = `<a href="${href}">${html}</a>`;
        }
      }
      return html;
    }
  }
}

/**
 * "Copy as rich text": plain, inline-styled HTML that survives pasting into Outlook, Teams,
 * SharePoint pages and Confluence (they drop stylesheets). Images are data URLs with alt text.
 */
/** The guide as rich text for the clipboard, in the model's language. */
export function renderClipboardHtml(model: RenderModel): string {
  return withWords(exportWords(model.language), () => clipboardHtml(model));
}

function clipboardHtml(model: RenderModel): string {
  const primary = escapeHtml(model.brand.primary);
  const meta = currentWords().coverParts(model.stepCount, model.minutes, model.date).join(" · ");
  const logo = model.brand.coverLogo;
  const logoSrc = !logo
    ? null
    : logo.type === "svg"
      ? `data:image/svg+xml;base64,${base64(new TextEncoder().encode(logo.data))}`
      : logo.data;
  const parts = [
    logoSrc
      ? `<p><img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(model.brand.name)}" height="40"></p>`
      : "",
    `<h1 style="color:${primary};font-family:'${safeFontName(model.brand.headingFont, "Century Gothic")}',sans-serif">${escapeHtml(model.title)}</h1>`,
    model.description ? `<p>${escapeHtml(model.description)}</p>` : "",
    `<p style="color:${EXPORT_PALETTE.muted}">${escapeHtml(meta)}${model.preparedBy ? ` · ${escapeHtml(currentWords().preparedBy(model.preparedBy))}` : ""}</p>`,
    model.intro
      ? `<h2 style="color:${primary}">${currentWords().beforeYouStart}</h2>${richTextToHtml(model.intro)}`
      : "",
    "<ol>",
  ];
  let listOpen = true;
  for (const item of model.items) {
    if (item.kind === "block") {
      if (listOpen) parts.push("</ol>");
      listOpen = false;
      if (item.type === "header")
        parts.push(`<h2 style="color:${primary}">${escapeHtml(item.heading)}</h2>`);
      else {
        const look = blockLook(item);
        parts.push(
          item.type === "text"
            ? `<div style="border-left:4px solid ${escapeHtml(model.brand.accent)};padding:6px 12px;margin:12px 0">`
            : `<div style="border-left:4px solid ${look.bar};background:${look.fill};padding:6px 12px;margin:12px 0">`,
          // A tip, callout or alert always says which it is, as PDF and Word do: the bar's colour
          // alone doesn't tell everyone (WCAG 1.4.1).
          item.type === "text"
            ? item.heading
              ? `<p><strong>${escapeHtml(item.heading)}</strong></p>`
              : ""
            : `<p><strong style="color:${look.ink}">${look.symbol} ${escapeHtml(look.label)}</strong></p>`,
          richTextToHtml(item.body),
          "</div>",
        );
      }
      continue;
    }
    if (!listOpen) {
      parts.push(`<ol start="${item.number}">`);
      listOpen = true;
    }
    parts.push(
      `<li><p><strong>${escapeHtml(item.text)}</strong></p>`,
      item.code
        ? `<pre style="font-family:${CODE_FONTS};background:${EXPORT_PALETTE.codePaper};border:1px solid ${EXPORT_PALETTE.codeRule};border-radius:6px;padding:8px 10px;white-space:pre-wrap">${escapeHtml(item.code.text)}</pre>`
        : "",
      item.image
        ? `<p><img src="${item.image.dataUrl}" alt="${escapeHtml(item.altText)}" width="${Math.min(640, item.image.width)}" style="max-width:100%;border:1px solid ${EXPORT_PALETTE.line};border-radius:6px"></p>`
        : "",
      richTextToHtml(item.notes),
      "</li>",
    );
  }
  if (listOpen) parts.push("</ol>");
  if (model.outro)
    parts.push(
      `<h2 style="color:${primary}">${escapeHtml(currentWords().youreDone)}</h2>`,
      richTextToHtml(model.outro),
    );
  if (model.madeWith)
    parts.push(
      `<p style="color:${EXPORT_PALETTE.faint};font-size:small"><a href="${currentWords().madeWithUrl}" style="color:inherit">${escapeHtml(currentWords().madeWith)}</a></p>`,
    );
  return parts.join("");
}

/** Plain text for the clipboard's text/plain part. */
/** The guide as plain text for the clipboard, in the model's language. */
export function renderClipboardText(model: RenderModel): string {
  return withWords(exportWords(model.language), () => clipboardText(model));
}

function clipboardText(model: RenderModel): string {
  const lines = [model.title, ""];
  for (const item of model.items) {
    if (item.kind === "step") {
      lines.push(`${item.number}. ${item.text}`);
      // The code on its own lines, indented, so it can be picked out of the text.
      if (item.code) lines.push(...item.code.text.split("\n").map((line) => `    ${line}`));
    } else if (item.heading) lines.push("", item.heading);
  }
  return lines.join("\n");
}
