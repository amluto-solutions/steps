import type { Capabilities } from "../capabilities";

/**
 * What Steps for Windows has, which tests start from. Production code has no such default: each
 * edition's adapter states its own, so an edition can't quietly show Windows' features.
 */
const WINDOWS: Capabilities = {
  records: "apps",
  programNames: "exe",
  autoStart: "windows",
  defaultLibrary: "folder",
  libraryFolders: true,
  hotkeys: true,
  updates: true,
  support: true,
  exportFolder: true,
  openExports: true,
  commandOutput: true,
  hideBar: true,
  inputSources: true,
  screenWords: "windowsOcr",
  savesLinkChoice: true,
};

/** Steps for Windows' capabilities with the given ones changed, for tests. */
export const fakeCapabilities = (changes: Partial<Capabilities> = {}): Capabilities => ({
  ...WINDOWS,
  ...changes,
});
