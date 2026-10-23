import { describe, expect, it } from "vitest";
import type { Guide, GuideStep } from "@amluto-steps/core";

import { newGuide } from "../app/documents";
import { blankStep } from "../editor/edits";
import type { ExportChoices } from "../settings/preferences";
import { AMLUTO_PROFILE } from "../settings/brands";
import { fakeExportFiles, type FakeExportFiles } from "../bridge/export-files-fake";
import { exportJob, type AmlstepsTarget, type ExportJobInput, type ExportRequest } from "./job";

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

describe("a recorded double-click (12/10/2026, #55)", () => {
  // As recorded, not written by hand, so each language words it from what it stores.
  const twice: GuideStep = {
    ...step("a"),
    textEdited: false,
    actionText: 'Double-click "Sheet1"',
    textParts: { verb: "doubleClick", target: "Sheet1", kind: "tabitem" },
    naming: { name: "Sheet1", kind: "tab", source: "element", needsReview: false },
  };
  const doc = { guide, steps: [twice] };

  it("is copied as a double-click, in the language chosen", async () => {
    const copied: string[] = [];
    const { job: exporting } = job({
      copy: (_html, text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    await exporting.run(request({ format: "copy", doc }));
    await exporting.run(request({ format: "copy", doc, language: "de" }));
    expect(copied[0]).toContain('Double-click "Sheet1"');
    expect(copied[1]).toContain("Auf „Sheet1“ doppelklicken");
  });

  it("says so in every language the web page carries", async () => {
    const { job: exporting, files } = job();
    await exporting.run(request({ format: "html", doc, pageLanguages: "all" }));
    const page = new TextDecoder().decode(files.saved[0]?.bytes);
    expect(page).toContain("Auf „Sheet1“ doppelklicken");
    expect(page).toContain("「Sheet1」をダブルクリック");
    expect(page).toContain("双击“Sheet1”");
  });
});

describe("the other formats", () => {
  /** A Steps file written from the saved guide: where it went, and whether the originals did. */
  const savingSteps = () => {
    const written: { where: AmlstepsTarget; includeOriginals: boolean }[] = [];
    const saveAmlsteps = (where: AmlstepsTarget, includeOriginals: boolean) => {
      written.push({ where, includeOriginals });
      return Promise.resolve("path" in where ? where.path : `${where.folder}\\${where.name}`);
    };
    return { written, saveAmlsteps };
  };

  it("saves a Steps file in the export folder, as the other files are (12/10/2026, #88)", async () => {
    const { written, saveAmlsteps } = savingSteps();
    const { job: exporting, files, asked } = job({ saveAmlsteps });
    const outcome = await exporting.run(
      request({
        format: "amlsteps",
        includeOriginals: true,
        choices: choices({ folder: String.raw`C:\Exports` }),
      }),
    );
    expect(asked).toEqual([]);
    expect(written).toEqual([
      {
        where: { folder: String.raw`C:\Exports`, name: "Add a supplier - 06-10-2026.amlsteps" },
        includeOriginals: true,
      },
    ]);
    // Written from the saved guide, not through the export's files.
    expect(files.saved).toEqual([]);
    expect(outcome).toEqual({
      kind: "saved",
      count: 1,
      path: String.raw`C:\Exports\Add a supplier - 06-10-2026.amlsteps`,
      fontsMissing: false,
    });

    // No folder in Settings: Downloads, as for the others.
    const downloads = savingSteps();
    await job({ saveAmlsteps: downloads.saveAmlsteps }).job.run(request({ format: "amlsteps" }));
    expect(downloads.written[0]?.where).toEqual({
      folder: String.raw`C:\Users\Robin\Downloads`,
      name: "Add a supplier - 06-10-2026.amlsteps",
    });
  });

  it("asks where a Steps file goes only when the choices say to", async () => {
    const { written, saveAmlsteps } = savingSteps();
    const { job: exporting, asked } = job({
      answer: String.raw`D:\Out\Add a supplier.amlsteps`,
      saveAmlsteps,
    });
    const askEveryTime = choices({ askEveryTime: true });
    const outcome = await exporting.run(request({ format: "amlsteps", choices: askEveryTime }));
    expect(asked).toEqual(["Add a supplier - 06-10-2026.amlsteps"]);
    expect(written).toEqual([
      { where: { path: String.raw`D:\Out\Add a supplier.amlsteps` }, includeOriginals: false },
    ]);
    expect(outcome).toMatchObject({
      kind: "saved",
      path: String.raw`D:\Out\Add a supplier.amlsteps`,
    });

    const cancelled = job({ saveAmlsteps });
    expect(await cancelled.job.run(request({ format: "amlsteps", choices: askEveryTime }))).toEqual(
      { kind: "cancelled" },
    );
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

  it("draws emoji from the bundled emoji font, without saying characters are missing", async () => {
    // The 10/10/2026 test's P45 (#89): 🎉 printed as an empty box.
    const { job: exporting, files, families } = noFonts();
    const noted: GuideStep = {
      ...step("a"),
      notes: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Great job! 🎉 Ask Gran ☎️ if stuck" }],
          },
        ],
      },
    };
    const outcome = await exporting.run(request({ format: "pdf", doc: { guide, steps: [noted] } }));
    // The brand's fonts and the bundled ones show the words; no other font is looked for.
    expect(families).toEqual(["Century Gothic", "Aptos"]);
    expect(outcome).toMatchObject({ kind: "saved", fontsMissing: false });
    const pdf = new TextDecoder("latin1").decode(files.saved[0]?.bytes);
    expect(pdf).toMatch(/\/FontName \/\w+\+NotoEmoji/);
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
