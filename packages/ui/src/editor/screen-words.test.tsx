// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideStep, OcrLine } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import { fakeScreenshot, fakeTextReader } from "../bridge/screen-words-fake";
import type { EditorDoc } from "./document";
import { blankStep } from "./edits";
import { GuideEditor } from "./GuideEditor";
import type { GuideStore } from "./useGuideEditor";

initI18n();
afterEach(cleanup);

const stamp = { at: Date.parse("2026-10-05T10:00:00.000Z"), by: "Robin" };
const shot = (id: string, sortKey: string): GuideStep => ({
  ...blankStep(id, stamp),
  kind: "interaction",
  action: "click",
  actionText: `Click ${id}`,
  sortKey,
  media: { id: `m-${id}`, width: 100, height: 100, scale: 1, captureRect: null },
});
const email: OcrLine[] = [{ words: [{ text: "jane@acme.com", x: 10, y: 10, w: 20, h: 3 }] }];

const doc: EditorDoc = {
  guide: {
    id: "g1",
    title: "Payroll run",
    description: "",
    intro: null,
    outro: null,
    brandProfileId: null,
    tags: [],
    owner: "Robin",
    reviewBy: null,
    createdAt: "2026-10-05T10:00:00.000Z",
    createdBy: "Robin",
    updatedAt: "2026-10-05T10:00:00.000Z",
    updatedBy: "Robin",
    formatVersion: 1,
  },
  steps: [shot("a", "0000000001"), shot("b", "0000000002"), shot("c", "0000000003")],
};

function show(
  screens: Record<string, OcrLine[] | "unavailable">,
  steps = doc.steps,
  more: Partial<GuideStore> = {},
) {
  const reader = fakeTextReader(screens);
  const notify = vi.fn();
  const store: GuideStore = {
    saveGuide: vi.fn().mockResolvedValue(undefined),
    saveStep: vi.fn().mockResolvedValue(undefined),
    deleteStep: vi.fn().mockResolvedValue(undefined),
    loadImage: (mediaId) => Promise.resolve(fakeScreenshot(mediaId)),
    ...more,
  };
  render(
    <GuideEditor
      initial={{ ...doc, steps }}
      store={store}
      author="Robin"
      mode="saved"
      busy={false}
      onBack={vi.fn()}
      exportMenu={() => []}
      notify={notify}
      blurTerms={[]}
      textReader={reader}
    />,
  );
  return { reader, notify };
}

describe("the editor's screen words", () => {
  it("suggests blurs from the selected step's screenshot words", async () => {
    show({ "m-a": email });
    expect(await screen.findByText("1 possible personal detail here (email).")).toBeTruthy();
  });

  it("suggests a notification toast on the screenshot even when its words can't be read (P35)", async () => {
    const plain = shot("a", "0000000001");
    const toasted: GuideStep = {
      ...plain,
      media: {
        id: "m-a",
        width: 100,
        height: 100,
        scale: 1,
        captureRect: null,
        notifications: [{ x: 80, y: 75, w: 19, h: 19 }],
      },
    };
    show({ "m-a": "unavailable" }, [toasted]);
    expect(await screen.findByText("1 possible personal detail here (notification).")).toBeTruthy();
  });

  it("suggests a notification toast a retake noted on its new picture (#96)", async () => {
    // Monitor mode: the recorder noted where a toast still showed on the retaken screenshot.
    const retakeImage = vi.fn().mockResolvedValue({
      id: "m-new",
      width: 100,
      height: 100,
      notifications: [{ x: 80, y: 75, w: 19, h: 19 }],
    });
    show({ "m-a": [], "m-new": "unavailable" }, [shot("a", "0000000001")], { retakeImage });
    fireEvent.click(await screen.findByRole("button", { name: "Retake" }));
    const dialog = await screen.findByRole("dialog", { name: "Retake this screenshot" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retake" }));
    expect(await screen.findByText("1 possible personal detail here (notification).")).toBeTruthy();
  });

  it("drops the old picture's toast when a retake shows none (#96)", async () => {
    const toasted: GuideStep = {
      ...shot("a", "0000000001"),
      media: {
        id: "m-a",
        width: 100,
        height: 100,
        scale: 1,
        captureRect: null,
        notifications: [{ x: 80, y: 75, w: 19, h: 19 }],
      },
    };
    const retakeImage = vi.fn().mockResolvedValue({ id: "m-new", width: 100, height: 100 });
    show({ "m-a": "unavailable", "m-new": [] }, [toasted], { retakeImage });
    await screen.findByText("1 possible personal detail here (notification).");
    fireEvent.click(screen.getByRole("button", { name: "Retake" }));
    const dialog = await screen.findByRole("dialog", { name: "Retake this screenshot" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retake" }));
    await waitFor(() =>
      expect(screen.queryByText("1 possible personal detail here (notification).")).toBeNull(),
    );
  });

  it("blurs a whole guide without reading a screenshot twice, and says which it couldn't read", async () => {
    const { reader, notify } = show({ "m-a": email, "m-b": email, "m-c": "unavailable" });
    await screen.findByText("1 possible personal detail here (email).");
    // Offered once the guide has been looked through, a second after it last changed.
    fireEvent.click(await screen.findByRole("button", { name: /Blur all/ }, { timeout: 3000 }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    const [{ text }] = notify.mock.calls[0] as [{ text: string }];
    expect(text).toContain("Blurred 2 personal details in 2 steps.");
    expect(text).toContain("1 screenshot couldn’t be read");
    // The selected step's screenshot was read once for its suggestions, and not again by Blur all
    // (only with its new blur, afterwards).
    const reads = reader.reads.filter((read) => read.mediaId === "m-a");
    expect(reads.map((read) => read.blurred.length)).toEqual([0, 1]);
  });

  it("offers Blur all only when there's something to blur", async () => {
    const { reader } = show({ "m-a": [], "m-b": [], "m-c": "unavailable" });
    await waitFor(() => expect(new Set(reader.reads.map((read) => read.mediaId)).size).toBe(3), {
      timeout: 3000,
    });
    // Give the answer a moment to land, then check the button never came.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: /Blur all/ })).toBeNull();
  });
});
