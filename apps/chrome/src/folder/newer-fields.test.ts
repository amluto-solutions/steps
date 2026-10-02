import { describe, expect, it } from "vitest";

import { withNewerFields } from "./newer-fields";

describe("fields a newer Steps wrote", () => {
  it("are kept when this version saves, unless this version knows them or there are too many", () => {
    const onDisk = { id: "g", title: "Old", checklist: ["Ask finance"], translations: { de: {} } };
    // This version's UI never saw "checklist", and took the translations away.
    expect(withNewerFields("guide", onDisk, { id: "g", title: "New" })).toEqual({
      id: "g",
      title: "New",
      checklist: ["Ask finance"],
    });
    const flooded = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, 1]));
    expect(withNewerFields("step", flooded, { id: "s" })).toEqual({ id: "s" });
    expect(withNewerFields("step", null, { id: "s" })).toEqual({ id: "s" });
  });
});
