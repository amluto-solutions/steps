import { describe, expect, it } from "vitest";
import type { Guide, GuideStep } from "@amluto-steps/core";

import { newGuide } from "../app/documents";
import { blankStep } from "../editor/edits";
import type { ExportChoices } from "../settings/preferences";
import { AMLUTO_PROFILE } from "../settings/brands";
import { fakeExportFiles, type FakeExportFiles } from "../bridge/export-files-fake";
import { exportJob, type ExportJobInput, type ExportRequest } from "./job";

const guide: Guide = newGuide("g", "Add a supplier", "Robin");
const step = (id: string): GuideStep => ({
  ...blankStep(id, { at: 0, by: "Robin" }),
  kind: "interaction",
  action: "click",
  actionText: `Click ${id}`,
});

const choices = (overrides: Partial<ExportChoices> = {}): ExportChoices => ({
  folder: null,
  askEveryTime: false,
  optimiseForSharing: true,
  madeWith: true,
  originalsLocked: false,
  defaultBrand: "amluto",
  findings: { strength: "standard", safe: [] },
  ...overrides,
});

/** An export as the review asks for it, on 06/10/2026, with nothing changed from its defaults. */
const request = (overrides: Partial<ExportRequest> = {}): ExportRequest => ({
  format: "docx",
  doc: { guide, steps: [step("a")] },
  preparedBy: "Robin",
  brand: AMLUTO_PROFILE,
  images: new Map(),
  plainImages: new Map(),
  language: "en",
  alsoIn: [],
  pageLanguages: "all",
  pdf: { pageSize: "A4", orientation: "portrait" },
  contentsPage: false,
  controlPage: false,
  includeOriginals: false,
  choices: choices(),
  now: new Date(2026, 9, 6),
  ...overrides,
});

/**
 * A job writing to fake files (Downloads the default folder unless `files` is given). The save
 * dialog answers `answer`, cancelled unless given, and keeps each name it offered.
 */
function job(
  options: { files?: FakeExportFiles; answer?: string | null } & Partial<
    Omit<ExportJobInput, "files" | "askWhere">
  > = {},
) {
  const {
    files = fakeExportFiles({ downloads: String.raw`C:\Users\Robin\Downloads` }),
    answer = null,
    ...rest
  } = options;
  const asked: string[] = [];
  const exporting = exportJob({
    files,
    askWhere: (name) => {
      asked.push(name);
      return Promise.resolve(answer);
    },
    findFont: () => Promise.reject(new Error("not installed")),
    ...rest,
  });
  return { job: exporting, files, asked };
}

describe("an export in several languages", () => {
  const translated = {
    guide: { ...guide, translations: { de: { title: "Lieferanten anlegen" } } },
    steps: [step("a")],
  };

  it("makes a file per language, each named with its language and titled in it", async () => {
    const { job: exporting, files } = job();
    const outcome = await exporting.run(
      request({ doc: translated, language: "en", alsoIn: ["de", "fr", "en"] }),
    );
    const downloads = String.raw`C:\Users\Robin\Downloads`;
    expect(files.saved.map((file) => file.path)).toEqual([
      `${downloads}\\Add a supplier (English) - 06-10-2026.docx`,
      `${downloads}\\Lieferanten anlegen (Deutsch) - 06-10-2026.docx`,
      // Not written in French yet, so its title is the guide's own.
      `${downloads}\\Add a supplier (Français) - 06-10-2026.docx`,
    ]);
    expect(outcome).toMatchObject({
      kind: "saved",
      count: 3,
      path: `${downloads}\\Add a supplier (Français) - 06-10-2026.docx`,
    });
  });

  it("names a single file in another language without it", async () => {
    const { job: exporting, files } = job();
    await exporting.run(request({ doc: translated, language: "de" }));
    expect(files.saved.map((file) => file.path)).toEqual([
      String.raw`C:\Users\Robin\Downloads\Lieferanten anlegen - 06-10-2026.docx`,
    ]);
  });

  it("asks about each file when the choices say to, and stops at the first cancelled", async () => {
    const files = fakeExportFiles();
    const answers = [String.raw`D:\Out\English.docx`, null, String.raw`D:\Out\French.docx`];
    const asked: string[] = [];
    const exporting = exportJob({
      files,
      askWhere: (name) => {
        asked.push(name);
        return Promise.resolve(answers.shift() ?? null);
      },
      findFont: () => Promise.resolve(null),
    });
    const outcome = await exporting.run(
      request({
        doc: translated,
        alsoIn: ["de", "fr"],
        choices: choices({ askEveryTime: true }),
      }),
    );
    expect(asked).toEqual([
      "Add a supplier (English) - 06-10-2026.docx",
      "Lieferanten anlegen (Deutsch) - 06-10-2026.docx",
    ]);
    expect(files.saved.map((file) => file.path)).toEqual([String.raw`D:\Out\English.docx`]);
    expect(outcome).toMatchObject({ kind: "saved", count: 1 });
  });

  it("puts every language in one web page, or the ones chosen", async () => {
    const page = async (pageLanguages: "all" | "written" | "main") => {
      const { job: exporting, files } = job();
      await exporting.run(
        request({ format: "html", doc: translated, alsoIn: ["de"], pageLanguages }),
      );
      expect(files.saved.map((file) => file.path)).toEqual([
        String.raw`C:\Users\Robin\Downloads\Add a supplier - 06-10-2026.html`,
      ]);
      return new TextDecoder().decode(files.saved[0]?.bytes);
    };
    const all = await page("all");
    expect(all).toContain("Lieferanten anlegen");
    expect(all).toContain('"ja"');
    const main = await page("main");
    expect(main).not.toContain("Lieferanten anlegen");
  });
});

describe("the other formats", () => {
  it("always asks where a Steps file goes, and writes it with or without the originals", async () => {
    const written: [string, boolean][] = [];
    const saveAmlsteps = (path: string, includeOriginals: boolean) => {
      written.push([path, includeOriginals]);
      return Promise.resolve();
    };
    const {
      job: exporting,
      files,
      asked,
    } = job({
      answer: String.raw`D:\Out\Add a supplier.amlsteps`,
      saveAmlsteps,
    });
    const outcome = await exporting.run(
      request({
        format: "amlsteps",
        includeOriginals: true,
        choices: choices({ folder: String.raw`C:\Exports` }),
      }),
    );
    expect(asked).toEqual(["Add a supplier.amlsteps"]);
    expect(written).toEqual([[String.raw`D:\Out\Add a supplier.amlsteps`, true]]);
    // Written from the saved guide, not through the export's files.
    expect(files.saved).toEqual([]);
    expect(outcome).toEqual({ kind: "amlsteps" });

    const cancelled = job({ saveAmlsteps });
    expect(await cancelled.job.run(request({ format: "amlsteps" }))).toEqual({
      kind: "cancelled",
    });
    expect(written).toHaveLength(1);
  });

  it("copies the guide as rich and plain text, with “Made with Steps” unless the choices say not", async () => {
    const copied: { html: string; text: string }[] = [];
    const { job: exporting, files } = job({
      copy: (html, text) => {
        copied.push({ html, text });
        return Promise.resolve();
      },
    });
    expect(await exporting.run(request({ format: "copy" }))).toEqual({ kind: "copied" });
    await exporting.run(request({ format: "copy", choices: choices({ madeWith: false }) }));
    expect(copied[0]?.html).toContain("Click a");
    expect(copied[0]?.text).toContain("Click a");
    expect(copied[0]?.html).toContain("Made with Steps");
    expect(copied[1]?.html).not.toContain("Made with Steps");
    expect(files.saved).toEqual([]);
  });

  it("lists the guide's saved versions only for a document-control page in PDF or Word", async () => {
    let asked = 0;
    const listVersions = () => {
      asked += 1;
      return Promise.resolve([]);
    };
    const { job: exporting } = job({ listVersions });
    await exporting.run(request({ format: "docx" }));
    await exporting.run(request({ format: "html", controlPage: true }));
    expect(asked).toBe(0);
    await exporting.run(request({ format: "docx", controlPage: true }));
    expect(asked).toBe(1);
  });

  it("previews the web page in the browser without saving it", async () => {
    const { job: exporting, files } = job();
    await exporting.preview(request({ format: "html" }));
    expect(files.saved).toEqual([]);
    expect(files.previewed).toHaveLength(1);
    expect(new TextDecoder().decode(files.previewed[0])).toContain("Add a supplier");
  });
});

describe("a PDF's fonts", () => {
  /** A job whose PC has no fonts installed, keeping each family it was asked for. */
  const noFonts = () => {
    const families: string[] = [];
    const exporting = job({
      findFont: (family) => {
        families.push(family);
        return Promise.reject(new Error("not installed"));
      },
    });
    return { ...exporting, families };
  };

  it("uses the brand's fonts from the PC, or the bundled ones, for English", async () => {
    const { job: exporting, files, families } = noFonts();
    const outcome = await exporting.run(request({ format: "pdf" }));
    expect(families).toEqual(["Century Gothic", "Aptos"]);
    expect(new TextDecoder().decode(files.saved[0]?.bytes.slice(0, 5))).toBe("%PDF-");
    expect(outcome).toMatchObject({ kind: "saved", fontsMissing: false });
  });

  it("looks for the script's own fonts, and says when no font on the PC has the characters", async () => {
    const { job: exporting, files, families } = noFonts();
    const outcome = await exporting.run(request({ format: "pdf", language: "ja" }));
    expect(families).toContain("Yu Gothic");
    // Still saved: the characters no font has may print as boxes, and the message says so.
    expect(files.saved).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "saved", fontsMissing: true });
  });

  it("says so when any one of several languages' files lacks a font", async () => {
    const { job: exporting } = noFonts();
    const outcome = await exporting.run(request({ format: "pdf", alsoIn: ["ja"] }));
    expect(outcome).toMatchObject({ kind: "saved", count: 2, fontsMissing: true });
  });
});

describe("where an export is saved, and its name", () => {
  it("saves to the folder the choices name, as the guide's title and the date, without asking", async () => {
    const { job: exporting, files, asked } = job();
    const outcome = await exporting.run(
      request({ choices: choices({ folder: String.raw`C:\Exports` }) }),
    );
    expect(files.saved.map((file) => file.path)).toEqual([
      String.raw`C:\Exports\Add a supplier - 06-10-2026.docx`,
    ]);
    expect(asked).toEqual([]);
    expect(outcome).toEqual({
      kind: "saved",
      count: 1,
      path: String.raw`C:\Exports\Add a supplier - 06-10-2026.docx`,
      fontsMissing: false,
    });
  });

  it("saves to Downloads when no folder is chosen, never replacing a file already there", async () => {
    const { job: exporting, files } = job();
    await exporting.run(request());
    await exporting.run(request());
    expect(files.saved.map((file) => file.path)).toEqual([
      String.raw`C:\Users\Robin\Downloads\Add a supplier - 06-10-2026.docx`,
      String.raw`C:\Users\Robin\Downloads\Add a supplier - 06-10-2026 (2).docx`,
    ]);
  });

  it("asks where to save when the choices say to, offering the name, and saves there", async () => {
    const { job: exporting, files, asked } = job({ answer: String.raw`D:\Chosen\Suppliers.docx` });
    const outcome = await exporting.run(
      request({ choices: choices({ folder: String.raw`C:\Exports`, askEveryTime: true }) }),
    );
    expect(asked).toEqual(["Add a supplier - 06-10-2026.docx"]);
    expect(files.saved.map((file) => file.path)).toEqual([String.raw`D:\Chosen\Suppliers.docx`]);
    expect(outcome).toMatchObject({ kind: "saved", path: String.raw`D:\Chosen\Suppliers.docx` });
  });

  it("asks when there's no folder to save in, and writes nothing when the dialog is cancelled", async () => {
    const files = fakeExportFiles();
    const { job: exporting, asked } = job({ files });
    expect(await exporting.run(request())).toEqual({ kind: "cancelled" });
    expect(asked).toEqual(["Add a supplier - 06-10-2026.docx"]);
    expect(files.saved).toEqual([]);
  });

  it("replaces the characters Windows forbids in the title", async () => {
    const { job: exporting, files } = job();
    await exporting.run(
      request({ doc: { guide: { ...guide, title: 'Pay: "Acme" <UK>/EU?' }, steps: [step("a")] } }),
    );
    expect(files.saved[0]?.path).toBe(
      String.raw`C:\Users\Robin\Downloads\Pay Acme UK EU - 06-10-2026.docx`,
    );
  });
});
