import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Guide, GuideStep, RichText } from "@amluto-steps/core";

import { buildRenderModel, type RenderModel } from "./model";
import { renderDocx } from "./docx";
import { renderPdf, type PdfFonts } from "./pdf";

// Emoji in a PDF (#89, the 10/10/2026 test's P45): the bundled text fonts have no emoji, so 🎉
// printed as an empty box with `\x00` in the text layer. Emoji now come from Noto Emoji.

const require = createRequire(import.meta.url);
const file = (path: string) => new Uint8Array(readFileSync(require.resolve(path)));
const inter = (name: string) => file(`@fontsource/inter/files/inter-latin-${name}.woff`);
const emojiFont = () => file("@fontsource/noto-emoji/files/noto-emoji-emoji-400-normal.woff");

/** The bundled fonts, with the emoji font counted each time it's asked for. */
function bundledFonts() {
  const asked = { emoji: 0 };
  const fonts: PdfFonts = {
    heading: { normal: inter("400-normal"), bold: inter("700-normal") },
    body: {
      normal: inter("400-normal"),
      bold: inter("700-normal"),
      italics: inter("400-italic"),
      bolditalics: inter("700-italic"),
    },
    mono: file("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff"),
    emoji: () => {
      asked.emoji += 1;
      return Promise.resolve(emojiFont());
    },
  };
  return { fonts, asked };
}

const guide = (title: string): Guide => ({
  id: "g1",
  title,
  description: "",
  intro: null,
  outro: null,
  brandProfileId: null,
  tags: [],
  owner: "",
  reviewBy: null,
  createdAt: "2026-10-12T10:00:00.000Z",
  createdBy: "Robin",
  updatedAt: "2026-10-12T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
});

const paragraph = (text: string): RichText => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** A note in bold, then a link: "Well done 🎉 then open ✅ the portal". */
const markedNote: RichText = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Well done 🎉 ", marks: [{ type: "bold" }] },
        {
          type: "text",
          text: "then open ✅ the portal",
          marks: [{ type: "link", attrs: { href: "https://example.com/" } }],
        },
      ],
    },
  ],
};

const step = (notes: string | RichText | null, actionText = "Click Save"): GuideStep => ({
  id: "s1",
  sortKey: "a",
  kind: "interaction",
  action: "click",
  actionText,
  textParts: { verb: "click", target: "Save", kind: "button" },
  showValue: false,
  textEdited: true,
  notes: typeof notes === "string" ? paragraph(notes) : notes,
  altText: null,
  context: { app: null, windowTitle: "" },
  target: null,
  media: null,
  highlight: null,
  crop: null,
  redactions: [],
  annotations: [],
  block: null,
  capturedAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
});

const model = (notes: string | RichText | null, title = "Add a supplier", actionText?: string) =>
  buildRenderModel(guide(title), [step(notes, actionText)], new Map(), {
    preparedBy: "",
    now: new Date(2026, 9, 12),
  });

/** The PDF's words as a screen reader or a copy and paste gets them, and the fonts it embeds. */
async function readPdf(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  let text = "";
  for (let number = 1; number <= document.numPages; number += 1) {
    const content = await (await document.getPage(number)).getTextContent();
    text += content.items.map((item) => ("str" in item ? item.str : "")).join("");
  }
  const fonts = [
    ...Buffer.from(bytes)
      .toString("latin1")
      .matchAll(/\/FontName \/(\S+)/g),
  ].map((match) => match[1] ?? "");
  return { text, fonts };
}

const pdfOf = async (shown: RenderModel, fonts: PdfFonts) =>
  renderPdf(shown, fonts, { pageSize: "A4", orientation: "portrait" }, false);

const NOTE = "Great job! 🎉 Ask Gran ☎️ if stuck — café ünïcödé “quotes”";

describe("emoji in a PDF", () => {
  it("draws a note's emoji from the emoji font, and keeps the real emoji in the text layer", async () => {
    const { fonts } = bundledFonts();
    const { text, fonts: embedded } = await readPdf(await pdfOf(model(NOTE), fonts));
    expect(text).not.toContain("\u0000");
    expect(text).toContain("Great job! 🎉 Ask Gran ☎️ if stuck — café ünïcödé “quotes”");
    expect(embedded.some((name) => name.includes("NotoEmoji"))).toBe(true);
  }, 30_000);

  it("draws emoji in headings, step wording, bold text and links too", async () => {
    const { fonts } = bundledFonts();
    const shown = model(markedNote, "Onboarding 🚀", "Click 👍 Like");
    const bytes = await pdfOf(shown, fonts);
    const { text } = await readPdf(bytes);
    expect(text).not.toContain("\u0000");
    expect(text).toContain("Onboarding 🚀");
    expect(text).toContain("Click 👍 Like");
    expect(text).toContain("Well done 🎉 then open ✅ the portal");
    // The link is still a link, its emoji included.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const page = await (
      await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
    ).getPage(1);
    const links = (await page.getAnnotations()).filter((note) => note.subtype === "Link");
    expect(links.some((link) => link.url === "https://example.com/")).toBe(true);
  }, 30_000);

  it("keeps sequences whole: a family, a flag and a keycap", async () => {
    const { fonts } = bundledFonts();
    const { text } = await readPdf(await pdfOf(model("Team 👨‍👩‍👧 in 🇬🇧, press 1️⃣"), fonts));
    expect(text).not.toContain("\u0000");
    expect(text).toContain("Team 👨‍👩‍👧 in 🇬🇧, press 1️⃣");
  }, 30_000);

  it("draws a symbol the text font lacks from the emoji font, typed without the emoji selector", async () => {
    const { fonts } = bundledFonts();
    const { text } = await readPdf(await pdfOf(model("Ring ☎ or tick ✔"), fonts));
    expect(text).not.toContain("\u0000");
    expect(text).toContain("Ring ☎ or tick ✔");
  }, 30_000);

  it("leaves text without emoji as it was: the emoji font isn't loaded or embedded", async () => {
    const { fonts, asked } = bundledFonts();
    // © and ™ are in the text font, so they stay in it.
    const { text, fonts: embedded } = await readPdf(
      await pdfOf(model("Café © Acme™ — “quotes”"), fonts),
    );
    expect(text).toContain("Café © Acme™ — “quotes”");
    expect(asked.emoji).toBe(0);
    expect(embedded.some((name) => name.includes("NotoEmoji"))).toBe(false);
  }, 30_000);

  it("embeds only the emoji used, not the whole emoji font", async () => {
    const { fonts } = bundledFonts();
    const without = await pdfOf(model("Great job! Ask Gran if stuck"), fonts);
    const withEmoji = await pdfOf(model("Great job! 🎉 Ask Gran ☎️ if stuck"), fonts);
    expect(withEmoji.length - without.length).toBeLessThan(20_000);
  }, 30_000);

  it("leaves Word as it was: the emoji go in as typed", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await renderDocx(model(NOTE)));
    const document = (await zip.file("word/document.xml")?.async("string")) ?? "";
    expect(document).toContain("Great job! 🎉 Ask Gran ☎️ if stuck");
  });

  it("leaves the web page as it was: the emoji go in as typed", async () => {
    const { renderWalkthrough } = await import("./walkthrough/render");
    expect(await renderWalkthrough(model(NOTE))).toContain("Great job! 🎉 Ask Gran ☎️ if stuck");
  });
});
