import { describe, expect, it } from "vitest";
import type { OcrLine } from "@amluto-steps/core";

import { blankStep } from "./edits";
import {
  asRedactions,
  blurFoundEdit,
  findOpenInGuide,
  markedNotPersonal,
  notPersonalEdit,
  openFindings,
} from "./suggestions";

const lines: OcrLine[] = [
  { words: [{ text: "jane@acme.com", x: 10, y: 10, w: 20, h: 2 }] },
  {
    words: [
      { text: "07700", x: 60, y: 80, w: 6, h: 2 },
      { text: "900123", x: 67, y: 80, w: 8, h: 2 },
    ],
  },
];
const step = blankStep("s", { at: 0, by: "Robin" });

describe("marking suggestions not personal", () => {
  it("stops them being suggested on that step, as one edit that can be undone", () => {
    const [email] = openFindings(step, lines, []);
    if (!email) throw new Error("no finding");
    const doc = { guide: {} as never, steps: [step] };
    const made = notPersonalEdit("s", [email], "mark not personal")(doc, { at: 5, by: "Jo" });
    const after = made?.changes[0]?.kind === "step" ? made.changes[0].after : null;
    expect(after?.notPersonal).toEqual([
      { x: email.rect.x, y: email.rect.y, w: email.rect.w, h: email.rect.h },
    ]);
    expect(after?.updatedBy).toBe("Jo");
    expect(openFindings(after ?? step, lines, []).map((finding) => finding.kind)).toEqual([
      "phone",
    ]);
    expect(notPersonalEdit("s", [], "x")(doc, { at: 5, by: "Jo" })).toBeNull();
    expect(notPersonalEdit("missing", [email], "x")(doc, { at: 5, by: "Jo" })).toBeNull();
  });

  it("matches a finding read again a little differently, but not one beside it", () => {
    const area = { x: 10, y: 10, w: 20, h: 2 };
    // Text recognition can put the same words a fraction off next time.
    expect(markedNotPersonal({ x: 10.4, y: 10.1, w: 19.5, h: 2 }, [area])).toBe(true);
    expect(markedNotPersonal({ x: 25, y: 10, w: 20, h: 2 }, [area])).toBe(false);
    expect(markedNotPersonal(area, undefined)).toBe(false);
  });

  it("keeps at most 200 areas on a step, dropping the oldest", () => {
    const full = {
      ...step,
      notPersonal: Array.from({ length: 200 }, (_, index) => ({ x: index / 4, y: 0, w: 1, h: 1 })),
    };
    const doc = { guide: {} as never, steps: [full] };
    const [email] = openFindings(step, lines, []);
    if (!email) throw new Error("no finding");
    const made = notPersonalEdit("s", [email], "x")(doc, { at: 5, by: "Jo" });
    const after = made?.changes[0]?.kind === "step" ? made.changes[0].after : null;
    expect(after?.notPersonal).toHaveLength(200);
    expect(after?.notPersonal?.[0]?.x).toBe(0.25);
  });
});

describe("suggested blurs on a step", () => {
  it("offers everything personal that isn't blurred yet", () => {
    expect(openFindings(step, lines, []).map((finding) => finding.kind)).toEqual([
      "email",
      "phone",
    ]);
  });

  it("skips what is already blurred, and what the crop cuts off", () => {
    const blurred = {
      ...step,
      redactions: [{ x: 9, y: 9, w: 22, h: 4, source: "manual" as const }],
    };
    expect(openFindings(blurred, lines, []).map((finding) => finding.kind)).toEqual(["phone"]);
    const cropped = { ...step, crop: { x: 0, y: 0, w: 50, h: 50, source: "manual" as const } };
    expect(openFindings(cropped, lines, []).map((finding) => finding.kind)).toEqual(["email"]);
  });

  it("counts a finding as blurred only when every part of it is covered", () => {
    const [email] = openFindings(step, lines, []);
    if (!email) throw new Error("no finding");
    const { x, y, w, h } = email.rect;
    const withBlurs = (...rects: { x: number; y: number; w: number; h: number }[]) => ({
      ...step,
      redactions: rects.map((rect) => ({ ...rect, source: "manual" as const })),
    });
    const kinds = (value: typeof step) => openFindings(value, lines, []).map((item) => item.kind);
    // Most of it, but not all: still open (this used to count at 60%).
    expect(kinds(withBlurs({ x, y, w: w * 0.8, h }))).toContain("email");
    // Two blurs that meet cover it; two with a gap between them don't.
    expect(kinds(withBlurs({ x, y, w: w / 2, h }, { x: x + w / 2, y, w: w / 2, h }))).not.toContain(
      "email",
    );
    expect(
      kinds(withBlurs({ x, y, w: w * 0.4, h }, { x: x + w * 0.6, y, w: w * 0.4, h })),
    ).toContain("email");
  });

  it("finds and blurs everything in a guide in one edit, counting screenshots it couldn't read", async () => {
    const shot = (id: string) => ({
      ...blankStep(id, { at: 0, by: "Robin" }),
      media: { id: `m-${id}`, width: 10, height: 10, scale: 1, captureRect: null },
    });
    const steps = [shot("a"), shot("b"), blankStep("no-picture", { at: 0, by: "Robin" })];
    const progress: number[] = [];
    const { found, unread } = await findOpenInGuide(
      steps,
      (item) => (item.id === "b" ? Promise.reject(new Error("no OCR")) : Promise.resolve(lines)),
      [],
      (done) => progress.push(done),
    );
    expect(found.map((item) => [item.stepId, item.findings.length])).toEqual([["a", 2]]);
    expect(unread).toBe(1);
    expect(progress).toEqual([1, 2]);
    const made = blurFoundEdit(found, "blur")(
      { guide: {} as never, steps },
      { at: 5, by: "Robin" },
    );
    expect(made?.changes).toHaveLength(1);
    expect(made?.changes[0]).toMatchObject({ id: "a", after: { redactions: [{}, {}] } });
  });

  it("turns findings into suggested blur areas", () => {
    const [area] = asRedactions(openFindings(step, lines, []));
    expect(area?.source).toBe("suggested");
    expect(area && area.w > 20).toBe(true);
  });
});
