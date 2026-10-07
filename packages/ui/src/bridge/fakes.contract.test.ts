import { fakeCapabilities } from "./capabilities-fake";
import { fakeExportFiles } from "./export-files-fake";
import { fakeTextReader } from "./screen-words-fake";
import { fakeAppWindows } from "./app-windows-fake";
import { fakeBrands } from "./brands-fake";
import {
  appWindowsContract,
  brandsContract,
  exportFilesContract,
  extensionLinkContract,
  fontsContract,
  hostContract,
  hotkeysContract,
  settingsFilesContract,
  recordingContract,
  recordingJournalContract,
  SCREEN_WORDS,
  supportContract,
  textReaderContract,
  updatesContract,
} from "./contracts";
import { fakeExtensionLink } from "./extension-link-fake";
import { fakeFonts } from "./fonts-fake";
import { fakeHost } from "./host-fake";
import { noHotkeys } from "./hotkeys";
import { fakeHotkeys } from "./hotkeys-fake";
import { fakeRecorder } from "./recorder-fake";
import { fakeSettingsFiles } from "./settings-files-fake";
import { fakeSupport } from "./support-fake";
import { fakeUpdates } from "./updates-fake";

// The UI's own fakes keep the same contracts as the editions they stand in for, so a test using
// one can't pass on behaviour no edition has.
const windows = fakeCapabilities();
const browser = fakeCapabilities({ hotkeys: false, support: false, autoStart: null });

hotkeysContract("the fake", () => ({ part: fakeHotkeys(), capabilities: windows }));
hotkeysContract("an edition without shortcuts", () => ({
  part: noHotkeys(),
  capabilities: browser,
}));

updatesContract("the fake, with a newer version out", () => ({
  part: fakeUpdates({ newer: { version: "1.0.1", notes: null, published: null } }),
  capabilities: windows,
}));
updatesContract("the fake, up to date", () => ({ part: fakeUpdates(), capabilities: windows }));
updatesContract("the fake, updated by the Store", () => ({
  part: fakeUpdates({ channel: "store" }),
  capabilities: windows,
}));

brandsContract("the fake", () => ({ part: fakeBrands(), capabilities: windows }));
brandsContract("the fake, with brands the organisation deploys", () => ({
  part: fakeBrands({ managed: [{ id: "deployed", name: "Head office" }] }),
  capabilities: windows,
}));

fontsContract("the fake", () => ({ part: fakeFonts(), capabilities: windows }));

supportContract("the fake", () => ({ part: fakeSupport(), capabilities: windows }));
supportContract("the fake, without support files", () => ({
  part: fakeSupport({ support: false }),
  capabilities: browser,
}));

extensionLinkContract("the fake", () => ({ part: fakeExtensionLink(), capabilities: windows }));
extensionLinkContract("the fake, where the link isn't available", () => ({
  part: fakeExtensionLink({ available: false, enabled: false, connected: [] }),
  capabilities: windows,
}));

settingsFilesContract("the fake", () => ({ part: fakeSettingsFiles(), capabilities: windows }));

hostContract("the fake", () => ({ part: fakeHost(), capabilities: windows }));
hostContract("the fake, without starting with the computer", () => ({
  part: fakeHost({ autoStart: false }),
  capabilities: browser,
}));

appWindowsContract("the fake", () => ({ part: fakeAppWindows(), capabilities: windows }));

recordingContract("the fake", () => ({ part: fakeRecorder(), capabilities: windows }));
recordingJournalContract("the fake", () => ({ part: fakeRecorder(), capabilities: windows }));

const screen = (mediaId: string) => new TextEncoder().encode(mediaId);
textReaderContract("the fake", () => ({
  part: fakeTextReader({ readable: SCREEN_WORDS, unreadable: "unavailable" }),
  capabilities: windows,
  readable: screen("readable"),
  unreadable: screen("unreadable"),
}));

exportFilesContract("the fake", () => ({
  part: fakeExportFiles({ downloads: "C:\\Users\\Robin\\Downloads" }),
  capabilities: windows,
}));
