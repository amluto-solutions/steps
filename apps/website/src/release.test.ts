import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRelease, parseChecksums } from "./release";

const hash = (digit: string) => digit.repeat(64);

/** The site as the page reads it: release.json and SHA256SUMS.txt. */
const site = (sums: string) =>
  vi.fn((url: string) =>
    Promise.resolve(
      url.includes("release.json")
        ? new Response(JSON.stringify({ version: "0.4.0", pub_date: "2026-10-02T09:00:00Z" }))
        : new Response(sums),
    ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the release on the download page", () => {
  it("reads sha256sum's lines, binary marker or not", () => {
    const sums = parseChecksums(`${hash("a")}  one.exe\n${hash("b")} *two.msi\n\nnot a line\n`);
    expect(sums.get("one.exe")).toBe(hash("a"));
    expect(sums.get("two.msi")).toBe(hash("b"));
    expect(sums.size).toBe(2);
  });

  it("offers the Linux beta only when both its packages are listed", async () => {
    const windows = `${hash("1")}  amluto-steps-0.4.0-x64-setup.exe\n`;
    vi.stubGlobal("fetch", site(windows));
    expect((await loadRelease()).linux).toBeNull();

    const halfLinux = `${windows}${hash("2")}  amluto-steps-0.4.0-amd64.deb\n`;
    vi.stubGlobal("fetch", site(halfLinux));
    expect((await loadRelease()).linux).toBeNull();

    const linux = `${halfLinux}${hash("3")}  amluto-steps-0.4.0-x86_64.AppImage\n`;
    vi.stubGlobal("fetch", site(linux));
    const release = await loadRelease();
    expect(release.linux?.deb).toEqual({
      name: "amluto-steps-0.4.0-amd64.deb",
      url: "https://github.com/amluto-solutions/steps/releases/download/v0.4.0/amluto-steps-0.4.0-amd64.deb",
      sha256: hash("2"),
    });
    expect(release.linux?.appImage.sha256).toBe(hash("3"));
    expect(release.published).toBe("02/10/2026");
  });
});
