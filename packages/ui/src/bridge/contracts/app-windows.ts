import { describe, expect, it } from "vitest";

import type { AppWindows } from "../app-windows";
import type { MakeSubject } from "./subject";

/** What recording (the main window stepping aside) and the recording bar rely on. */
export function appWindowsContract(edition: string, make: MakeSubject<AppWindows>) {
  describe(`${edition}: the app's windows`, () => {
    it("let the main window step aside and come back, and the bar fit and move", async () => {
      const { part } = await make();
      await part.minimizeMain();
      await part.showMain();
      await part.resizeBar(420.4, 48);
      await part.moveBar("right");
      // Where it was moved to, for its menu to mark; null where there's no bar window.
      expect(["right", null]).toContain(await part.barPlace());
    });

    it("give the main window's frame a theme, or the device's", async () => {
      const { part } = await make();
      await part.setWindowTheme("light");
      await part.setWindowTheme("dark");
      await part.setWindowTheme(null);
    });

    it("hold the main window's closing for the page while asked to, and close it when told", async () => {
      const { part } = await make();
      const stop = await part.onCloseAsked(() => undefined);
      expect(typeof stop).toBe("function");
      await part.askBeforeClose(true);
      await part.askBeforeClose(false);
      await part.closeMain();
      stop();
    });

    it("leave the tray's Quit to the page while asked to, and quit when told", async () => {
      const { part } = await make();
      const stop = await part.onQuitAsked(() => undefined);
      expect(typeof stop).toBe("function");
      await part.quitApp();
      stop();
    });
  });
}
