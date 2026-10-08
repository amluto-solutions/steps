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

/** The step on screen, by its row in the steps list. */
const current = () =>
  document.querySelector<HTMLElement>("[data-step-button][aria-current='step']")?.dataset
    .stepButton;

/** The steps' words, in order, by their "Move step: …" handles. */
const order = () =>
  screen
    .getAllByRole("button", { name: /^Move step: / })
    .map((button) => button.getAttribute("aria-label")?.replace("Move step: ", ""));

const press = (key: string, more: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document.body, { key, ...more });

function showFirst() {
  show();
  fireEvent.click(document.querySelector("[data-step-button='s1']") as HTMLElement);
  (document.activeElement as HTMLElement | null)?.blur();
}

describe("keys for the selected step, from anywhere in the editor", () => {
  it("go through the steps with the arrow keys", () => {
    showFirst();
    expect(current()).toBe("s1");
    press("ArrowDown");
    expect(current()).toBe("s2");
    press("ArrowRight");
    expect(current()).toBe("s3");
    press("ArrowDown");
    expect(current()).toBe("s3");
    press("ArrowLeft");
    press("ArrowUp");
    expect(current()).toBe("s1");
  });

  it("leave the arrows to text being typed", () => {
    showFirst();
    const field = screen
      .getAllByRole("textbox")
      .find((element) => element.tagName === "INPUT" || element.tagName === "TEXTAREA");
    if (!field) throw new Error("no text field");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(current()).toBe("s1");
  });

  it("delete one step after another with Delete", () => {
    showFirst();
    press("Delete");
    expect(order()).toEqual(["Choose the month", "Run it"]);
    expect(current()).toBe("s2");
    press("Delete");
    expect(order()).toEqual(["Run it"]);
  });

  it("open an empty note only on the step it was added to", () => {
    showFirst();
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    expect(screen.queryByRole("button", { name: "Add a note" })).toBeNull();
    press("ArrowDown");
    expect(current()).toBe("s2");
    // Not an empty note opened, and focused, on every step reached after.
    expect(screen.getByRole("button", { name: "Add a note" })).toBeDefined();
    press("Delete");
    expect(order()).toEqual(["Open payroll", "Run it"]);
  });

  it("run the step menu's shortcuts, which the menu shows", () => {
    showFirst();
    press("d", { ctrlKey: true });
    expect(order()).toEqual(["Open payroll", "Open payroll", "Choose the month", "Run it"]);
    press("ArrowDown", { altKey: true });
    expect(order()).toEqual(["Open payroll", "Open payroll", "Choose the month", "Run it"]);
    fireEvent.click(document.querySelector("[data-step-button='s3']") as HTMLElement);
    (document.activeElement as HTMLElement | null)?.blur();
    press("ArrowUp", { altKey: true });
    expect(order()).toEqual(["Open payroll", "Open payroll", "Run it", "Choose the month"]);
    press("Enter", { ctrlKey: true, shiftKey: true });
    expect(order()).toHaveLength(5);

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for step: Choose the month" }),
    );
    expect(screen.getByRole("menuitem", { name: /Duplicate/ }).textContent).toContain("Ctrl + D");
    expect(
      screen.getByRole("menuitem", { name: /Move up/ }).getAttribute("aria-keyshortcuts"),
    ).toBe("Alt+ArrowUp");
  });
});

describe("several steps picked at once, as in File Explorer", () => {
  const row = (id: string) => document.querySelector(`[data-step-button='${id}']`) as HTMLElement;
  const bar = () => screen.queryByRole("toolbar", { name: /steps selected/ });

  it("picks with Ctrl and Shift, and moves the picked steps together", () => {
    showFirst();
    fireEvent.click(row("s3"), { ctrlKey: true });
    expect(bar()?.getAttribute("aria-label")).toBe("2 steps selected");
    expect(current()).toBe("s3");
    (document.activeElement as HTMLElement | null)?.blur();
    // Each passes the step beside it that isn't moving; the last can't go further.
    press("ArrowDown", { altKey: true });
    expect(order()).toEqual(["Choose the month", "Open payroll", "Run it"]);
    press("ArrowUp", { altKey: true });
    expect(order()).toEqual(["Open payroll", "Run it", "Choose the month"]);

    // A plain click lets the others go.
    fireEvent.click(row("s2"));
    expect(bar()).toBeNull();
    fireEvent.click(row("s1"), { shiftKey: true });
    expect(bar()?.getAttribute("aria-label")).toBe("3 steps selected");
  });

  it("picks with Shift and the arrows, all with Ctrl + A, and lets go with Escape", () => {
    showFirst();
    press("ArrowDown", { shiftKey: true });
    expect(bar()?.getAttribute("aria-label")).toBe("2 steps selected");
    expect(current()).toBe("s2");
    press("Escape");
    expect(bar()).toBeNull();
    press("a", { ctrlKey: true });
    expect(bar()?.getAttribute("aria-label")).toBe("3 steps selected");
    press("d", { ctrlKey: true });
    expect(order()).toHaveLength(6);
    press("ArrowDown");
    expect(bar()).toBeNull();
  });

  it("deletes the picked steps together, from the keyboard or the bar", () => {
    showFirst();
    fireEvent.click(row("s2"), { shiftKey: true });
    (document.activeElement as HTMLElement | null)?.blur();
    press("Delete");
    expect(order()).toEqual(["Run it"]);
  });
});
