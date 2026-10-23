import { describe, expect, it } from "vitest";

import { failureReason } from "./errors";

describe("a failure's reason, for the app's log", () => {
  it("gives the error's kind and words, or a Rust error's code and message", () => {
    expect(failureReason(new RangeError("Offset is outside the bounds of the DataView"))).toBe(
      "RangeError: Offset is outside the bounds of the DataView",
    );
    expect(failureReason({ code: "folderMissing", message: "The export folder is gone." })).toBe(
      "folderMissing: The export folder is gone.",
    );
    expect(failureReason(undefined)).toBe("undefined");
  });

  it("leaves out anything the error quotes, which may be the guide's own words", () => {
    let error: unknown;
    try {
      JSON.parse('{"title": Add a supplier}');
    } catch (thrown) {
      error = thrown;
    }
    expect(failureReason(error)).toMatch(/^SyntaxError: /);
    expect(failureReason(error)).not.toContain("supplier");
    expect(failureReason(new Error("x".repeat(1000))).length).toBeLessThan(320);
  });
});
