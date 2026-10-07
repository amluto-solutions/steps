/**
 * The app's own windows, part of the recorder bridge: the main window getting out of the way
 * while recording, and the recording bar's size and place. A browser has one page and no bar
 * window, so there these do nothing.
 */
export interface AppWindows {
  /** The main window gets out of the way while recording, and comes back after Stop. */
  minimizeMain(): Promise<void>;
  showMain(): Promise<void>;
  /** Steps was started again while open, and this copy has come forward. */
  onAlreadyOpen(handler: () => void): Promise<() => void>;
  /** Fits the recording bar window to its content (the bar grows for menus and notes). */
  resizeBar(width: number, height: number): Promise<void>;
  /** Moves the recording bar along the top of its screen: a way to move it without dragging. */
  moveBar(place: "left" | "centre" | "right"): Promise<void>;
}
