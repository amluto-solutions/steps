import { describe, expect, it } from "vitest";

import type { Host } from "../host";
import type { MakeSubject } from "./subject";

/** What the app's start, Settings > General and a guide's saves rely on. */
export function hostContract(edition: string, make: MakeSubject<Host>) {
  describe(`${edition}: preferences, policy and this computer`, () => {
    it("keep the person's name", async () => {
      const { part } = await make();
      const before = await part.getPreferences();
      const saved = await part.setPreferences({ ...before, displayName: "Robin Example" });
      expect(saved.displayName).toBe("Robin Example");
      expect((await part.getPreferences()).displayName).toBe("Robin Example");
    });

    it("give the organisation's policy, or refuse when there's none to read", async () => {
      const { part } = await make();
      const policy = await part.getPolicy().catch(() => null);
      if (policy) expect(Array.isArray(policy.excludedApps)).toBe(true);
    });

    it("start with the computer only where the edition can", async () => {
      const { part, capabilities } = await make();
      if (!capabilities.autoStart) {
        await part.setAutoStartEnabled(true).catch(() => undefined);
        expect(await part.isAutoStartEnabled()).toBe(false);
        return;
      }
      await part.setAutoStartEnabled(true);
      expect(await part.isAutoStartEnabled()).toBe(true);
      await part.setAutoStartEnabled(false);
      expect(await part.isAutoStartEnabled()).toBe(false);
    });

    it("name this computer, and the person's own accounts where it can tell", async () => {
      const { part } = await make();
      const machine = await part.machineIdentity();
      expect(machine.pc).not.toBe("");
      expect(typeof machine.login).toBe("string");
      const names = await part.identityNames();
      expect(names.every((name) => typeof name === "string")).toBe(true);
    });
  });
}
