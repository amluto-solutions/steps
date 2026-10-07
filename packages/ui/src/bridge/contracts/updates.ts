import { describe, expect, it } from "vitest";

import type { UpdateChannel, Updates } from "../updates";
import type { MakeSubject } from "./subject";

const CHANNELS: UpdateChannel[] = [
  "checks",
  "store",
  "msi",
  "policy",
  "portable",
  "readOnly",
  "none",
];

/** The copies that update themselves; the others say who updates them. */
const updatesItself = (channel: UpdateChannel) => channel === "checks" || channel === "portable";

/** What Settings > About and the update notice rely on. */
export function updatesContract(edition: string, make: MakeSubject<Updates>) {
  describe(`${edition}: updates`, () => {
    it("say where this copy gets them, and only a copy with updates checks itself", async () => {
      const { part, capabilities } = await make();
      const channel = await part.updatesChannel();
      expect(CHANNELS).toContain(channel);
      if (!capabilities.updates) expect(updatesItself(channel)).toBe(false);
    });

    it("never find, download or install anything in a copy something else updates", async () => {
      const { part } = await make();
      if (updatesItself(await part.updatesChannel())) return;
      // Finding nothing and refusing to look both leave the About screen with nothing to offer.
      expect(await part.checkForUpdate().catch(() => null)).toBeNull();
      expect(await part.pendingUpdate()).toBeNull();
      await expect(part.downloadUpdate()).rejects.toBeDefined();
      await expect(part.installUpdate()).rejects.toBeDefined();
    });

    it("keep a downloaded version waiting for the next start", async () => {
      const { part } = await make();
      if (!updatesItself(await part.updatesChannel())) return;
      const found = await part.checkForUpdate();
      if (!found) {
        expect(await part.pendingUpdate()).toBeNull();
        return;
      }
      expect(await part.downloadUpdate()).toBe(found.version);
      expect(await part.pendingUpdate()).toBe(found.version);
    });
  });
}
