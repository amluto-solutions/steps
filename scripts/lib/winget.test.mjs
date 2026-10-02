import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PACKAGE_ID, wingetManifests } from "./winget.mjs";

const release = {
  version: "0.4.0",
  released: new Date("2026-09-30T12:00:00Z"),
  setup: {
    url: "https://steps.amluto.com/download/amluto-steps-0.4.0-x64-setup.exe",
    sha256: "e4d183c83748e7717476f331d92bd9c366df7c513c78b602cb6c3e41cefe42a1",
  },
  msi: {
    url: "https://steps.amluto.com/download/amluto-steps-0.4.0-x64.msi",
    sha256: "77e467ce3eb68123a10db5d6575cc6c6c3e6eca2dd58785f1ee7502f70f13a83",
    productCode: "{0F5A1C1E-2B8D-4C3A-9E71-5D6B4A2C8F10}",
    upgradeCode: "{A8772EA5-E41C-5D68-862D-0BE9828A10A7}",
  },
  notes: "Zoom on screenshots.\nBlur one suggestion at a time.",
};

describe("winget manifests", () => {
  const files = wingetManifests(release);

  it("are the three files winget-pkgs expects, for this version", () => {
    expect(Object.keys(files).sort()).toEqual(
      [
        `${PACKAGE_ID}.installer.yaml`,
        `${PACKAGE_ID}.locale.en-GB.yaml`,
        `${PACKAGE_ID}.yaml`,
      ].sort(),
    );
    for (const text of Object.values(files)) {
      expect(text).toContain('PackageIdentifier: "Amluto.Steps"');
      expect(text).toContain('PackageVersion: "0.4.0"');
    }
  });

  it("offer the setup for one person and the .msi for the whole PC", () => {
    const installer = files[`${PACKAGE_ID}.installer.yaml`];
    expect(installer).toMatch(/InstallerType: "nullsoft"\n {2}Scope: "user"/);
    expect(installer).toMatch(/InstallerType: "wix"\n {2}Scope: "machine"/);
    expect(installer).toContain(`InstallerSha256: "${release.setup.sha256.toUpperCase()}"`);
    expect(installer).toContain(`ProductCode: "${release.msi.productCode}"`);
    expect(installer).toContain('ReleaseDate: "2026-09-30"');
  });

  it("refuse what winget would reject or couldn't check", () => {
    expect(() =>
      wingetManifests({ ...release, setup: { ...release.setup, url: "http://x/a.exe" } }),
    ).toThrow(/https/);
    expect(() => wingetManifests({ ...release, version: "0.4.0-rc.1" })).toThrow(/version/);
    expect(() =>
      wingetManifests({ ...release, msi: { ...release.msi, productCode: "nope" } }),
    ).toThrow(/ProductCode/);
  });

  // winget itself checks them against the schema, where it's installed (the release PC).
  const winget = spawnSync("winget", ["--version"], { encoding: "utf8" });
  it.runIf(winget.status === 0)("pass winget validate", () => {
    const folder = mkdtempSync(join(tmpdir(), "winget-test-"));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
      const result = spawnSync("winget", ["validate", "--manifest", folder], {
        encoding: "utf8",
      });
      expect(result.stdout).toMatch(/succeeded/i);
      expect(result.status).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
