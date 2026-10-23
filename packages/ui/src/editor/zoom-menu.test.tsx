// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideStep } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import type { EditorDoc } from "./document";
import { blankStep } from "./edits";
import { GuideEditor } from "./GuideEditor";
import type { GuideStore } from "./useGuideEditor";

initI18n();
afterEach(cleanup);

const stamp = { at: Date.parse("2026-10-12T10:00:00.000Z"), by: "Robin" };
/** A whole 1920×1080 monitor, clicked near the middle. */
const fullHd = (id: string, sortKey: string): GuideStep => ({
  ...blankStep(id, stamp),
  kind: "interaction",
  action: "click",
  actionText: `Click ${id}`,
  sortKey,
  media: { id: `m-${id}`, width: 1920, height: 1080, scale: 1, captureRect: null },
  highlight: { shape: "circle", x: 50, y: 50, w: 2, h: 3.5 },
});

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
    createdAt: "2026-10-12T10:00:00.000Z",
    createdBy: "Robin",
    updatedAt: "2026-10-12T10:00:00.000Z",
    updatedBy: "Robin",
    formatVersion: 1,
  },
  steps: [fullHd("a", "0000000001"), fullHd("b", "0000000002")],
};

function show() {
  const notify = vi.fn();
  const store: GuideStore = {
    saveGuide: vi.fn().mockResolvedValue(undefined),
    saveStep: vi.fn().mockResolvedValue(undefined),
    deleteStep: vi.fn().mockResolvedValue(undefined),
    loadImage: () => Promise.resolve(""),
  };
  render(
    <GuideEditor
      initial={doc}
      store={store}
      author="Robin"
      mode="saved"
      busy={false}
      onBack={vi.fn()}
      exportMenu={() => []}
      notify={notify}
      blurTerms={[]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
  return { notify };
}

describe("Zoom in on each click (#87)", () => {
  it("says what it does, rather than that full-screen shots read well", () => {
    show();
    const entry = screen.getByRole("menuitem", { name: /Zoom in on each click/ });
    expect(entry.textContent).toContain(
      "Crops screenshots wider than 2000 pixels to the area around the click, for bigger text on the page",
    );
  });

  it("says which screenshots it crops when a guide's full-HD shots are left whole", () => {
    const { notify } = show();
    fireEvent.click(screen.getByRole("menuitem", { name: /Zoom in on each click/ }));
    expect(notify).toHaveBeenCalledWith({
      text: "Nothing to zoom: it only crops screenshots wider than 2000 pixels that have a click and no crop yet.",
    });
  });
});
