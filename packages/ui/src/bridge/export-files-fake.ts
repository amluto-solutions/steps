import type { ExportFiles } from "../export/export-files";

export interface FakeExportFiles extends ExportFiles {
  /** Every file written, in order, by the path it was given. */
  readonly saved: { path: string; bytes: Uint8Array }[];
  /** Every web page sent to the browser to preview. */
  readonly previewed: Uint8Array[];
  /** Every saved file opened (or shown in its folder: `reveal`). */
  readonly shown: { path: string; reveal: boolean }[];
}

/**
 * Export files for tests (the export job's and the dialog's): files are kept in memory by path.
 * As on the desktop, a file written into a folder never replaces one already there: it gets
 * " (2)" (then " (3)"…) before its extension, while a path chosen in the save dialog is written
 * as given. `downloads` is the default folder; absent, there is none.
 */
export function fakeExportFiles(options: { downloads?: string } = {}): FakeExportFiles {
  const saved: FakeExportFiles["saved"] = [];
  const previewed: Uint8Array[] = [];
  const shown: FakeExportFiles["shown"] = [];
  const taken = (path: string) => saved.some((file) => file.path === path);
  return {
    saved,
    previewed,
    shown,
    showExport(path, reveal) {
      shown.push({ path, reveal });
      return Promise.resolve();
    },
    writeExport(path, bytes) {
      saved.push({ path, bytes });
      return Promise.resolve(path);
    },
    writeExportTo(folder, name, bytes) {
      const dot = name.lastIndexOf(".");
      const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      let path = `${folder}\\${name}`;
      for (let copy = 2; taken(path); copy += 1) path = `${folder}\\${stem} (${copy})${extension}`;
      saved.push({ path, bytes });
      return Promise.resolve(path);
    },
    defaultExportFolder: () => Promise.resolve(options.downloads ?? null),
    previewWalkthrough(html) {
      previewed.push(html);
      return Promise.resolve();
    },
  };
}
