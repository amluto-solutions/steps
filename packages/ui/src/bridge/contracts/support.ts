import { describe, expect, it } from "vitest";

import type { Support } from "../support";
import type { MakeSubject } from "./subject";

/** What Settings > About's Get help and its links rely on. */
export function supportContract(edition: string, make: MakeSubject<Support>) {
  describe(`${edition}: support`, () => {
    it("make a support file, show it and open an email with it, only where the edition has them", async () => {
      const { part, capabilities } = await make();
      const made = part.createSupportBundle(
        "{}",
        [{ name: "My guides", path: "C:\\Guides" }],
        "Robin",
      );
      if (!capabilities.support) {
        await expect(made).rejects.toBeDefined();
        return;
      }
      const bundle = await made;
      expect(bundle.path).not.toBe("");
      expect(Array.isArray(bundle.files)).toBe(true);
      await part.showSupportBundle(bundle.path);
      await part.openSupportEmail(bundle.path, false);
      await part.openLogsFolder();
    });

    it("open Amluto's pages and an open-source component's", async () => {
      const { part } = await make();
      await part.openWebPage("steps");
      await part.openWebPage("crate", "serde");
      await part.openWebPage("npm", "react");
    });
  });
}
