import { describe, expect, it, vi } from "vitest";
import { newBrandProfile } from "@amluto-steps/core";

import { buildBackup, readBackup } from "./backup";

const parts = {
  settings: {
    kind: "amluto-steps-settings" as const,
    formatVersion: 1 as const,
    displayName: "Robin",
    recording: {
      outputSettleMs: 1_500,
      captureMode: "window" as const,
      excludedApps: ["KeePass.exe"],
    },
    theme: "dark" as const,
  },
  blurTerms: ["Project Falcon"],
  exportFolder: "D:/Exports",
  exportAsk: false,
  defaultPdfBrand: "client",
  appColours: "client",
  brands: [{ ...newBrandProfile("client", "Client", "#113355"), version: 3 }],
  libraries: [{ name: "Team", path: "D:/Guides", isDefault: true }],
};
const check = vi.fn(async () => ({ embeddable: true }));

describe("backups", () => {
  it("hold everything needed to set the app up again", async () => {
    const text = buildBackup(parts, new Date("2026-09-26T10:00:00Z"));
    const restored = await readBackup(text, check);
    expect(restored.settings).toEqual(parts.settings);
    expect(restored.brands).toEqual(parts.brands);
    expect(restored.file).toMatchObject({
      createdAt: "2026-09-26T10:00:00.000Z",
      blurTerms: ["Project Falcon"],
      exportFolder: "D:/Exports",
      defaultPdfBrand: "client",
      appColours: "client",
      libraries: parts.libraries,
    });
  });

  it("are refused whole when anything in them is wrong", async () => {
    await expect(readBackup("{", check)).rejects.toThrow("notBackupFile");
    const text = JSON.parse(buildBackup(parts)) as Record<string, unknown>;
    await expect(
      readBackup(JSON.stringify({ ...text, kind: "something-else" }), check),
    ).rejects.toThrow("notBackupFile");
    await expect(readBackup(JSON.stringify({ ...text, brands: ["{}"] }), check)).rejects.toThrow(
      "notBrandFile",
    );
  });
});
