import { describe, expect, it } from "vitest";

import { desktopCapabilities } from "./edition";

// What Settings shows on Linux (docs/spec/07-settings-and-policy.md#linux).
const WEBKITGTK =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";
const WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";

describe("what the desktop app has", () => {
  it("on Windows: everything a desktop has, with Windows' own ways", () => {
    expect(desktopCapabilities(WEBVIEW2)).toEqual({
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
    });
  });

  it("on Linux: starts at sign-in, plain program names, Tesseract, and none of Windows' own", () => {
    expect(desktopCapabilities(WEBKITGTK)).toEqual({
      ...desktopCapabilities(WEBVIEW2),
      programNames: "plain",
      autoStart: "signIn",
      hideBar: false,
      inputSources: false,
      screenWords: "tesseract",
    });
  });
});
