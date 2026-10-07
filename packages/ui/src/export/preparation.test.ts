import { describe, expect, it, vi } from "vitest";
import { newBrandProfile, type GuideStep, type OcrLine } from "@amluto-steps/core";
import { renderStepImage } from "@amluto-steps/export";

import { blankStep } from "../editor/edits";
import { fakeScreenshot, fakeTextReader } from "../bridge/screen-words-fake";
import { AMLUTO_PROFILE } from "../settings/brands";
import { exportPreparation } from "./preparation";

// Drawing needs a canvas, which tests don't have: each drawing is a picture naming the step drawn.
vi.mock("@amluto-steps/export", async (original) => ({
  ...(await original<typeof import("@amluto-steps/export")>()),
  renderStepImage: vi.fn(async (step: GuideStep) => ({
    dataUrl: `drawn:${step.id}`,
    width: 10,
    height: 10,
  })),
}));

const shot = (id: string): GuideStep => ({
  ...blankStep(id, { at: 0, by: "Robin" }),
  kind: "interaction",
  action: "click",
  actionText: `Click ${id}`,
  media: { id: `m-${id}`, width: 10, height: 10, scale: 1, captureRect: null },
});
const email: OcrLine[] = [{ words: [{ text: "jane@acme.com", x: 10, y: 10, w: 20, h: 3 }] }];

function preparing(
  options: {
    screens?: Record<string, OcrLine[] | "unavailable">;
    loadImage?: (mediaId: string) => Promise<string>;
  } = {},
) {
  const reader = fakeTextReader(options.screens ?? {});
  const preparation = exportPreparation({
    loadImage: options.loadImage ?? ((id) => Promise.resolve(fakeScreenshot(id))),
    textReader: reader,
    walkthrough: false,
    blurTerms: [],
    findings: { strength: "standard", safe: [] },
  });
  return { preparation, reader };
}

describe("an export's first pass", () => {
  it("draws every screenshot and checks each for personal data", async () => {
    const { preparation } = preparing({ screens: { "m-a": email } });
    await preparation.prepare([shot("a"), shot("b")], AMLUTO_PROFILE);
    const { images, findings, unchecked, missing, progress } = preparation.state;
    expect(images.get("a")?.dataUrl).toBe("drawn:a");
    expect(images.get("b")?.dataUrl).toBe("drawn:b");
    expect(findings.get("a")?.map((finding) => finding.kind)).toEqual(["email"]);
    expect(findings.get("b")).toEqual([]);
    expect(unchecked).toEqual([]);
    expect(missing).toEqual([]);
    expect(progress).toEqual({ brandId: AMLUTO_PROFILE.id, count: 2 });
  });

  it("marks a screenshot it couldn't read as not checked, and one it couldn't load as missing", async () => {
    const { preparation } = preparing({
      screens: { "m-a": "unavailable" },
      loadImage: (id) =>
        id === "m-b"
          ? Promise.reject(new Error("not synced"))
          : Promise.resolve(fakeScreenshot(id)),
    });
    await preparation.prepare([shot("a"), shot("b"), shot("c")], AMLUTO_PROFILE);
    const { images, findings, unchecked, missing, progress } = preparation.state;
    expect(unchecked).toEqual(["a"]);
    expect(findings.has("a")).toBe(false);
    expect(missing).toEqual(["b"]);
    expect(images.has("b")).toBe(false);
    expect(findings.get("c")).toEqual([]);
    // Every screenshot was tried, so the export isn't held up by the missing one.
    expect(progress.count).toBe(3);
  });

  it("is ready at once for a guide with no screenshots", async () => {
    const { preparation } = preparing();
    const block: GuideStep = { ...blankStep("x", { at: 0, by: "Robin" }), kind: "block" };
    await preparation.prepare([block], AMLUTO_PROFILE);
    expect(preparation.state.progress).toEqual({ brandId: AMLUTO_PROFILE.id, count: 0 });
  });

  it("prepares four screenshots at a time", async () => {
    let loading = 0;
    let most = 0;
    const { preparation } = preparing({
      loadImage: async (id) => {
        loading += 1;
        most = Math.max(most, loading);
        await new Promise((resolve) => setTimeout(resolve, 5));
        loading -= 1;
        return fakeScreenshot(id);
      },
    });
    await preparation.prepare(["a", "b", "c", "d", "e", "f", "g"].map(shot), AMLUTO_PROFILE);
    expect(most).toBe(4);
    expect(preparation.state.images.size).toBe(7);
  });

  it("tells the review each time a step is drawn or checked", async () => {
    const seen: number[] = [];
    const { preparation } = preparing();
    const stop = preparation.subscribe(() => seen.push(preparation.state.images.size));
    await preparation.prepare([shot("a"), shot("b")], AMLUTO_PROFILE);
    expect(seen).toContain(1);
    expect(seen.at(-1)).toBe(2);
    // A review that has closed hears no more.
    stop();
    const heard = seen.length;
    await preparation.refresh(shot("a"), AMLUTO_PROFILE);
    expect(seen.length).toBe(heard);
  });
});

describe("a brand change", () => {
  const client = { ...newBrandProfile("client", "Client", "#113355"), accent: "#225577" };

  it("redraws every screenshot in the new brand without loading or reading it again", async () => {
    const loads: string[] = [];
    const { preparation, reader } = preparing({
      screens: { "m-a": email },
      loadImage: (id) => {
        loads.push(id);
        return Promise.resolve(fakeScreenshot(id));
      },
    });
    const steps = [shot("a"), shot("b")];
    await preparation.prepare(steps, AMLUTO_PROFILE);
    const reads = reader.reads.length;
    vi.mocked(renderStepImage).mockClear();
    await preparation.prepare(steps, client);
    expect(vi.mocked(renderStepImage).mock.calls.map(([, , look]) => look.primary)).toEqual([
      "#113355",
      "#113355",
    ]);
    expect(loads).toEqual(["m-a", "m-b"]);
    expect(reader.reads.length).toBe(reads);
    // The first pass's findings stand.
    expect(preparation.state.findings.get("a")).toHaveLength(1);
    expect(preparation.state.progress).toEqual({ brandId: "client", count: 2 });
  });

  it("stops an earlier pass, which keeps nothing it draws afterwards", async () => {
    const { preparation } = preparing();
    const stop = new AbortController();
    const first = preparation.prepare([shot("a"), shot("b")], AMLUTO_PROFILE, stop.signal);
    stop.abort();
    await first;
    expect(preparation.state.images.size).toBe(0);
    expect(preparation.state.progress.brandId).toBe("");
    // It never finished, so the next pass is still the first: it checks the screenshots.
    await preparation.prepare([shot("a"), shot("b")], AMLUTO_PROFILE);
    expect(preparation.state.findings.size).toBe(2);
  });
});

describe("a step checked again (after a quick fix or an undo)", () => {
  it("redraws it and moves it into or out of the unchecked steps by how its reading went", async () => {
    const screens: Record<string, OcrLine[] | "unavailable"> = { "m-a": "unavailable" };
    const { preparation } = preparing({ screens });
    await preparation.prepare([shot("a"), shot("b")], AMLUTO_PROFILE);
    expect(preparation.state.unchecked).toEqual(["a"]);

    screens["m-a"] = email;
    vi.mocked(renderStepImage).mockClear();
    const fixed = { ...shot("a"), crop: { x: 0, y: 0, w: 50, h: 50, source: "manual" as const } };
    await preparation.refresh(fixed, AMLUTO_PROFILE);
    expect(vi.mocked(renderStepImage).mock.calls[0]?.[0]).toBe(fixed);
    expect(preparation.state.unchecked).toEqual([]);
    expect(preparation.state.findings.get("a")).toHaveLength(1);

    // A new blur means its words are read again; this time they can't be.
    screens["m-b"] = "unavailable";
    const blurred = {
      ...shot("b"),
      redactions: [{ x: 0, y: 0, w: 5, h: 5, source: "manual" as const }],
    };
    await preparation.refresh(blurred, AMLUTO_PROFILE);
    expect(preparation.state.unchecked).toEqual(["b"]);
  });

  it("keeps what it last showed when the screenshot can't be loaded now", async () => {
    let gone = false;
    const { preparation } = preparing({
      screens: { "m-a": email },
      loadImage: (id) =>
        gone ? Promise.reject(new Error("gone")) : Promise.resolve(fakeScreenshot(id)),
    });
    await preparation.prepare([shot("a")], AMLUTO_PROFILE);
    gone = true;
    await preparation.refresh({ ...shot("a"), redactions: [] }, AMLUTO_PROFILE);
    expect(preparation.state.images.get("a")?.dataUrl).toBe("drawn:a");
    expect(preparation.state.findings.get("a")).toHaveLength(1);
    expect(preparation.state.missing).toEqual([]);
  });
});

describe("Blur all", () => {
  it("hands every finding over to be blurred, clears them, and redraws those screenshots blurred", async () => {
    const { preparation, reader } = preparing({ screens: { "m-a": email } });
    const steps = [shot("a"), shot("b")];
    await preparation.prepare(steps, AMLUTO_PROFILE);
    const reads = reader.reads.length;
    const blur = vi.fn();
    vi.mocked(renderStepImage).mockClear();
    await preparation.blurAll(steps, AMLUTO_PROFILE, blur);

    expect(blur).toHaveBeenCalledTimes(1);
    expect(blur.mock.calls[0]?.[0]).toEqual([
      { stepId: "a", findings: [expect.objectContaining({ kind: "email" })] },
    ]);
    expect(preparation.state.findings.get("a")).toEqual([]);
    // Only the screenshot with something found is drawn again, now with the blur over it.
    const drawn = vi.mocked(renderStepImage).mock.calls.map(([step]) => step);
    expect(drawn.map((step) => step.id)).toEqual(["a"]);
    expect(drawn[0]?.redactions).toEqual([expect.objectContaining({ source: "suggested" })]);
    // The blur covers what was found, so nothing needs reading again.
    expect(reader.reads.length).toBe(reads);
  });

  it("does nothing when nothing was found", async () => {
    const { preparation } = preparing();
    await preparation.prepare([shot("a")], AMLUTO_PROFILE);
    const blur = vi.fn();
    await preparation.blurAll([shot("a")], AMLUTO_PROFILE, blur);
    expect(blur).not.toHaveBeenCalled();
  });
});

describe("the web page", () => {
  it("also draws each screenshot plain for its player, with the camera's view", async () => {
    const preparation = exportPreparation({
      loadImage: (id) => Promise.resolve(fakeScreenshot(id)),
      textReader: fakeTextReader({}),
      walkthrough: true,
      blurTerms: [],
      findings: { strength: "standard", safe: [] },
    });
    vi.mocked(renderStepImage).mockClear();
    await preparation.prepare([shot("a")], AMLUTO_PROFILE);
    const plain = vi.mocked(renderStepImage).mock.calls.find((call) => call[4] === false);
    expect(plain?.[3]).toBe("image/webp");
    expect(preparation.state.plainImages.get("a")).toMatchObject({ camera: null });
    expect(preparation.state.images.get("a")?.dataUrl).toBe("drawn:a");
  });
});
