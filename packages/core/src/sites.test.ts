import { describe, expect, it } from "vitest";

import { siteExcluded, siteName } from "./sites.ts";

describe("siteName", () => {
  it("keeps only the host of an address", () => {
    expect(siteName("https://Online.Bank.example/accounts?id=42&token=x")).toBe(
      "online.bank.example",
    );
    expect(siteName("bank.example:8443/login")).toBe("bank.example");
  });

  it("leaves out www", () => {
    expect(siteName("www.bank.example")).toBe("bank.example");
  });

  it("refuses what isn't a site", () => {
    expect(siteName("")).toBeNull();
    expect(siteName("   ")).toBeNull();
    expect(siteName("not a site")).toBeNull();
    expect(siteName("https://")).toBeNull();
  });
});

describe("siteExcluded", () => {
  const sites = ["bank.example", "hr.corp.example"];

  it("covers the site and the sites under it", () => {
    expect(siteExcluded("https://bank.example/", sites)).toBe(true);
    expect(siteExcluded("https://online.bank.example/pay", sites)).toBe(true);
    expect(siteExcluded("https://hr.corp.example/leave", sites)).toBe(true);
  });

  it("doesn't cover a site that only ends the same way", () => {
    expect(siteExcluded("https://mybank.example/", sites)).toBe(false);
    expect(siteExcluded("https://corp.example/", sites)).toBe(false);
  });

  it("ignores what isn't an address", () => {
    expect(siteExcluded("not an address", sites)).toBe(false);
  });
});
