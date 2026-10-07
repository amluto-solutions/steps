/**
 * The part of the recorder bridge an export writes through (cut from it, 06/10/2026): the files
 * saved, the web page's preview, and opening what was saved. The desktop writes them through
 * Rust; Steps for Chrome hands them to Chrome's downloads, so its answers are file names rather
 * than paths, and it can't open them (the `openExports` capability).
 */
export interface ExportFiles {
  /** Opens an exported file, or shows it in its folder. */
  showExport(path: string, reveal: boolean): Promise<void>;
  /** Saves an export where the user chose in the save dialog (PDF, Word or web page only). */
  writeExport(path: string, bytes: Uint8Array): Promise<string>;
  /** Saves an export in a folder under a new name (never replacing a file); returns the path. */
  writeExportTo(folder: string, name: string, bytes: Uint8Array): Promise<string>;
  /** The Downloads folder, where exports go unless Settings says otherwise. */
  defaultExportFolder(): Promise<string | null>;
  /** Opens a walkthrough page in the default browser (saved in app data, replaced each time). */
  previewWalkthrough(html: Uint8Array): Promise<void>;
}
