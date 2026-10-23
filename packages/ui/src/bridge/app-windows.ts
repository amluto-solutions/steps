/** Top left, Top centre or Top right of the screen, where "Move the bar" puts the recording bar. */
export type BarPlace = "left" | "centre" | "right";

/**
 * The app's own windows, part of the recorder bridge: the main window getting out of the way
 * while recording, the recording bar's size and place, the title bar's theme, and closing the
 * main window or quitting while the editor has changes it couldn't save. A browser has one page and no bar window, so there most of
 * these do nothing.
 */
export interface AppWindows {
  /** The main window gets out of the way while recording, and comes back after Stop. */
  minimizeMain(): Promise<void>;
  showMain(): Promise<void>;
  /**
   * The main window's frame (its title bar) in the theme chosen in Steps, or the device's when
   * `theme` is null (12/10/2026, #86: the light theme kept a dark title bar on a dark PC). A
   * browser draws its own frame.
   */
  setWindowTheme(theme: "light" | "dark" | null): Promise<void>;
  /** Fits the recording bar window to its content (the bar grows for menus and notes). */
  resizeBar(width: number, height: number): Promise<void>;
  /** Moves the recording bar along the top of its screen: a way to move it without dragging. */
  moveBar(place: BarPlace): Promise<void>;
  /** Where the bar was last moved to, for its menu to mark; null once it's dragged elsewhere. */
  barPlace(): Promise<BarPlace | null>;
  /**
   * While `asking` (a save is failing in the editor), closing the main window asks the page first
   * (docs/spec/04-editor.md#leaving-the-editor): the desktop keeps the window and tells
   * `onCloseAsked` handlers; a browser asks with its own "Leave site?".
   */
  askBeforeClose(asking: boolean): Promise<void>;
  /** The main window's close button was pressed while `askBeforeClose` held it. */
  onCloseAsked(handler: () => void): Promise<() => void>;
  /** Closes the main window after all, as its close button does (the desktop hides it to the tray). */
  closeMain(): Promise<void>;
  /**
   * The tray's Quit was chosen while `askBeforeClose` held closing (#95): the desktop brings the
   * main window forward and leaves quitting to the page. A browser has no tray, so never.
   */
  onQuitAsked(handler: () => void): Promise<() => void>;
  /** Quits after all, as the tray's Quit does when nothing holds it. Nothing to quit in a browser. */
  quitApp(): Promise<void>;
}
