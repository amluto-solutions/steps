import type { AppWindows, BarPlace } from "./app-windows";

export interface FakeAppWindows extends AppWindows {
  /** Whether the main window is out of the way (minimised) now. */
  readonly mainMinimized: () => boolean;
  /** Whether the main window has been closed (hidden to the tray, on the desktop). */
  readonly mainClosed: () => boolean;
  /** The theme last asked of the main window's frame (null: the device's). */
  readonly windowTheme: () => "light" | "dark" | null;
}

/** The app's windows for tests and the preview: nothing moves, but what was asked is kept. */
export function fakeAppWindows(): FakeAppWindows {
  let minimized = false;
  let closed = false;
  let theme: "light" | "dark" | null = null;
  // Never moved: dragged where it is, as far as its menu knows.
  let place: BarPlace | null = null;
  return {
    mainMinimized: () => minimized,
    mainClosed: () => closed,
    windowTheme: () => theme,
    minimizeMain() {
      minimized = true;
      return Promise.resolve();
    },
    showMain() {
      minimized = false;
      closed = false;
      return Promise.resolve();
    },
    setWindowTheme(next) {
      theme = next;
      return Promise.resolve();
    },
    resizeBar: () => Promise.resolve(),
    moveBar(next) {
      place = next;
      return Promise.resolve();
    },
    barPlace: () => Promise.resolve(place),
    // No close button here to hold.
    askBeforeClose: () => Promise.resolve(),
    onCloseAsked: () => Promise.resolve(() => undefined),
    closeMain() {
      closed = true;
      return Promise.resolve();
    },
    // No tray here to quit from.
    onQuitAsked: () => Promise.resolve(() => undefined),
    quitApp: () => Promise.resolve(),
  };
}
