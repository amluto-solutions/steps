import { describe, expect, it } from "vitest";

import { releaseAsset, releasePage } from "./github.mjs";

describe("GitHub release addresses", () => {
  it("name a version's file and page", () => {
    expect(releaseAsset("1.0.0", "amluto-steps-1.0.0-x64-setup.exe")).toBe(
      "https://github.com/amluto-solutions/steps/releases/download/v1.0.0/amluto-steps-1.0.0-x64-setup.exe",
    );
    expect(releasePage("1.2.3-rc.1")).toBe(
      "https://github.com/amluto-solutions/steps/releases/tag/v1.2.3-rc.1",
    );
  });

  it("refuse anything that isn't a version or a plain file name", () => {
    expect(() => releaseAsset("latest", "a.exe")).toThrow();
    expect(() => releaseAsset("1.0.0", "../a.exe")).toThrow();
    expect(() => releaseAsset("1.0.0", "a b.exe")).toThrow();
  });
});
