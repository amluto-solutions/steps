import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CHECK_IDENTITY, fillManifest, identityProblems, storeVersion } from "./msix.mjs";

const template = readFileSync(
  new URL("../../apps/desktop/msix/AppxManifest.xml", import.meta.url),
  "utf8",
);

describe("the Store package", () => {
  it("has a four-part version with the last part 0", () => {
    expect(storeVersion("0.1.0")).toBe("0.1.0.0");
    expect(storeVersion("12.3.45")).toBe("12.3.45.0");
    expect(() => storeVersion("1.2")).toThrow(/major.minor.patch/);
    expect(() => storeVersion("1.2.70000")).toThrow(/65535/);
  });

  it("says which Partner Center values are still missing", () => {
    const blank = { identityName: "", publisher: "", publisherDisplayName: "" };
    expect(identityProblems(blank)).toHaveLength(3);
    expect(identityProblems({ ...blank, publisher: "Amluto" })[1]).toMatch(/starts CN=/);
    expect(identityProblems(CHECK_IDENTITY)).toEqual([]);
  });

  it("fills every placeholder, escaped, and nothing else changes", () => {
    const filled = fillManifest(template, {
      ...CHECK_IDENTITY,
      publisher: 'CN=A & B "Ltd"',
      version: "0.1.0.0",
    });
    expect(filled).not.toMatch(/__[A-Z_]+__/);
    expect(filled).toContain('Publisher="CN=A &amp; B &quot;Ltd&quot;"');
    expect(filled).toContain('Version="0.1.0.0"');
    expect(() => fillManifest("__SOMETHING_ELSE__", { ...CHECK_IDENTITY, version: "1" })).toThrow(
      /still has __SOMETHING_ELSE__/,
    );
  });

  it("is a full-trust app with a Start with Windows task the app switches on", () => {
    expect(template).toContain('EntryPoint="Windows.FullTrustApplication"');
    expect(template).toContain('<rescap:Capability Name="runFullTrust" />');
    // The task id must match capture-win32's STARTUP_TASK_ID.
    expect(template).toMatch(/<desktop:StartupTask TaskId="AmlutoStepsStartup" Enabled="false"/);
    const startup = readFileSync(
      new URL("../../apps/desktop/src-tauri/crates/capture-win32/src/startup.rs", import.meta.url),
      "utf8",
    );
    expect(startup).toContain('STARTUP_TASK_ID: &str = "AmlutoStepsStartup"');
  });

  it("keeps the app's own AppData folders visible outside the package", () => {
    // The browser opens the preview, Explorer shows logs and the support file, and unsaved
    // recordings survive an uninstall, as with the installers.
    expect(template).toContain('<rescap:Capability Name="unvirtualizedResources" />');
    for (const folder of [
      String.raw`$(KnownFolder:RoamingAppData)\Amluto\Steps`,
      String.raw`$(KnownFolder:LocalAppData)\com.amluto.steps`,
    ]) {
      expect(template).toContain(`<virtualization:ExcludedDirectory>${folder}<`);
    }
  });
});
