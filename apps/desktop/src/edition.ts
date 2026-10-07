import type { Capabilities } from "@amluto-steps/ui";

/**
 * What the desktop app has, by the platform its web view names in its user agent: WebKitGTK says
 * "X11; Linux x86_64", WebView2 says Windows. Every field is listed for both, so a new capability
 * has to be decided here.
 */
export function desktopCapabilities(userAgent: string): Capabilities {
  const linux = userAgent.includes("Linux");
  return {
    records: "apps",
    // Linux programs have no extension (`keepassxc`).
    programNames: linux ? "plain" : "exe",
    // The autostart plugin's `~/.config/autostart` entry starts at sign-in.
    autoStart: linux ? "signIn" : "windows",
    defaultLibrary: "folder",
    libraryFolders: true,
    hotkeys: true,
    updates: true,
    support: true,
    exportFolder: true,
    openExports: true,
    commandOutput: true,
    // X11 can't leave a window out of screenshots.
    hideBar: !linux,
    // Linux has one way of detecting clicks.
    inputSources: !linux,
    screenWords: linux ? "tesseract" : "windowsOcr",
    savesLinkChoice: true,
  };
}
