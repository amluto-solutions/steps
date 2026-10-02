import { describe, expect, it } from "vitest";

import { dateOrder, formatDate, formatIsoDate, formatTime, parseDate } from "./dates.ts";

describe("dates in each language", () => {
  const date = new Date(2026, 9, 1, 14, 5);

  it("writes English dd/mm/yyyy and each other language's own short form", () => {
    expect(formatDate(date)).toBe("01/10/2026");
    expect(formatDate(date, "de")).toBe("01.10.2026");
    expect(formatDate(date, "ja")).toBe("2026/10/01");
    // A code no engine knows falls back to the English form.
    expect(formatDate(date, "xx-invalid-!")).toBe("01/10/2026");
  });

  it("reads a date typed the way each language writes it", () => {
    expect(dateOrder()).toEqual(["day", "month", "year"]);
    expect(dateOrder("ja")).toEqual(["year", "month", "day"]);
    expect(parseDate("31/12/2026")).toBe("2026-12-31");
    expect(parseDate("1-2-26")).toBe("2026-02-01");
    expect(parseDate("31.12.2026", "de")).toBe("2026-12-31");
    expect(parseDate("2026/12/31", "ja")).toBe("2026-12-31");
    // Not a date: the 31st of February, a month 13, words.
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("01/13/2026")).toBeNull();
    expect(parseDate("next week")).toBeNull();
    expect(formatIsoDate("2026-12-31")).toBe("31/12/2026");
    expect(formatIsoDate("2026-12-31", "de")).toBe("31.12.2026");
  });

  it("writes the time on the 24-hour clock", () => {
    expect(formatTime(date)).toBe("14:05");
    expect(formatTime(date, "de")).toBe("14:05");
  });
});
