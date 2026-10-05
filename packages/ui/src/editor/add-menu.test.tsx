// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../i18n";
import type { EditorDoc } from "./document";
import { blankStep } from "./edits";
import { GuideEditor } from "./GuideEditor";
import type { GuideStore } from "./useGuideEditor";

initI18n();
afterEach(cleanup);

const stamp = { at: Date.parse("2026-10-05T10:00:00.000Z"), by: "Robin" };
const step = (id: string, sortKey: string, actionText: string) => ({
  ...blankStep(id, stamp),
  sortKey,
  actionText,
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
    createdAt: "2026-10-05T10:00:00.000Z",
    createdBy: "Robin",
    updatedAt: "2026-10-05T10:00:00.000Z",
    updatedBy: "Robin",
    formatVersion: 1,
  },
  steps: [
    step("s1", "0000000001", "Open payroll"),
    step("s2", "0000000002", "Choose the month"),
    step("s3", "0000000003", "Run it"),
  ],
};

const store: GuideStore = {
  saveGuide: vi.fn().mockResolvedValue(undefined),
  saveStep: vi.fn().mockResolvedValue(undefined),
  deleteStep: vi.fn().mockResolvedValue(undefined),
  loadImage: vi.fn().mockRejectedValue(new Error("no images here")),
};

function show() {
  render(
    <GuideEditor
      initial={doc}
      store={store}
      author="Robin"
      mode="saved"
      busy={false}
      onBack={vi.fn()}
      exportMenu={() => []}
      notify={vi.fn()}
      blurTerms={[]}
    />,
  );
}

/** The step list's rows, by their "Move step: …" handles. */
const order = () =>
  screen
    .getAllByRole("button", { name: /^Move step: / })
    .map((button) => button.getAttribute("aria-label")?.replace("Move step: ", ""));

function addHeading() {
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Section heading/ }));
}

describe("the Add menu", () => {
  it("puts a section heading straight after the selected step", () => {
    show();
    const row = screen
      .getAllByRole("button", { name: /Choose the month/ })
      .find((button) => !/^(Move step|More actions)/.test(button.getAttribute("aria-label") ?? ""));
    if (row) fireEvent.click(row);
    addHeading();
    expect(order()).toEqual(["Open payroll", "Choose the month", "Section heading", "Run it"]);
  });

  it("puts it first with the guide details selected", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Guide details/ }));
    addHeading();
    expect(order()[0]).toBe("Section heading");
  });
});
