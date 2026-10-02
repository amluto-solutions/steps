import { describe, expect, it } from "vitest";

import { canReadFormat, FORMAT_VERSION } from "./index";

describe("canReadFormat", () => {
  it("accepts every version up to the current one", () => {
    for (let version = 1; version <= FORMAT_VERSION; version += 1) {
      expect(canReadFormat(version)).toBe(true);
    }
  });

  it("refuses newer, zero, negative and fractional versions", () => {
    expect(canReadFormat(FORMAT_VERSION + 1)).toBe(false);
    expect(canReadFormat(0)).toBe(false);
    expect(canReadFormat(-1)).toBe(false);
    expect(canReadFormat(1.5)).toBe(false);
  });
});
