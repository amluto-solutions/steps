import { fakeCapabilities } from "./capabilities-fake";
import { fakeExportFiles } from "./export-files-fake";
import type { RecorderBridge } from "../recorder-bridge";
import { fakeTextReader } from "./screen-words-fake";
import { fakeAppWindows } from "./app-windows-fake";
import { fakeBrands } from "./brands-fake";
import { fakeExtensionLink } from "./extension-link-fake";
import { fakeFonts } from "./fonts-fake";
import { fakeHost } from "./host-fake";
import { fakeHotkeys } from "./hotkeys-fake";
import { fakeRecorder } from "./recorder-fake";
import { fakeSettingsFiles } from "./settings-files-fake";
import { fakeSupport } from "./support-fake";
import { fakeUpdates } from "./updates-fake";

/**
 * A whole recorder bridge for tests that render the app: Steps for Windows' capabilities and
 * every part's fake, with `parts` in their place. A part is a small interface's fake (with its
 * own settings) or single members; either way it's typed, so a test can't hand the app a
 * method with the wrong shape.
 */
export function fakeRecorderBridge(parts: Partial<RecorderBridge> = {}): RecorderBridge {
  return {
    capabilities: fakeCapabilities(),
    ...fakeRecorder(),
    ...fakeAppWindows(),
    ...fakeHotkeys(),
    ...fakeUpdates(),
    ...fakeBrands(),
    ...fakeFonts(),
    ...fakeSupport(),
    ...fakeExtensionLink(),
    ...fakeSettingsFiles(),
    ...fakeHost(),
    ...fakeTextReader({}),
    ...fakeExportFiles(),
    ...parts,
  };
}
