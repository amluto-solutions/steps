import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  compareSortKeys,
  isSortKey,
  keyBetween,
  MAX_SORT_KEY_LENGTH,
  spreadKeys,
} from "./sort-key.ts";

const key = fc.stringMatching(/^[0-9a-z]{1,12}$/);

describe("keyBetween", () => {
  it("asks for a renumbering before a key gets too long for a step file", () => {
    let last: string | null = null;
    let refused = 0;
    for (let count = 0; count < 2_000; count += 1) {
      const next = keyBetween(last, null);
      if (next === null) {
        refused += 1;
        last = spreadKeys(1)[0] ?? null;
        continue;
      }
      expect(next.length).toBeLessThanOrEqual(MAX_SORT_KEY_LENGTH);
      last = next;
    }
    // Appending at the end grows the key slowly: it only needs renumbering now and then.
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(200);
  });

  it("fits between any two different keys, or says it can't", () => {
    fc.assert(
      fc.property(key, key, (a, b) => {
        if (a === b) return;
        const [low, high] = a < b ? [a, b] : [b, a];
        const middle = keyBetween(low, high);
        if (middle === null) {
          // Only when the keys are equal once trailing zeros are ignored ("1" and "10").
          expect(low.replace(/0+$/, "")).toBe(high.replace(/0+$/, ""));
          return;
        }
        expect(isSortKey(middle)).toBe(true);
        expect(low < middle && middle < high).toBe(true);
        expect(middle.endsWith("0")).toBe(false);
      }),
    );
  });

  it("goes before the first and after the last key", () => {
    fc.assert(
      fc.property(key, (existing) => {
        const after = keyBetween(existing, null);
        expect(after !== null && after > existing).toBe(true);
        const before = keyBetween(null, existing);
        if (/^0+$/.test(existing)) expect(before).toBeNull();
        else expect(before !== null && before < existing).toBe(true);
      }),
    );
  });

  it("keeps working after many inserts in the same gap", () => {
    let low = "a";
    const high = "b";
    for (let index = 0; index < 200; index += 1) {
      const next = keyBetween(low, high) ?? "";
      expect(next > low && next < high).toBe(true);
      low = next;
    }
    expect(low.length).toBeLessThan(80);
  });

  it("slots between the recorder's fixed-width keys", () => {
    expect(keyBetween("0000000001", "0000000002")).toBe("0000000001i");
    expect(keyBetween(null, "0000000001")).toBe("0000000000i");
  });
});

describe("spreadKeys", () => {
  it("returns distinct keys in order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3000 }), (count) => {
        const keys = spreadKeys(count);
        expect(keys).toHaveLength(count);
        const sorted = [...keys].sort(compareSortKeys);
        expect(sorted).toEqual(keys);
        expect(new Set(keys).size).toBe(count);
        expect(keys.every((value) => isSortKey(value) && !value.endsWith("0"))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
