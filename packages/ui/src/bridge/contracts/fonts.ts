import { describe, expect, it } from "vitest";

import type { Fonts } from "../fonts";
import type { MakeSubject } from "./subject";

/** What the brand editor and a PDF export rely on. */
export function fontsContract(edition: string, make: MakeSubject<Fonts>) {
  describe(`${edition}: fonts`, () => {
    it("have no faces for a family this computer can't give", async () => {
      const { part } = await make();
      // Refusing counts as none: the export then uses its own fonts.
      const faces = await part.getFontFamily("No Such Font 4f9c").catch(() => null);
      if (faces) expect(Object.values(faces).every((face) => face === null)).toBe(true);
    });

    it("refuse an uploaded file that isn't a font", async () => {
      const { part } = await make();
      await expect(part.checkFont(new TextEncoder().encode("not a font"))).rejects.toBeDefined();
    });

    it("say whether installed fonts may be read, where the browser asks", async () => {
      const { part } = await make();
      if (!part.localFonts) return;
      expect(["granted", "prompt", "denied", "unsupported"]).toContain(
        await part.localFonts.state(),
      );
    });
  });
}
