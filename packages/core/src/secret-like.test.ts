import { describe, expect, it } from "vitest";

import { looksLikeSecret } from "./secret-like.ts";

describe("values that look like a password", () => {
  it("catches mixed letters, digits and symbols in one word", () => {
    for (const value of ["Qz7Test", "hunter2!", "a8f3k2m9", "P@ssw0rd", "Winter2026!"])
      expect(looksLikeSecret(value), value).toBe(true);
  });

  it("leaves ordinary values alone", () => {
    for (const value of [
      "Acme Ltd",
      "sam@example.com",
      "https://example.com/a1",
      "01/10/2026",
      "12345678",
      "B6",
      "Quinn",
      "London",
      "invoice",
    ])
      expect(looksLikeSecret(value), value).toBe(false);
  });
});
