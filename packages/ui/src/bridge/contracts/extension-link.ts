import { linkStatusSchema } from "@amluto-steps/core";
import { describe, expect, it } from "vitest";

import type { ExtensionLink, LinkStatus } from "../extension-link";
import type { MakeSubject } from "./subject";

/** What Settings' link row and the app's start rely on. */
export function extensionLinkContract(edition: string, make: MakeSubject<ExtensionLink>) {
  describe(`${edition}: the link between Steps for Windows and the browser`, () => {
    it("say whether this copy can link, whether it's on, and who's connected", async () => {
      const { part } = await make();
      expect(linkStatusSchema.safeParse(await part.getLink()).success).toBe(true);
      // Null asks for this copy's default, and answers the status like any change.
      expect(linkStatusSchema.safeParse(await part.setLink(null)).success).toBe(true);
    });

    it("switch off and on, answering the status as it now is", async () => {
      const { part } = await make();
      if (!(await part.getLink()).available) return;
      const off = await part.setLink(false);
      expect(off).toMatchObject({ enabled: false, connected: [] });
      expect((await part.getLink()).enabled).toBe(false);
      expect((await part.setLink(true)).enabled).toBe(true);
    });

    it("tell a listener of changes until it stops listening", async () => {
      const { part } = await make();
      const heard: LinkStatus[] = [];
      const stop = await part.onLink((status) => heard.push(status));
      expect(typeof stop).toBe("function");
      stop();
      await part.setLink(false);
      expect(heard).toEqual([]);
    });
  });
}
