import { compareSortKeys, parseGuide, parseStep, type GuideStep } from "@amluto-steps/core";
import { describe, expect, it } from "vitest";

import { mergeGuides, type MergePart } from "./merge";

const doc = (
  id: string,
  title: string,
  steps: GuideStep[],
  extra: Record<string, unknown> = {},
): MergePart["doc"] => ({
  guide: parseGuide({
    id,
    title,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    formatVersion: 1,
    ...extra,
  }),
  steps,
});

const shot = (id: string, sortKey: string, mediaId: string | null, text = id) =>
  parseStep({
    id,
    sortKey,
    kind: "interaction",
    action: "click",
    actionText: text,
    textParts: { verb: "click", target: text, kind: "button" },
    showValue: false,
    context: { app: null, windowTitle: "" },
    target: null,
    media: mediaId ? { id: mediaId, width: 800, height: 600, scale: 1, captureRect: null } : null,
    highlight: null,
    capturedAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    formatVersion: 1,
  });

const rich = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

let next = 0;
const options = (headings = true) => ({
  title: "  New starter: day one  ",
  headings,
  author: "Robin",
  now: new Date("2026-10-01T14:05:00Z"),
  newId: (prefix: string) => `${prefix}-${(next += 1)}`,
});

describe("merging guides", () => {
  const outlook = doc(
    "g1",
    "Set up Outlook",
    [shot("capture-1", "a0", "click-1", "Open Outlook"), shot("capture-2", "a1", "click-2")],
    {
      intro: rich("Before you start"),
      outro: rich("Outlook is ready"),
      tags: ["IT", "Onboarding"],
      owner: "Priya",
      brandProfileId: "contoso",
      reviewBy: "2027-04-01",
      description: "Mail setup",
    },
  );
  // A recording of its own: the same step and screenshot names as the first.
  const teams = doc(
    "g2",
    "Join Teams",
    [
      shot("capture-1", "a0", "click-1", "Open Teams"),
      // A split step: two steps, one screenshot.
      shot("capture-2", "a1", "click-1", "Click Join"),
    ],
    {
      intro: rich("Teams first"),
      outro: rich("All done"),
      tags: ["IT", "Teams"],
      owner: "Sam",
      reviewBy: "2027-01-15",
    },
  );
  const parts: MergePart[] = [
    { libraryId: "mine", doc: outlook },
    { libraryId: "shared", doc: teams },
  ];

  it("gives every step and screenshot a new id, copying a shared screenshot once", () => {
    const merged = mergeGuides(parts, options());
    const ids = merged.steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("capture-1");
    expect(merged.media).toHaveLength(3);
    expect(
      merged.media.map((item) => [item.fromLibraryId, item.fromGuideId, item.mediaId]),
    ).toEqual([
      ["mine", "g1", "click-1"],
      ["mine", "g1", "click-2"],
      ["shared", "g2", "click-1"],
    ]);
    const teamsShots = merged.steps
      .filter((step) => step.actionText === "Open Teams" || step.actionText === "Click Join")
      .map((step) => step.media?.id);
    expect(teamsShots[0]).toBe(teamsShots[1]);
    expect(teamsShots[0]).toBe(merged.media[2]?.newMediaId);
  });

  it("puts each part under its heading, in order, keeping every intro and outro", () => {
    const merged = mergeGuides(parts, options());
    const outline = merged.steps.map((step) =>
      step.block
        ? `${step.block.type}:${step.block.heading || JSON.stringify(step.block.body).match(/"text":"([^"]+)"/)?.[1]}`
        : step.actionText,
    );
    expect(outline).toEqual([
      "header:Set up Outlook",
      "Open Outlook",
      "capture-2",
      "text:Outlook is ready",
      "header:Join Teams",
      "text:Teams first",
      "Open Teams",
      "Click Join",
    ]);
    const keys = merged.steps.map((step) => step.sortKey);
    expect([...keys].sort(compareSortKeys)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(merged.guide.intro).toEqual(outlook.guide.intro);
    expect(merged.guide.outro).toEqual(teams.guide.outro);

    const plain = mergeGuides(parts, options(false));
    expect(plain.steps.some((step) => step.block?.type === "header")).toBe(false);
  });

  it("takes the first guide's details, every tag and the earliest review date", () => {
    const { guide } = mergeGuides(parts, options());
    expect(guide).toMatchObject({
      title: "New starter: day one",
      description: "Mail setup",
      owner: "Priya",
      brandProfileId: "contoso",
      tags: ["IT", "Onboarding", "Teams"],
      reviewBy: "2027-01-15",
      createdBy: "Robin",
      createdAt: "2026-10-01T14:05:00.000Z",
      formatVersion: 1,
    });
    expect(guide.id).not.toBe("g1");
    expect(guide.recordingSessionId).toBeUndefined();
  });

  it("refuses to merge nothing", () => {
    expect(() => mergeGuides([], options())).toThrow();
  });
});
