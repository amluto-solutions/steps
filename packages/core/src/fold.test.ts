import { describe, expect, it } from "vitest";

import { foldForSearch } from "./fold.ts";

describe("search folding", () => {
  it("drops case and accents, one character for one", () => {
    expect(foldForSearch("Übersicht Café ŁÓDŹ")).toBe("ubersicht cafe łodz");
    expect(foldForSearch("Übersicht").length).toBe("Übersicht".length);
  });
});
