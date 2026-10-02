import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  brandProfileSchema,
  contrast,
  deriveColours,
  ensureContrast,
  newBrandProfile,
} from "./brand.ts";

describe("brand colours", () => {
  it("measures contrast the WCAG way", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#0E2542", "#FFFFFF")).toBeGreaterThan(14);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("always finds a shade that passes, and leaves passing colours alone", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^#[0-9A-F]{6}$/), (hex) => {
        const passing = ensureContrast(hex);
        expect(contrast(passing, "#FFFFFF")).toBeGreaterThanOrEqual(4.6);
        if (contrast(hex, "#FFFFFF") >= 4.6) expect(passing).toBe(hex);
      }),
    );
  });

  it("derives an accent that works as a UI colour on white", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^#[0-9A-F]{6}$/), (hex) => {
        expect(contrast(deriveColours(hex).accent, "#FFFFFF")).toBeGreaterThanOrEqual(3);
      }),
    );
  });

  it("builds a valid profile from name and colour", () => {
    const profile = newBrandProfile("client-1", "Acme", "#FF6600");
    expect(brandProfileSchema.parse(profile)).toEqual(profile);
    expect(() => brandProfileSchema.parse({ ...profile, primary: "orange" })).toThrow();
  });
});

describe("brand profile files", () => {
  it("load when saved before fonts, page logo, layout and dark colours existed", () => {
    const older = {
      id: "client",
      version: 3,
      name: "Client",
      primary: "#113355",
      accent: "#225577",
      highlight: "#B42318",
      coverLogo: null,
      footer: "Internal use",
      pageSize: "A4",
      orientation: "portrait",
      formatVersion: 1,
    };
    const profile = brandProfileSchema.parse(older);
    expect(profile).toMatchObject({
      pageLogo: null,
      headingFont: null,
      bodyFont: null,
      layout: "standard",
      dark: null,
    });
  });

  it("keep fonts, layout and dark colours, and refuse a bad colour", () => {
    const profile = {
      ...newBrandProfile("client", "Client", "#113355"),
      headingFont: { family: "Montserrat", uploaded: { regular: "AAAA", bold: null } },
      bodyFont: { family: "Segoe UI", uploaded: null },
      layout: "compact" as const,
      dark: { primary: "#88AADD" },
    };
    expect(brandProfileSchema.parse(profile)).toEqual(profile);
    expect(brandProfileSchema.safeParse({ ...profile, dark: { accent: "blue" } }).success).toBe(
      false,
    );
  });
});

describe("brand logos", () => {
  const withLogo = (coverLogo: unknown) => ({
    ...newBrandProfile("client-1", "Acme", "#FF6600"),
    coverLogo,
  });

  it("are carried inside the profile, never fetched from elsewhere", () => {
    const ok = (logo: unknown) => brandProfileSchema.safeParse(withLogo(logo)).success;
    expect(ok({ type: "png", data: "data:image/png;base64,iVBORw0KGgo=" })).toBe(true);
    expect(ok({ type: "jpeg", data: "data:image/jpeg;base64,/9j/4AAQ" })).toBe(true);
    expect(ok({ type: "svg", data: "<?xml version='1.0'?><svg xmlns='x'/>" })).toBe(true);
    // A web address or a file path would make exports and pasted text fetch a picture.
    expect(ok({ type: "png", data: "https://tracker.example/pixel.png?id=1" })).toBe(false);
    expect(ok({ type: "png", data: "file://server/share/logo.png" })).toBe(false);
    expect(ok({ type: "png", data: "data:image/jpeg;base64,/9j/4AAQ" })).toBe(false);
    expect(ok({ type: "svg", data: "https://tracker.example/logo.svg" })).toBe(false);
  });
});
