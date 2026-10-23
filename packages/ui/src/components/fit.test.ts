import { describe, expect, it } from "vitest";

import { nextFit } from "./fit";

const start = { level: 0, needed: [] };

describe("a row of buttons fitting its width (#84)", () => {
  it("hides more labels while the buttons don't fit on one line", () => {
    const first = nextFit(start, 705, 709, 2);
    expect(first).toEqual({ level: 1, needed: [709] });
    const second = nextFit(first, 480, 560, 2);
    expect(second).toEqual({ level: 2, needed: [709, 560] });
  });

  it("goes no further than the most compact, where the row may wrap", () => {
    const most = { level: 2, needed: [709, 560] };
    expect(nextFit(most, 300, 420, 2)).toBe(most);
  });

  it("stays as it is while it fits and there isn't room for the labels it hid", () => {
    const compact = { level: 1, needed: [709] };
    expect(nextFit(compact, 705, 560, 2)).toBe(compact);
  });

  it("shows the labels again once there's room for them", () => {
    expect(nextFit({ level: 2, needed: [709, 560] }, 600, 400, 2)).toEqual({
      level: 1,
      needed: [709, 560],
    });
    expect(nextFit({ level: 1, needed: [709, 560] }, 709, 560, 2)).toEqual({
      level: 0,
      needed: [709, 560],
    });
  });

  it("doesn't count a fraction of a pixel as not fitting", () => {
    expect(nextFit(start, 705, 705.6, 2)).toBe(start);
  });
});
