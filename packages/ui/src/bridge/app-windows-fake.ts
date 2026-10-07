import type { AppWindows } from "./app-windows";

export interface FakeAppWindows extends AppWindows {
  /** Whether the main window is out of the way (minimised) now. */
  readonly mainMinimized: () => boolean;
  /** Steps is started again while open: tells every listener. */
  startedAgain(): void;
}

/** The app's windows for tests and the preview: nothing moves, but what was asked is kept. */
export function fakeAppWindows(): FakeAppWindows {
  let minimized = false;
  const listeners = new Set<() => void>();
  return {
    mainMinimized: () => minimized,
    startedAgain() {
      for (const listener of listeners) listener();
    },
    minimizeMain() {
      minimized = true;
      return Promise.resolve();
    },
    showMain() {
      minimized = false;
      return Promise.resolve();
    },
    onAlreadyOpen(handler) {
      listeners.add(handler);
      return Promise.resolve(() => {
        listeners.delete(handler);
      });
    },
    resizeBar: () => Promise.resolve(),
    moveBar: () => Promise.resolve(),
  };
}
