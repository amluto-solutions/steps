import { describe, expect, it } from "vitest";
import type { OcrLine } from "@amluto-steps/core";

import { screenWords } from "./screen-words";
import { fakeScreenshot, fakeTextReader } from "./bridge/screen-words-fake";

const word = (text: string, x: number) => ({ text, x, y: 10, w: 8, h: 2 });
const lines: OcrLine[] = [{ words: [word("Name:", 5), word("jane@acme.com", 20)] }];
type Blur = { x: number; y: number; w: number; h: number };
const step = (mediaId: string, blurs: Blur[] = [], source: "manual" | "suggested" = "manual") => ({
  media: { id: mediaId, width: 100, height: 100, scale: 1, captureRect: null },
  redactions: blurs.map((blur) => ({ ...blur, source })),
});
const EMAIL_BLUR = { x: 18, y: 8, w: 14, h: 6 };

describe("screen words", () => {
  it("gives the words on a step's screenshot, less those under its blur", async () => {
    const words = screenWords(fakeTextReader({ shot: lines }), async (id) => fakeScreenshot(id));
    expect(await words.wordsOf(step("shot"))).toEqual(lines);
    expect(await words.wordsOf(step("shot", [EMAIL_BLUR]))).toEqual([
      { words: [word("Name:", 5)] },
    ]);
  });

  it("answers unavailable, not no words, when a screenshot can't be read", async () => {
    const load = async (id: string) =>
      id === "gone" ? Promise.reject(new Error("not synced")) : fakeScreenshot(id);
    const words = screenWords(fakeTextReader({ blank: [], broken: "unavailable" }), load);
    expect(await words.wordsOf(step("blank"))).toEqual([]);
    expect(await words.wordsOf(step("broken"))).toBe("unavailable");
    expect(await words.wordsOf(step("gone"))).toBe("unavailable");
    // Without any text reader (no recorder), nothing can be read.
    expect(await screenWords(undefined, load).wordsOf(step("blank"))).toBe("unavailable");
  });

  it("reads each screenshot once per blur, however often and however soon it's asked", async () => {
    const reader = fakeTextReader({ shot: lines });
    let loads = 0;
    const words = screenWords(reader, async (id) => {
      loads += 1;
      return fakeScreenshot(id);
    });
    // Two at once (the editor's step and Blur all), then again later: one read.
    await Promise.all([words.wordsOf(step("shot")), words.wordsOf(step("shot"))]);
    await words.wordsOf({ ...step("shot"), redactions: [] });
    expect(reader.reads).toHaveLength(1);
    expect(loads).toBe(1);
    // Another blur on the same screenshot is another answer, read with that blur; the same
    // area suggested rather than drawn is the same blur.
    await words.wordsOf(step("shot", [EMAIL_BLUR]));
    await words.wordsOf(step("shot", [EMAIL_BLUR], "suggested"));
    expect(reader.reads.map((read) => read.blurred)).toEqual([[], [EMAIL_BLUR]]);
  });

  it("reads a step's screenshot round its click, once per click", async () => {
    // The reader looks closer round the click (enlarged, contrast raised: #19), so two steps
    // sharing a screenshot but clicked in different places get their own reading.
    const reader = fakeTextReader({ shot: lines });
    const words = screenWords(reader, async (id) => fakeScreenshot(id));
    const clicked = (x: number, y: number) => ({
      ...step("shot"),
      highlight: { x: x - 1.5, y: y - 3, w: 3, h: 6, shape: "circle" as const },
    });
    await words.wordsOf(clicked(20, 11));
    await words.wordsOf(clicked(20, 11));
    await words.wordsOf(clicked(60, 40));
    await words.wordsOf(step("shot"));
    expect(reader.reads.map((read) => read.at)).toEqual([
      { x: 20, y: 11 },
      { x: 60, y: 40 },
      undefined,
    ]);
  });

  it("tries again after a screenshot couldn't be read", async () => {
    const screens: Record<string, OcrLine[] | "unavailable"> = { shot: "unavailable" };
    const words = screenWords(fakeTextReader(screens), async (id) => fakeScreenshot(id));
    expect(await words.wordsOf(step("shot"))).toBe("unavailable");
    screens.shot = lines;
    expect(await words.wordsOf(step("shot"))).toEqual(lines);
  });

  it("has no words for a step without a screenshot", async () => {
    const words = screenWords(fakeTextReader({}), async (id) => fakeScreenshot(id));
    expect(await words.wordsOf({ media: null, redactions: [] })).toEqual([]);
  });
});
