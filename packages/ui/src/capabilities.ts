/**
 * What this copy of Steps has, stated once by its edition's adapter (the desktop app on Windows or
 * Linux, Steps for Chrome, the preview). The UI shows or hides each feature by what's here, never
 * by asking which edition or operating system it runs on, so a feature an edition lacks is hidden
 * rather than silently doing nothing (docs/decisions.md, architecture deepening, #30).
 *
 * Every field is required, so a new one makes each adapter decide.
 */
export interface Capabilities {
  /**
   * What a recording records: the computer's programs, or a browser's tabs (Settings > Recording
   * then lists sites never recorded in place of apps).
   */
  records: "apps" | "pages";
  /**
   * How Apps never recorded names a program: with `.exe`, added when left off (`KeePass.exe`), or
   * plainly (`keepassxc`).
   */
  programNames: "exe" | "plain";
  /**
   * Starting with the computer, and what it's called: "Start when Windows starts", "Start when you
   * sign in", or not at all.
   */
  autoStart: "windows" | "signIn" | null;
  /**
   * Where "My guides" lives: a folder chosen on the first run, or the browser's own storage (which
   * Settings > Libraries explains).
   */
  defaultLibrary: "folder" | "browser";
  /** Folders added as libraries (Settings > Libraries). */
  libraryFolders: boolean;
  /** Keyboard shortcuts (Settings > Keyboard shortcuts). */
  hotkeys: boolean;
  /** Updates this copy checks for, or says who installs (Settings > About). */
  updates: boolean;
  /** A logs folder and a support file (Settings > About). */
  support: boolean;
  /** A folder exports are saved to; without one they go to the browser's downloads. */
  exportFolder: boolean;
  /** Opening a saved export, or showing it in its folder (a browser saves by name only). */
  openExports: boolean;
  /** Recording a command's output in a terminal. */
  commandOutput: boolean;
  /** Leaving the recording bar out of screenshots. */
  hideBar: boolean;
  /** A second way of detecting clicks to switch to (Troubleshooting, and the paused bar). */
  inputSources: boolean;
  /** What reads a screenshot's words: Windows' own text recognition, Tesseract, or the page. */
  screenWords: "windowsOcr" | "tesseract" | "page";
  /**
   * The link's on/off choice is saved by this page and applied as the app opens. Without it the
   * other side keeps the choice (the browser's background worker), and the page only reads and
   * changes it.
   */
  savesLinkChoice: boolean;
}
