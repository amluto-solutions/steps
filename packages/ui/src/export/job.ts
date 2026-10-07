import {
  LANGUAGES,
  docIn,
  languageName,
  mainLanguage,
  type BrandProfile,
} from "@amluto-steps/core";
import {
  buildRenderModel,
  headerCount,
  optimiseForSharing,
  renderClipboardHtml,
  renderClipboardText,
  renderDocx,
  renderPdf,
  renderWalkthrough,
  type PdfOptions,
  type RenderModel,
  type RenderedImage,
} from "@amluto-steps/export";

import type { EditorDoc } from "../editor/document";
import { safeFileName } from "../files";
import type { VersionInfo } from "../library-bridge";
import { formatDate } from "../library/dates";
import type { FaceSet } from "../recorder-bridge";
import { lookFor, rasterise } from "../settings/brands";
import type { ExportChoices } from "../settings/preferences";
import type { ExportFiles } from "./export-files";
import { pdfFacesFor, pdfFonts, webFonts } from "./fonts";

export type ExportFormat = "pdf" | "docx" | "html" | "copy" | "amlsteps";

/** What a format's renderer is given for one file: the guide in that file's language. */
export interface FileToRender {
  model: RenderModel;
  request: ExportRequest;
  /** The PDF's faces for this file's characters (noting when no font on the PC has them all). */
  pdfFaces(): Promise<{ heading: FaceSet | null; body: FaceSet | null }>;
  /** The web page, in every language it carries. */
  walkthroughPage(): Promise<Uint8Array>;
}

/** Where an export goes: files a renderer makes, the clipboard, or a `.amlsteps` file. */
export type ExportOutput =
  | { kind: "files"; render: (file: FileToRender) => Promise<Uint8Array> }
  | { kind: "clipboard" }
  | { kind: "amlsteps" };

/**
 * What differs between the formats, in one place (their names come from en.json); running an
 * export reads these and never asks which format it is:
 * - `extension`: the file written, or null for the clipboard.
 * - `brand`: whether the brand choice shows; the clipboard only offers it when there is a choice,
 *   and a .amlsteps file carries the guide itself, not a look.
 * - `walkthrough`: the web page's player takes plain WebP screenshots and draws the pointer itself,
 *   and one page carries every language.
 * - `paged`: a PDF or Word file, which can have a contents and a document-control page.
 * - `output`: where it goes, and for files how each is rendered.
 */
export const FORMATS: Record<
  ExportFormat,
  {
    extension: string | null;
    brand: "always" | "when-several" | "never";
    walkthrough: boolean;
    paged: boolean;
    output: ExportOutput;
  }
> = {
  pdf: {
    extension: "pdf",
    brand: "always",
    walkthrough: false,
    paged: true,
    output: {
      kind: "files",
      render: async (file) =>
        renderPdf(file.model, pdfFonts(await file.pdfFaces()), file.request.pdf),
    },
  },
  docx: {
    extension: "docx",
    brand: "always",
    walkthrough: false,
    paged: true,
    output: { kind: "files", render: async (file) => renderDocx(await withPngLogo(file.model)) },
  },
  html: {
    extension: "html",
    brand: "always",
    walkthrough: true,
    paged: false,
    output: { kind: "files", render: (file) => file.walkthroughPage() },
  },
  copy: {
    extension: null,
    brand: "when-several",
    walkthrough: false,
    paged: false,
    output: { kind: "clipboard" },
  },
  amlsteps: {
    extension: "amlsteps",
    brand: "never",
    walkthrough: false,
    paged: false,
    output: { kind: "amlsteps" },
  },
};

/** The web page's languages: every one, the ones fully written, or only the guide's own. */
export type PageLanguages = "all" | "written" | "main";

/** One export as the review asks for it. */
export interface ExportRequest {
  format: ExportFormat;
  doc: EditorDoc;
  preparedBy: string;
  brand: BrandProfile;
  /** Each step's picture as it will be exported (from the preparation). */
  images: ReadonlyMap<string, RenderedImage>;
  /** The web page's plain pictures (from the preparation). */
  plainImages: ReadonlyMap<string, RenderedImage>;
  /** PDF, Word and the clipboard: the language exported in. */
  language: string;
  /** PDF and Word: more languages, each its own file. */
  alsoIn: readonly string[];
  /** The web page's languages. */
  pageLanguages: PageLanguages;
  pdf: PdfOptions;
  /** PDF and Word: a contents page from the header blocks, when the guide has any. */
  contentsPage: boolean;
  /** PDF and Word: a document-control page with the guide's saved versions. */
  controlPage: boolean;
  /** .amlsteps only: the unblurred originals go in too. */
  includeOriginals: boolean;
  /** Settings and IT policy as this export uses them, read once as its review opened. */
  choices: ExportChoices;
  /** When it's exported: the date in the file names and on the cover. */
  now: Date;
}

/** What a job writes through and asks with. */
export interface ExportJobInput {
  files: ExportFiles;
  /**
   * Asks where to save a file, offering `defaultName` (the save dialog): null when cancelled.
   * `.amlsteps` files are always asked about; others only when the choices say to, or there's no
   * folder to save in.
   */
  askWhere: (defaultName: string) => Promise<string | null>;
  /** An installed font family's faces, for a PDF (fails or has none when it isn't installed). */
  findFont: (family: string) => Promise<FaceSet | null>;
  /** The guide's saved versions, for the document-control page (a guide in a library). */
  listVersions?: (() => Promise<VersionInfo[]>) | undefined;
  /** .amlsteps only: writes the file from the saved guide; absent, there's nothing to write. */
  saveAmlsteps?: ((path: string, includeOriginals: boolean) => Promise<void>) | undefined;
  /** Copy: puts the guide on the clipboard as rich text and plain text. */
  copy?: ((html: string, text: string) => Promise<void>) | undefined;
}

/** How an export ended. */
export type ExportOutcome =
  /** Nothing was saved: a save dialog was cancelled (or there was nothing to write with). */
  | { kind: "cancelled" }
  | { kind: "copied" }
  | { kind: "amlsteps" }
  /**
   * `count` files saved, the last at `path` (a file name only in Steps for Chrome). `fontsMissing`:
   * no font on the PC had every character a PDF shows, so some may print as boxes.
   */
  | { kind: "saved"; count: number; path: string; fontsMissing: boolean };

export interface ExportJob {
  /** Exports the guide: its files written (or the clipboard filled), each language its own file. */
  run(request: ExportRequest): Promise<ExportOutcome>;
  /** The web page in the default browser, exactly as a recipient will see it. */
  preview(request: ExportRequest): Promise<void>;
}

/** The clipboard as a browser offers it, for Copy. */
export async function systemClipboard(html: string, text: string) {
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    }),
  ]);
}

/**
 * An export's file name (docs/spec/05-export.md#saving): the title with the characters Windows
 * forbids replaced, the language when there are several files, and the date.
 */
export const exportFileName = (
  title: string,
  extension: string,
  now: Date,
  language?: string,
): string =>
  `${safeFileName(title)}${language ? ` (${languageName(language)})` : ""} - ${formatDate(now).replace(/\//g, "-")}.${extension}`;

/** The languages every text the guide's writer wrote has been written in, its own first. */
export function fullyWritten(doc: EditorDoc): string[] {
  const main = mainLanguage(doc.guide);
  return [
    main,
    ...LANGUAGES.map((item) => item.code as string).filter(
      (code) => code !== main && docIn(doc, code).missing.length === 0,
    ),
  ];
}

/** The web page's languages, the guide's own first. */
export function pageLanguagesOf(doc: EditorDoc, choice: PageLanguages): string[] {
  const main = mainLanguage(doc.guide);
  if (choice === "main") return [main];
  if (choice === "written") return fullyWritten(doc);
  return [main, ...LANGUAGES.map((item) => item.code as string).filter((code) => code !== main)];
}

/** Word can't take an SVG logo on its own, so the Amluto SVG goes in as a PNG. */
const withPngLogo = async (model: RenderModel): Promise<RenderModel> => {
  const logo = model.brand.coverLogo;
  if (logo?.type !== "svg") return model;
  try {
    return {
      ...model,
      brand: { ...model.brand, coverLogo: { type: "png", data: await rasterise(logo.data) } },
    };
  } catch {
    return { ...model, brand: { ...model.brand, coverLogo: null } };
  }
};

/** Every word a PDF will show, for choosing fonts that have its characters (not its pictures). */
const textForFonts = (model: RenderModel) =>
  JSON.stringify({
    ...model,
    brand: { ...model.brand, coverLogo: null, pageLogo: null },
    items: model.items.map((item) => (item.kind === "step" ? { ...item, image: null } : item)),
  });

/**
 * Running an export (docs/spec/05-export.md): the formats, the languages and their files, the
 * file names, the folder or the save dialog, and the PDF's fonts, written through `files`.
 */
export function exportJob(input: ExportJobInput): ExportJob {
  /** A brand font's faces: uploaded ones as they are, installed ones looked up on the PC. */
  const facesOf = async (font: BrandProfile["headingFont"]): Promise<FaceSet | null> => {
    if (!font) return null;
    if (font.uploaded)
      return {
        regular: font.uploaded.regular,
        bold: font.uploaded.bold,
        italic: null,
        boldItalic: null,
      };
    return input.findFont(font.family).catch(() => null);
  };

  /** The guide in `code`, as an export shows it: its words in that language, and the export's too. */
  const modelIn = (
    request: ExportRequest,
    code: string,
    pictures: ReadonlyMap<string, RenderedImage>,
    extra: Partial<Parameters<typeof buildRenderModel>[3]> = {},
  ) => {
    const { doc } = docIn(request.doc, code);
    return buildRenderModel(doc.guide, doc.steps, pictures, {
      preparedBy: request.preparedBy,
      now: request.now,
      brand: lookFor(request.brand),
      madeWith: request.choices.madeWith,
      language: code,
      ...extra,
    });
  };

  /** Walkthrough only: 1920 px JPEG pictures, about half the size, when the choices say so. */
  const walkthroughImages = async (request: ExportRequest) =>
    request.choices.optimiseForSharing
      ? new Map(
          await Promise.all(
            [...request.plainImages].map(
              async ([id, image]) => [id, await optimiseForSharing(image)] as const,
            ),
          ),
        )
      : request.plainImages;

  /** The web page, in every language it carries. */
  const walkthroughPage = async (
    request: ExportRequest,
    pictures: ReadonlyMap<string, RenderedImage>,
  ) => {
    const [page, ...others] = pageLanguagesOf(request.doc, request.pageLanguages).map((code) =>
      modelIn(request, code, pictures),
    );
    const model = page ?? modelIn(request, mainLanguage(request.doc.guide), pictures);
    return new TextEncoder().encode(await renderWalkthrough(model, webFonts(), others));
  };

  return {
    async preview(request) {
      await input.files.previewWalkthrough(
        await walkthroughPage(request, await walkthroughImages(request)),
      );
    },

    async run(request) {
      const format = FORMATS[request.format];
      const { paged, output } = format;
      const pictures = format.walkthrough ? await walkthroughImages(request) : request.images;
      const extra = {
        contents: paged && request.contentsPage && headerCount(request.doc.steps) > 0,
        documentControl:
          paged && request.controlPage
            ? { versions: (await input.listVersions?.().catch(() => [])) ?? [] }
            : null,
      };
      const model = modelIn(request, request.language, pictures, extra);

      if (output.kind === "clipboard") {
        await (input.copy ?? systemClipboard)(
          renderClipboardHtml(model),
          renderClipboardText(model),
        );
        return { kind: "copied" };
      }

      const extension = format.extension ?? "";
      if (output.kind === "amlsteps") {
        const path = await input.askWhere(`${safeFileName(model.title)}.${extension}`);
        if (!path || !input.saveAmlsteps) return { kind: "cancelled" };
        await input.saveAmlsteps(path, request.includeOriginals);
        return { kind: "amlsteps" };
      }

      // One file, or with more languages chosen for a PDF or Word file, one each.
      const languages = format.walkthrough
        ? [mainLanguage(request.doc.guide)]
        : [request.language, ...request.alsoIn.filter((code) => code !== request.language)];
      const folder = request.choices.askEveryTime
        ? null
        : (request.choices.folder ?? (await input.files.defaultExportFolder()));
      let lastPath: string | null = null;
      let saved = 0;
      let fontsMissing = false;
      for (const code of languages) {
        const shown =
          format.walkthrough || code === request.language
            ? model
            : modelIn(request, code, pictures, extra);
        const name = exportFileName(
          shown.title,
          extension,
          request.now,
          languages.length > 1 ? code : undefined,
        );
        const chosen = folder ? null : await input.askWhere(name);
        if (!folder && !chosen) break;
        const bytes = await output.render({
          model: shown,
          request,
          pdfFaces: async () => {
            const faces = await pdfFacesFor(
              {
                heading: await facesOf(request.brand.headingFont),
                body: await facesOf(request.brand.bodyFont),
              },
              textForFonts(shown),
              code,
              (family) => input.findFont(family).catch(() => null),
            );
            fontsMissing ||= faces.missing;
            return faces;
          },
          walkthroughPage: () => walkthroughPage(request, pictures),
        });
        lastPath = folder
          ? await input.files.writeExportTo(folder, name, bytes)
          : await input.files.writeExport(chosen ?? "", bytes);
        saved += 1;
      }
      if (saved === 0 || !lastPath) return { kind: "cancelled" };
      return { kind: "saved", count: saved, path: lastPath, fontsMissing };
    },
  };
}
