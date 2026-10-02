import { NO_POLICY } from "@amluto-steps/ui";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { managedPolicy } from "./policy";

describe("Chrome's managed policy", () => {
  it("is no policy when IT sets nothing", () => {
    expect(managedPolicy({})).toEqual(NO_POLICY);
  });

  it("reads the desktop's value names, with sites for apps", () => {
    const policy = managedPolicy({
      ExcludedSites: ["https://www.Bank.example/login?next=/", "hr.corp.example", "not a site", 7],
      BlurTerms: ["Project Falcon"],
      SensitiveFieldPatterns: ["staff number"],
      Locked: ["IncludeOriginals", "Nonsense"],
      DisableKeystrokeRecording: true,
      RecordTypingByDefault: false,
    });
    expect(policy).toMatchObject({
      excludedApps: ["bank.example", "hr.corp.example"],
      blurTerms: ["Project Falcon"],
      sensitiveFieldPatterns: ["staff number"],
      locked: ["IncludeOriginals"],
      disableKeystrokeRecording: true,
      recordTypingByDefault: false,
      includeOutputByDefault: null,
      libraries: [],
      autoStart: null,
    });
  });

  it("falls back value by value when one doesn't fit", () => {
    const policy = managedPolicy({ BlurTerms: "not a list", DisableKeystrokeRecording: true });
    expect(policy.blurTerms).toEqual([]);
    expect(policy.disableKeystrokeRecording).toBe(true);
  });

  it("declares every value it reads in the schema Chrome checks", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../public/managed_schema.json", import.meta.url), "utf8"),
    ) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        "AppColoursBrand",
        "BlurStrength",
        "BlurTerms",
        "DefaultPdfBrand",
        "DisableKeystrokeRecording",
        "ExcludedSites",
        "Language",
        "LanguageTone",
        "Locked",
        "RecordTypingByDefault",
        "SensitiveFieldPatterns",
        "ShowUnnamedTyping",
      ].sort(),
    );
  });
});
