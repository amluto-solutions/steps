import { describe, expect, it } from "vitest";

import vector from "../../../../packages/core/test-vectors/blur.json";
import { burnRedactions } from "./blur";
import { cleanTitle, newId, sortSteps } from "./ids";
import { fit, sniff } from "./images";
import { queryWords, searchGuide, snippet } from "./search";

describe("burning blur (shared with the desktop)", () => {
  it("gives exactly the desktop's pixels for the shared test vector", () => {
    const { width, height } = vector;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        data.set([(x * 7 + y * 3) % 256, (x * 5 + y * 11) % 256, (x * 13 + y * 2) % 256, 255], at);
      }
    burnRedactions(data, width, height, vector.rects);
    let hash = 0x811c9dc5;
    for (const byte of data) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    expect(hash.toString(16).padStart(8, "0")).toBe(vector.fnv1a32);
  });

  it("never changes a pixel outside the areas", () => {
    const data = new Uint8ClampedArray(100 * 100 * 4).map((_, index) => index % 251);
    const before = data.slice();
    burnRedactions(data, 100, 100, [{ x: 40, y: 40, w: 20, h: 20 }]);
    for (let y = 0; y < 100; y += 1)
      for (let x = 0; x < 100; x += 1) {
        if (x >= 40 && x < 60 && y >= 40 && y < 60) continue;
        const at = (y * 100 + x) * 4;
        expect(data.slice(at, at + 4)).toEqual(before.slice(at, at + 4));
      }
  });
});

describe("ids and order", () => {
  it("makes 32-hex ids that sort by time", () => {
    const first = newId(1_700_000_000_000);
    const later = newId(1_700_000_000_001);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first < later).toBe(true);
  });

  it("orders steps by sort key, then id, by plain string order", () => {
    const steps = [
      { id: "b", sortKey: "a1" },
      { id: "a", sortKey: "a1" },
      { id: "c", sortKey: "a0" },
      { id: "Z", sortKey: "a1" },
    ];
    expect(sortSteps(steps).map((step) => step.id)).toEqual(["c", "Z", "a", "b"]);
  });

  it("cleans titles as the desktop does", () => {
    expect(cleanTitle("  Payroll  ")).toBe("Payroll");
    expect(cleanTitle("   ")).toBe("Untitled guide");
    expect(() => cleanTitle("x".repeat(301))).toThrow(/300 characters/);
  });
});

describe("images", () => {
  it("knows a picture by its first bytes, not its name", () => {
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    const webp = new TextEncoder().encode("RIFF1234WEBPVP8 ");
    expect(sniff(webp)).toBe("webp");
    expect(sniff(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  it("fits within an edge, rounding half up, never below one pixel", () => {
    expect(fit(1920, 1080, 2560)).toEqual({ width: 1920, height: 1080 });
    expect(fit(5120, 2880, 2560)).toEqual({ width: 2560, height: 1440 });
    expect(fit(3000, 1, 2560)).toEqual({ width: 2560, height: 1 });
    expect(fit(2561, 1281, 2560)).toEqual({ width: 2560, height: 1280 });
  });
});

describe("search", () => {
  const guide = { title: "Payroll run", tags: ["Finance"], owner: "Sam", description: "" };
  const steps = [
    {
      kind: "interaction",
      actionText: 'Type "hunter2" in "Password" field',
      showValue: false,
      textParts: { value: "hunter2" },
    },
    { kind: "interaction", actionText: 'Click "Approve invoices"', notes: null },
  ];

  it("finds a guide by its card or its wording, and says which step", () => {
    expect(searchGuide("g1", guide, steps, queryWords("payroll"))).toEqual({
      guideId: "g1",
      foundIn: null,
    });
    expect(searchGuide("g1", guide, steps, queryWords("Finance INVOICES"))).toEqual({
      guideId: "g1",
      foundIn: { stepNumber: 2, snippet: 'Click "Approve invoices"' },
    });
    expect(searchGuide("g1", guide, steps, queryWords("payroll nothing"))).toBeNull();
  });

  it("never finds a typed value that's hidden", () => {
    expect(searchGuide("g1", guide, steps, queryWords("hunter2"))).toBeNull();
  });

  it("finds the words written in other languages, without a hidden typed value", () => {
    const german = {
      ...guide,
      translations: { de: { title: "Gehaltsabrechnung prüfen" } },
    };
    const typed = {
      id: "s9",
      kind: "interaction",
      actionText: 'Type "Acme Ltd" in Customer',
      textParts: { value: "Acme Ltd" },
      showValue: false,
      translations: { de: { actionText: "„Acme Ltd“ in Kunde eingeben" } },
    };
    expect(searchGuide("g1", german, [typed], queryWords("gehaltsabrechnung"))).toEqual({
      guideId: "g1",
      foundIn: { stepNumber: null, snippet: "Gehaltsabrechnung prüfen" },
    });
    expect(searchGuide("g1", german, [typed], queryWords("eingeben"))?.foundIn?.stepNumber).toBe(1);
    expect(searchGuide("g1", german, [typed], queryWords("acme"))).toBeNull();
  });

  it("cuts a long passage around the match", () => {
    const long = `${"a ".repeat(60)}needle ${"b ".repeat(60)}`;
    const cut = snippet(long, "needle");
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toContain("needle");
    expect([...cut].length).toBeLessThanOrEqual(92);
  });
});
