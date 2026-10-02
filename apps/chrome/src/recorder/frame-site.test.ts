import { describe, expect, it } from "vitest";

import { siteExcluded } from "@amluto-steps/core";
import { frameSite } from "./frame-site";

describe("a frame's site", () => {
  it("is its origin, so an excluded site is found in blank, srcdoc and blob: frames", () => {
    const excluded = ["crm.example"];
    // Chrome gives the frame's origin; Firefox doesn't, and the capture script reports it.
    expect(
      siteExcluded(
        frameSite(undefined, { origin: "https://crm.example", url: "about:blank" }) ?? "",
        excluded,
      ),
    ).toBe(true);
    expect(
      siteExcluded(frameSite("https://crm.example", { url: "about:srcdoc" }) ?? "", excluded),
    ).toBe(true);
    expect(
      siteExcluded(frameSite(undefined, { url: "blob:https://crm.example/1234" }) ?? "", excluded),
    ).toBe(true);
    // A frame on another site stays recorded.
    expect(
      siteExcluded(
        frameSite("https://maps.example", { url: "https://maps.example/x" }) ?? "",
        excluded,
      ),
    ).toBe(false);
  });

  it("never takes an opaque origin as a site", () => {
    expect(frameSite("null", { url: "https://crm.example/a" })).toBe("https://crm.example/a");
  });
});
