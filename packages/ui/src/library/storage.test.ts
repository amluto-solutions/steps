import { describe, expect, it } from "vitest";

import { LOW_SPACE_BYTES, formatBytes, freeBytes, storageWarning } from "./storage";

const GB = 1024 ** 3;

describe("browser storage", () => {
  it.each([
    [0, "0 bytes"],
    [900, "900 bytes"],
    [1536, "1.5 KB"],
    [12.44 * 1024 ** 2, "12.4 MB"],
    [250 * 1024 ** 2, "250 MB"],
    [1.2 * GB, "1.2 GB"],
    [-5, "0 bytes"],
  ])("shows %d bytes as %s", (bytes, shown) => {
    expect(formatBytes(bytes)).toBe(shown);
  });

  it("says nothing until the library passes the chosen size", () => {
    const use = { libraryBytes: 0.9 * GB, usedBytes: GB, quotaBytes: 50 * GB };
    expect(storageWarning(use, GB)).toBeNull();
    expect(storageWarning({ ...use, libraryBytes: 1.1 * GB }, GB)).toBe("large");
    expect(storageWarning(null, GB)).toBeNull();
  });

  it("warns when the browser is short of space, however small the library", () => {
    const use = { libraryBytes: 10, usedBytes: 50 * GB - LOW_SPACE_BYTES + 1, quotaBytes: 50 * GB };
    expect(freeBytes(use)).toBe(LOW_SPACE_BYTES - 1);
    expect(storageWarning(use, GB)).toBe("lowSpace");
  });

  it("goes by the library's size alone when the browser won't say what's free", () => {
    const use = { libraryBytes: 2 * GB, usedBytes: null, quotaBytes: null };
    expect(freeBytes(use)).toBeNull();
    expect(storageWarning(use, GB)).toBe("large");
  });
});
