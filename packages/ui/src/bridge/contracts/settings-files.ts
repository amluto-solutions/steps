import { describe, expect, it } from "vitest";

import type { SettingsFiles } from "../settings-files";
import type { MakeSubject } from "./subject";

/** What Export and Import settings, Back up all and Restore rely on. */
export function settingsFilesContract(edition: string, make: MakeSubject<SettingsFiles>) {
  describe(`${edition}: settings and backup files`, () => {
    it("read back a settings file and a backup as they were written", async () => {
      const { part } = await make();
      await part.writeSettingsFile("contract.amlsettings", '{"format":"amlsettings"}');
      await part.writeBackupFile("contract.amlbackup", '{"format":"amlbackup"}');
      expect(await part.readSettingsFile("contract.amlsettings")).toBe('{"format":"amlsettings"}');
      expect(await part.readBackupFile("contract.amlbackup")).toBe('{"format":"amlbackup"}');
    });

    it("refuse to read a file that isn't there", async () => {
      const { part } = await make();
      await expect(part.readSettingsFile("missing.amlsettings")).rejects.toBeDefined();
      await expect(part.readBackupFile("missing.amlbackup")).rejects.toBeDefined();
    });
  });
}
