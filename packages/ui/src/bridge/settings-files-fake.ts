import type { SettingsFiles } from "./settings-files";

/** Settings and backup files for tests and the preview, kept in memory by path. */
export function fakeSettingsFiles(files: Record<string, string> = {}): SettingsFiles {
  const kept = new Map(Object.entries(files));
  const read = (path: string) => {
    const contents = kept.get(path);
    return contents === undefined
      ? Promise.reject(new Error(`No file at ${path}.`))
      : Promise.resolve(contents);
  };
  const write = (path: string, contents: string) => {
    kept.set(path, contents);
    return Promise.resolve();
  };
  return {
    readSettingsFile: read,
    writeSettingsFile: write,
    readBackupFile: read,
    writeBackupFile: write,
  };
}
