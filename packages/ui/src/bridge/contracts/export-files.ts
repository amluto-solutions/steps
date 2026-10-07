import { describe, expect, it } from "vitest";

import type { ExportFiles } from "../../export/export-files";
import type { MakeSubject } from "./subject";

const bytes = new TextEncoder().encode("%PDF-1.7");

/** What the export job and the export notice rely on. */
export function exportFilesContract(edition: string, make: MakeSubject<ExportFiles>) {
  describe(`${edition}: export files`, () => {
    it("save where the person chose, answering what was saved", async () => {
      const { part } = await make();
      expect(await part.writeExport("C:\\Chosen\\Add a supplier.pdf", bytes)).toContain(
        "Add a supplier.pdf",
      );
    });

    it("save into a folder under a new name each time, never replacing a file", async () => {
      const { part, capabilities } = await make();
      const folder = await part.defaultExportFolder();
      const first = await part.writeExportTo(folder ?? "C:\\Exports", "Add a supplier.pdf", bytes);
      const second = await part.writeExportTo(folder ?? "C:\\Exports", "Add a supplier.pdf", bytes);
      expect(first).toMatch(/\.pdf$/);
      expect(second).toMatch(/\.pdf$/);
      // A browser names the file and its downloads keep both; a folder gets " (2)".
      if (capabilities.exportFolder) expect(second).not.toBe(first);
    });

    it("preview a web page, and open what was saved where the edition can", async () => {
      const { part, capabilities } = await make();
      await part.previewWalkthrough(
        new TextEncoder().encode("<!doctype html><title>Guide</title>"),
      );
      if (capabilities.openExports) {
        const saved = await part.writeExport("C:\\Chosen\\Add a supplier.docx", bytes);
        await part.showExport(saved, false);
        await part.showExport(saved, true);
      }
    });
  });
}
