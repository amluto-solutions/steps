// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import type { LibraryGuideSummary } from "../library-bridge";
import { guidesInView, needsReview, readRecent, rememberRecent, tagCounts } from "./views";

const guide = (id: string, tags: string[] = [], reviewBy: string | null = null) =>
  ({
    id,
    title: id,
    updatedAt: "2026-09-01T00:00:00.000Z",
    stepCount: 1,
    tags,
    owner: "",
    reviewBy,
    thumbnailMediaId: null,
  }) satisfies LibraryGuideSummary;

describe("library views", () => {
  beforeEach(() => window.localStorage.clear());

  it("counts tags A to Z", () => {
    expect(tagCounts([guide("a", ["Sales", "HR"]), guide("b", ["HR"])])).toEqual([
      { name: "HR", count: 2 },
      { name: "Sales", count: 1 },
    ]);
  });

  it("filters by tag and review date, and keeps Recently opened in its own order", () => {
    const guides = [guide("a", ["HR"], "2000-01-01"), guide("b"), guide("c", ["HR"])];
    expect(guidesInView(guides, { kind: "tag", tag: "HR" }, [], "lib").map((g) => g.id)).toEqual([
      "a",
      "c",
    ]);
    expect(guidesInView(guides, { kind: "review" }, [], "lib").map((g) => g.id)).toEqual(["a"]);
    expect(needsReview(guide("x", [], "2999-01-01"))).toBe(false);
    const recent = ["lib/c", "other/b", "lib/a", "lib/gone"];
    expect(guidesInView(guides, { kind: "recent" }, recent, "lib").map((g) => g.id)).toEqual([
      "c",
      "a",
    ]);
  });

  it("remembers the latest guide first, once, and keeps it", () => {
    const once = rememberRecent([], "lib", "a");
    const twice = rememberRecent(rememberRecent(once, "lib", "b"), "lib", "a");
    expect(twice).toEqual(["lib/a", "lib/b"]);
    expect(readRecent()).toEqual(["lib/a", "lib/b"]);
  });
});
