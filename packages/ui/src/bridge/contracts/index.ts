/**
 * The recorder bridge's contract tests (`@amluto-steps/ui/contracts`): one suite per small
 * interface, run against each edition's adapter (the desktop's, Steps for Chrome's), the
 * preview's and the UI's own fakes, so the three can't drift apart. Test files only: these
 * register Vitest suites.
 */
export type { MakeSubject, Subject } from "./subject";
export { appWindowsContract } from "./app-windows";
export { brandsContract } from "./brands";
export { exportFilesContract } from "./export-files";
export { SCREEN_WORDS, textReaderContract, type TextReaderSubject } from "./text-reader";
export { extensionLinkContract } from "./extension-link";
export { fontsContract } from "./fonts";
export { hostContract } from "./host";
export { hotkeysContract } from "./hotkeys";
export { ADDED_STEP, recordingContract, recordingJournalContract, START } from "./recording";
export { settingsFilesContract } from "./settings-files";
export { supportContract } from "./support";
export { updatesContract } from "./updates";
