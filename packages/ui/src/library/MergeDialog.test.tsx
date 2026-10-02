// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import type { LibraryGuideSummary, LibraryInfo } from "../library-bridge";
import { MergeDialog } from "./MergeDialog";

initI18n();
afterEach(cleanup);

const guide = (id: string, title: string, stepCount = 3): LibraryGuideSummary => ({
  id,
  title,
  updatedAt: "2026-09-20T10:00:00.000Z",
  stepCount,
  tags: [],
  owner: "Sam",
  reviewBy: null,
  thumbnailMediaId: null,
});

const library = (id: string, name: string): LibraryInfo => ({
  id,
  name,
  path: name,
  isDefault: id === "mine",
  managed: false,
  synced: id !== "mine",
  guideCount: 2,
});

const guides: Record<string, LibraryGuideSummary[]> = {
  mine: [guide("g1", "Set up Outlook", 9), guide("g2", "Map the S: drive", 7)],
  team: [guide("t1", "Join the IT Teams channel", 6)],
};

function show() {
  const onMerge = vi.fn();
  render(
    <MergeDialog
      libraries={[library("mine", "My guides"), library("team", "IT team")]}
      libraryId="mine"
      initial={[{ libraryId: "mine", guide: guides.mine?.[0] ?? guide("x", "x") }]}
      listGuides={(id) => Promise.resolve(guides[id] ?? [])}
      busy={false}
      onCancel={vi.fn()}
      onMerge={onMerge}
    />,
  );
  return onMerge;
}

describe("the Merge guides dialog", () => {
  it("takes guides from more than one library, in the order set, into the library chosen", async () => {
    const onMerge = show();
    const dialog = screen.getByRole("dialog", { name: "Merge guides" });
    const merge = () => within(dialog).getByRole("button", { name: /^Merge/ }) as HTMLButtonElement;
    // One guide isn't enough.
    expect(merge().disabled).toBe(true);
    expect(within(dialog).getByRole("status").textContent).toBe("Choose at least two guides.");

    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Map the S: drive/ }));
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Library" }), {
      target: { value: "team" },
    });
    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: /Join the IT Teams channel/ }),
    );
    // The Teams guide goes second.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Move Join the IT Teams channel up" }),
    );
    const order = within(dialog).getByRole("list");
    expect(
      within(order)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Set up Outlook"),
      expect.stringContaining("Join the IT Teams channel"),
      expect.stringContaining("Map the S: drive"),
    ]);
    expect(within(dialog).getByRole("status").textContent).toBe("3 guides · 22 steps");
    // Not the first guide's title as it is: two cards would share it.
    expect(
      (within(dialog).getByRole("textbox", { name: "Title of the new guide" }) as HTMLInputElement)
        .value,
    ).toMatch(/ \(merged\)$/);

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title of the new guide" }), {
      target: { value: "  New starter  " },
    });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Save to" }), {
      target: { value: "team" },
    });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /Move the originals to the Bin/ }),
    );
    fireEvent.click(merge());
    expect(onMerge).toHaveBeenCalledWith({
      parts: [
        { libraryId: "mine", guide: guides.mine?.[0] },
        { libraryId: "team", guide: guides.team?.[0] },
        { libraryId: "mine", guide: guides.mine?.[1] },
      ],
      title: "New starter",
      libraryId: "team",
      headings: true,
      binOriginals: true,
    });
  });

  it("needs a title, and can take a guide out again", async () => {
    const onMerge = show();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Map the S: drive/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title of the new guide" }), {
      target: { value: "   " },
    });
    const merge = within(dialog).getByRole("button", {
      name: "Merge 2 guides",
    }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Take Map the S: drive out" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("status").textContent).toBe("Choose at least two guides."),
    );
    expect(onMerge).not.toHaveBeenCalled();
  });

  it("has no serious accessibility problems", async () => {
    show();
    await screen.findByRole("checkbox", { name: /Map the S: drive/ });
    await expectNoSeriousAxeViolations(document.body);
  });
});
