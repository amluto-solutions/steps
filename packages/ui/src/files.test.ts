import { describe, expect, it } from "vitest";

import { safeFileName } from "./files";

describe("file names", () => {
  it("replaces characters Windows forbids and keeps the rest", () => {
    expect(safeFileName('Pay: "Acme" invoices / Q3?')).toBe("Pay Acme invoices Q3");
    expect(safeFileName("  \u0007  ")).toBe("Guide");
    expect(safeFileName("Café £5 guide")).toBe("Café £5 guide");
    expect(safeFileName(" / ", "Brand")).toBe("Brand");
  });
});
