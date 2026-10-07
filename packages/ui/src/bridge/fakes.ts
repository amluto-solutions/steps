/**
 * The recorder bridge's fakes (`@amluto-steps/ui/fakes`): one per small interface, kept in
 * memory. Tests use them in place of partial casts, and the preview builds its bridge from them,
 * so a method the preview lacks is a compile error rather than a silent stand-in.
 */
export { fakeAppWindows, type FakeAppWindows } from "./app-windows-fake";
export { fakeBrands } from "./brands-fake";
export { fakeExtensionLink } from "./extension-link-fake";
export { fakeFontFile, fakeFonts } from "./fonts-fake";
export { fakeHost } from "./host-fake";
export { DEFAULT_HOTKEYS, fakeHotkeys } from "./hotkeys-fake";
export { fakeRecorder, IDLE, type FakeRecorder, type RecorderEvents } from "./recorder-fake";
export { fakeSettingsFiles } from "./settings-files-fake";
export { fakeSupport, type FakeSupport } from "./support-fake";
export { fakeUpdates } from "./updates-fake";
export { fakeExportFiles, type FakeExportFiles } from "./export-files-fake";
export { fakeScreenshot, fakeTextReader, type FakeTextReader } from "./screen-words-fake";
export { fakeCapabilities } from "./capabilities-fake";
export { fakeRecorderBridge } from "./recorder-bridge-fake";
