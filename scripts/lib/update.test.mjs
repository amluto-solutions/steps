import { describe, expect, it } from "vitest";

import { changelogNotes, latestJson, UPDATE_HTACCESS } from "./update.mjs";

const release = {
  version: "0.2.0",
  notes: "Faster exports.",
  published: new Date("2026-10-01T09:00:00Z"),
  url: "https://steps.amluto.com/update/amluto-steps-0.2.0-x64-setup.exe",
  signature: "c2lnbmF0dXJl\n",
};

describe("latest.json", () => {
  it("offers the setup .exe to setup copies only, in the updater's format", () => {
    expect(JSON.parse(latestJson(release))).toEqual({
      version: "0.2.0",
      notes: "Faster exports.",
      pub_date: "2026-10-01T09:00:00.000Z",
      platforms: {
        "windows-x86_64-nsis": {
          signature: "c2lnbmF0dXJl",
          url: "https://steps.amluto.com/update/amluto-steps-0.2.0-x64-setup.exe",
        },
      },
    });
    expect(JSON.parse(latestJson({ ...release, notes: null }))).not.toHaveProperty("notes");
  });

  it("offers the portable program its own entry, which only it asks for", () => {
    const platforms = JSON.parse(
      latestJson({
        ...release,
        portable: {
          url: "https://steps.amluto.com/download/amluto-steps-0.2.0-x64-portable.exe",
          signature: "cA==\n",
        },
      }),
    ).platforms;
    expect(Object.keys(platforms).sort()).toEqual([
      "windows-x86_64-nsis",
      "windows-x86_64-portable",
    ]);
    expect(platforms["windows-x86_64-portable"]).toEqual({
      signature: "cA==",
      url: "https://steps.amluto.com/download/amluto-steps-0.2.0-x64-portable.exe",
    });
    expect(() =>
      latestJson({ ...release, portable: { url: "http://x/y.exe", signature: "cA==" } }),
    ).toThrow();
    expect(() =>
      latestJson({ ...release, portable: { url: "https://x/y.exe", signature: "" } }),
    ).toThrow(/signature/);
  });

  it("offers the Linux beta's AppImage and .deb to those copies, each with its signature", () => {
    const platforms = JSON.parse(
      latestJson({
        ...release,
        linux: [
          {
            bundle: "appimage",
            url: "https://steps.amluto.com/download/a.AppImage",
            signature: "YQ==",
          },
          { bundle: "deb", url: "https://steps.amluto.com/download/a.deb", signature: "Yg==\n" },
        ],
      }),
    ).platforms;
    expect(Object.keys(platforms).sort()).toEqual([
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "windows-x86_64-nsis",
    ]);
    expect(platforms["linux-x86_64-deb"]).toEqual({
      signature: "Yg==",
      url: "https://steps.amluto.com/download/a.deb",
    });
    expect(() =>
      latestJson({ ...release, linux: [{ bundle: "rpm", url: "https://x/y", signature: "c" }] }),
    ).toThrow(/Linux package/);
    expect(() =>
      latestJson({ ...release, linux: [{ bundle: "deb", url: "https://x/y", signature: " " }] }),
    ).toThrow(/signature/);
  });

  it("refuses a pre-release, a plain HTTP download or a missing signature", () => {
    expect(() => latestJson({ ...release, version: "0.2.0-rc.1" })).toThrow(/release version/);
    expect(() => latestJson({ ...release, url: "http://steps.amluto.com/x.exe" })).toThrow(/HTTPS/);
    expect(() => latestJson({ ...release, signature: " " })).toThrow(/signature/);
  });
});

describe("release notes from CHANGELOG.md", () => {
  const changelog =
    "# Changelog\r\n\r\n## 0.2.0 (01/10/2026)\r\n\r\n- Faster exports.\r\n- Chrome 155.\r\n\r\n## 0.1.0\r\n\r\n- First release.\r\n";

  it("are the lines under that version's heading", () => {
    expect(changelogNotes(changelog, "0.2.0")).toBe("- Faster exports.\n- Chrome 155.");
    expect(changelogNotes(changelog, "0.1.0")).toBe("- First release.");
    expect(changelogNotes("## [v0.3.0] - 2026-11-01\nFixes.\n", "0.3.0")).toBe("Fixes.");
  });

  it("are null for a version that isn't there, or only a prefix of one", () => {
    expect(changelogNotes(changelog, "0.4.0")).toBeNull();
    expect(changelogNotes("## 0.2.10\n- x\n", "0.2.1")).toBeNull();
  });
});

describe("the update folder's .htaccess", () => {
  it("stops the manifest being cached and the folder being listed", () => {
    expect(UPDATE_HTACCESS).toContain('<FilesMatch "\\.json$">');
    expect(UPDATE_HTACCESS).toMatch(/<FilesMatch[\s\S]*no-store[\s\S]*<\/FilesMatch>/);
    expect(UPDATE_HTACCESS).toContain("Options -Indexes");
  });
});
