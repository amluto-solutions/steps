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
    });

    it("tell a listener when Steps is started again, until it stops listening", async () => {
      const { part } = await make();
      const stop = await part.onAlreadyOpen(() => undefined);
      expect(typeof stop).toBe("function");
      stop();
    });
  });
}
