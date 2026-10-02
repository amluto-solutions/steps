import { describe, expect, it } from "vitest";

import { FIREFOX_ID, manifestProblems } from "./extension.mjs";

const chrome = {
  manifest_version: 3,
  version: "0.5.2",
  permissions: ["storage", "unlimitedStorage", "scripting", "sidePanel"],
};
const firefox = {
  manifest_version: 3,
  version: "0.5.2",
  permissions: ["storage", "unlimitedStorage", "scripting", "downloads"],
  browser_specific_settings: { gecko: { id: FIREFOX_ID } },
};

describe("a store build's manifest", () => {
  it("passes when it's the right build for its browser and version", () => {
    expect(manifestProblems(chrome, { browser: "chrome", version: "0.5.2" })).toEqual([]);
    expect(manifestProblems(firefox, { browser: "firefox", version: "0.5.2" })).toEqual([]);
  });

  it("refuses another version, or the end-to-end tests' build", () => {
    expect(manifestProblems(chrome, { browser: "chrome", version: "0.5.3" })).toEqual([
      "its version is 0.5.2, not 0.5.3",
    ]);
    const e2e = { ...chrome, permissions: [...chrome.permissions, "nativeMessaging"] };
    expect(manifestProblems(e2e, { browser: "chrome", version: "0.5.2" })[0]).toMatch(/end-to-end/);
  });

  it("refuses Firefox's settings in the wrong browser's build", () => {
    expect(manifestProblems(firefox, { browser: "chrome", version: "0.5.2" })).toHaveLength(1);
    const noId = { ...firefox, browser_specific_settings: undefined };
    expect(manifestProblems(noId, { browser: "firefox", version: "0.5.2" })[0]).toMatch(
      /Firefox id/,
    );
  });
});
