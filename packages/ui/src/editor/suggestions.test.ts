import { describe, expect, it } from "vitest";
import type { OcrLine } from "@amluto-steps/core";

import { screenWords } from "../screen-words";
import { fakeScreenshot, fakeTextReader } from "../bridge/screen-words-fake";
import { blankStep } from "./edits";
import {
  asRedactions,
  blurFoundEdit,
  findOpenInGuide,
  markedNotPersonal,
  notPersonalEdit,
  openFindings,
} from "./suggestions";
import type { FindingSettings } from "../settings/preferences";

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
/** Settings > Privacy as a value: Standard, nothing marked never to suggest. */
const standard = { strength: "standard", safe: [] } as const satisfies FindingSettings;

describe("marking suggestions not personal", () => {
  it("stops them being suggested on that step, as one edit that can be undone", () => {
    const [email] = openFindings(step, lines, [], standard);
    if (!email) throw new Error("no finding");
    const doc = { guide: {} as never, steps: [step] };
    const made = notPersonalEdit("s", [email], "mark not personal")(doc, { at: 5, by: "Jo" });
    const after = made?.changes[0]?.kind === "step" ? made.changes[0].after : null;
    expect(after?.notPersonal).toEqual([
      { x: email.rect.x, y: email.rect.y, w: email.rect.w, h: email.rect.h },
    ]);
    expect(after?.updatedBy).toBe("Jo");
    expect(openFindings(after ?? step, lines, [], standard).map((finding) => finding.kind)).toEqual(
      ["phone"],
    );
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
    const [email] = openFindings(step, lines, [], standard);
    if (!email) throw new Error("no finding");
    const made = notPersonalEdit("s", [email], "x")(doc, { at: 5, by: "Jo" });
    const after = made?.changes[0]?.kind === "step" ? made.changes[0].after : null;
    expect(after?.notPersonal).toHaveLength(200);
    expect(after?.notPersonal?.[0]?.x).toBe(0.25);
  });
});

describe("suggested blurs on a step", () => {
  it("offers everything personal that isn't blurred yet", () => {
    expect(openFindings(step, lines, [], standard).map((finding) => finding.kind)).toEqual([
      "email",
      "phone",
    ]);
  });

  it("skips what is already blurred, and what the crop cuts off", () => {
    const blurred = {
      ...step,
      redactions: [{ x: 9, y: 9, w: 22, h: 4, source: "manual" as const }],
    };
    expect(openFindings(blurred, lines, [], standard).map((finding) => finding.kind)).toEqual([
      "phone",
    ]);
    const cropped = { ...step, crop: { x: 0, y: 0, w: 50, h: 50, source: "manual" as const } };
    expect(openFindings(cropped, lines, [], standard).map((finding) => finding.kind)).toEqual([
      "email",
    ]);
  });

  it("counts a finding as blurred only when every part of it is covered", () => {
    const [email] = openFindings(step, lines, [], standard);
    if (!email) throw new Error("no finding");
    const { x, y, w, h } = email.rect;
    const withBlurs = (...rects: { x: number; y: number; w: number; h: number }[]) => ({
      ...step,
      redactions: rects.map((rect) => ({ ...rect, source: "manual" as const })),
    });
    const kinds = (value: typeof step) =>
      openFindings(value, lines, [], standard).map((item) => item.kind);
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
    const words = screenWords(fakeTextReader({ "m-a": lines, "m-b": "unavailable" }), (id) =>
      Promise.resolve(fakeScreenshot(id)),
    );
    const { found, unread } = await findOpenInGuide(steps, words, [], standard, (done) =>
      progress.push(done),
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

  it("looks as hard as the settings it's given say, and never suggests their safe words", () => {
    const kinds = (settings: FindingSettings) =>
      openFindings(step, lines, [], settings).map((finding) => finding.kind);
    expect(kinds(standard)).toEqual(["email", "phone"]);
    expect(kinds({ strength: "standard", safe: ["acme"] })).toEqual(["phone"]);
    const address: OcrLine[] = [
      {
        words: [
          { text: "SW1A", x: 10, y: 40, w: 6, h: 2 },
          { text: "1AA", x: 17, y: 40, w: 4, h: 2 },
        ],
      },
    ];
    expect(openFindings(step, address, [], standard).map((finding) => finding.kind)).toEqual([
      "postcode",
    ]);
    expect(openFindings(step, address, [], { strength: "light", safe: [] })).toEqual([]);
  });

  it("turns findings into suggested blur areas", () => {
    const [area] = asRedactions(openFindings(step, lines, [], standard));
    expect(area?.source).toBe("suggested");
    expect(area && area.w > 20).toBe(true);
  });
});

describe("notification toasts on a screenshot (P35)", () => {
  // Where the recorder saw a toast, in the bottom-right corner of a whole-monitor screenshot.
  const message = { x: 80, y: 75, w: 19, h: 19 };
  const withToast = {
    ...step,
    media: {
      id: "m-a",
      width: 1920,
      height: 1080,
      scale: 1,
      captureRect: null,
      notifications: [message],
    },
  };
  /** The sender's address in the toast, as text recognition reads it. */
  const inToast: OcrLine[] = [{ words: [{ text: "jo@example.com", x: 82, y: 78, w: 12, h: 2 }] }];
  const kinds = (value: typeof withToast, read: OcrLine[] = []) =>
    openFindings(value, read, [], standard).map((finding) => finding.kind);

  it("are suggested for blurring as notifications, however hard it looks, with no words read", () => {
    expect(openFindings(withToast, [], [], standard)).toEqual([
      { kind: "notification", text: "", rect: message },
    ]);
    expect(openFindings(withToast, [], [], { strength: "light", safe: [] })).toHaveLength(1);
    expect(openFindings(step, [], [], standard)).toEqual([]);
  });

  it("aren't suggested once blurred, marked not personal, or cropped away", () => {
    const blur = { x: 79, y: 74, w: 21, h: 21, source: "manual" as const };
    expect(kinds({ ...withToast, redactions: [blur] })).toEqual([]);
    expect(kinds({ ...withToast, notPersonal: [message] })).toEqual([]);
    const crop = { x: 0, y: 0, w: 50, h: 50, source: "manual" as const };
    expect(kinds({ ...withToast, crop })).toEqual([]);
  });

  it("take in what's read inside them, so it isn't suggested twice", () => {
    expect(kinds(withToast, [...lines, ...inToast])).toEqual(["email", "phone", "notification"]);
    // Marked not personal, the toast's area is, as any such area: what's inside it too.
    expect(kinds({ ...withToast, notPersonal: [message] }, [...lines, ...inToast])).toEqual([
      "email",
      "phone",
    ]);
  });

  it("are found in a guide even where its screenshot's words couldn't be read", async () => {
    const words = screenWords(fakeTextReader({ "m-a": "unavailable" }), (id) =>
      Promise.resolve(fakeScreenshot(id)),
    );
    const { found, unread } = await findOpenInGuide([withToast], words, [], standard);
    expect(found).toEqual([
      { stepId: "s", findings: [{ kind: "notification", text: "", rect: message }] },
    ]);
    expect(unread).toBe(1);
  });
});
