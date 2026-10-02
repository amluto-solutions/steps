import { describe, expect, it } from "vitest";

import vectors from "../test-vectors/sensitive.json";
import { looksSensitive, maskCardNumbers, maskValue } from "./sensitive";

// The same cases as the Rust capture crate's sensitive.rs, from the shared file.
describe("sensitive fields and masked values (shared with Rust)", () => {
  it.each(vectors.sensitiveFields)("treats %j as a sensitive field", (field) => {
    expect(looksSensitive([field])).toBe(true);
  });

  it.each(vectors.ordinaryFields)("leaves %j alone", (field) => {
    expect(looksSensitive([field])).toBe(false);
  });

  it("extends the list with policy terms, and matches any of the texts", () => {
    const { field, term } = vectors.policyTerm;
    expect(looksSensitive([field])).toBe(false);
    expect(looksSensitive([field], [term])).toBe(true);
    expect(looksSensitive(["Code", "", "txtPassword"])).toBe(true);
  });

  it.each(vectors.masked)("masks %j as %j", (value, expected) => {
    expect(maskValue(value as string)).toBe(expected);
  });

  it.each(vectors.unmasked)("keeps %j as typed", (value) => {
    expect(maskValue(value)).toBe(value);
  });

  it.each(vectors.cardNumbersOnly)("masks only cards and IBANs in %j", (value, expected) => {
    expect(maskCardNumbers(value as string)).toBe(expected);
  });
});
