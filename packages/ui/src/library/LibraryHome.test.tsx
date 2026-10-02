// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import type { GuideSearchHit, LibraryGuideSummary } from "../library-bridge";
import { LibraryHome } from "./LibraryHome";

initI18n();
afterEach(cleanup);

const guide = (id: string, title: string): LibraryGuideSummary => ({
  id,
  title,
  updatedAt: "2026-09-20T10:00:00.000Z",
  stepCount: 3,
  tags: ["Finance"],
  owner: "Sam",
  reviewBy: null,
  thumbnailMediaId: null,
});

function show(
  searchGuides?: (query: string) => Promise<GuideSearchHit[]>,
  storage?: Pick<Parameters<typeof LibraryHome>[0], "storage" | "onExportAndRemove">,
) {
  return render(
    <LibraryHome
      heading="All guides"
      guides={[guide("g1", "Add a supplier"), guide("g2", "Book a room")]}
      loading={false}
      pending={[]}
      busy={false}
      onOpen={vi.fn()}
      onReviewPending={vi.fn()}
      onDiscardPending={vi.fn()}
      guideMenu={() => []}
      exportMenu={() => []}
      loadThumbnail={() => Promise.reject(new Error("none"))}
      onNewRecording={vi.fn()}
      onImport={vi.fn()}
      searchGuides={searchGuides}
      {...storage}
    />,
  );
}

const search = (text: string) =>
  fireEvent.change(screen.getByRole("searchbox", { name: "Search guides" }), {
    target: { value: text },
  });

describe("searching the library", () => {
  it("finds a guide by its step wording and says which step", async () => {
    const searchGuides = vi
      .fn()
      .mockResolvedValue([
        { guideId: "g2", foundIn: { stepNumber: 4, snippet: "Click Save invoice" } },
      ]);
    const view = show(searchGuides);
    search("invoice");
    // The cards alone don't match, so nothing shows until the wording has been searched.
    expect(screen.getByText("No guides match your search.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Step 4: Click Save invoice")).toBeTruthy());
    expect(searchGuides).toHaveBeenCalledWith("invoice");
    expect(screen.queryByRole("button", { name: "Open Add a supplier" })).toBeNull();
    expect(screen.getByRole("button", { name: /Open Book a room/ })).toBeTruthy();
    await expectNoSeriousAxeViolations(view.container);
  });

  it("filters the cards at once and waits for typing to pause before searching", async () => {
    const searchGuides = vi.fn().mockResolvedValue([]);
    show(searchGuides);
    search("s");
    search("su");
    search("supplier");
    expect(screen.getByRole("button", { name: /Open Add a supplier/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open Book a room/ })).toBeNull();
    await waitFor(() => expect(searchGuides).toHaveBeenCalledTimes(1));
    expect(searchGuides).toHaveBeenCalledWith("supplier");
  });

  it("ignores an answer for a query that has since changed", async () => {
    let answer: (hits: GuideSearchHit[]) => void = () => undefined;
    const searchGuides = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GuideSearchHit[]>((resolve) => {
            answer = resolve;
          }),
      )
      .mockResolvedValue([]);
    show(searchGuides);
    search("invoice");
    await waitFor(() => expect(searchGuides).toHaveBeenCalledTimes(1));
    search("room");
    answer([{ guideId: "g1", foundIn: { stepNumber: 1, snippet: "Old answer" } }]);
    await waitFor(() => expect(searchGuides).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Old answer/)).toBeNull();
    expect(screen.getByRole("button", { name: /Open Book a room/ })).toBeTruthy();
  });

  it("searches only the cards when the wording can't be searched", () => {
    show();
    search("finance sam");
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(2);
  });
});

describe("focus in the library", () => {
  it("moves to the next card when the focused one goes, instead of the page", async () => {
    const props = {
      heading: "All guides",
      loading: false,
      pending: [],
      busy: false,
      onOpen: vi.fn(),
      onReviewPending: vi.fn(),
      onDiscardPending: vi.fn(),
      guideMenu: () => [],
      exportMenu: () => [],
      loadThumbnail: () => Promise.reject(new Error("none")),
      onNewRecording: vi.fn(),
      onImport: vi.fn(),
    };
    const first = guide("g1", "Add a supplier");
    const second = guide("g2", "Book a room");
    const view = render(<LibraryHome {...props} guides={[first, second]} />);
    screen.getByRole("button", { name: "More actions for Add a supplier" }).focus();
    // Moved to the Bin: the card and its focused button go.
    view.rerender(<LibraryHome {...props} guides={[second]} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Book a room" })),
    );
    // The last one goes too: the heading takes focus.
    view.rerender(<LibraryHome {...props} guides={[]} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "All guides" })),
    );
  });
});

describe("browser storage", () => {
  it("offers Export and remove once the library is large", async () => {
    const onExportAndRemove = vi.fn();
    const use = { libraryBytes: 1.5 * 1024 ** 3, usedBytes: null, quotaBytes: null };
    const view = show(undefined, { storage: { warning: "large", use }, onExportAndRemove });
    expect(screen.getByRole("status").textContent).toContain(
      "Your guides take 1.5 GB of browser storage",
    );
    fireEvent.click(screen.getByRole("button", { name: "Export and remove…" }));
    expect(onExportAndRemove).toHaveBeenCalled();
    await expectNoSeriousAxeViolations(view.container);
  });

  it("says nothing when there's no reason to", () => {
    show(undefined, { storage: null, onExportAndRemove: vi.fn() });
    expect(screen.queryByRole("button", { name: "Export and remove…" })).toBeNull();
  });
});

describe("selecting several guides", () => {
  const guides = [
    guide("g1", "Add a supplier"),
    guide("g2", "Book a room"),
    guide("g3", "Claim expenses"),
  ];
  function showBulk() {
    const bulk = {
      targets: [{ id: "lib-2", name: "Finance team" }],
      onMove: vi.fn(),
      onCopy: vi.fn(),
      onTrash: vi.fn(),
      onMerge: vi.fn(),
      exportMenu: vi.fn(() => []),
    };
    const onOpen = vi.fn();
    render(
      <LibraryHome
        heading="All guides"
        guides={guides}
        loading={false}
        pending={[]}
        busy={false}
        onOpen={onOpen}
        onReviewPending={vi.fn()}
        onDiscardPending={vi.fn()}
        guideMenu={() => []}
        exportMenu={() => []}
        loadThumbnail={() => Promise.reject(new Error("none"))}
        onNewRecording={vi.fn()}
        onImport={vi.fn()}
        bulk={bulk}
      />,
    );
    return { bulk, onOpen };
  }
  const box = (title: string) => screen.getByRole("checkbox", { name: `Select ${title}` });
  const titles = (list: { title: string }[]) => list.map((item) => item.title);

  it("ticks guides with their boxes, Ctrl-click and Shift-click, and acts on them all", () => {
    const { bulk, onOpen } = showBulk();
    expect(screen.queryByRole("region", { name: "Guides selected" })).toBeNull();
    fireEvent.click(box("Add a supplier"));
    const bar = screen.getByRole("region", { name: "Guides selected" });
    expect(bar.textContent).toContain("1 selected");
    // Merge needs two.
    expect((screen.getByRole("button", { name: "Merge…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // While selecting, a card's click ticks it rather than opening it; Shift-click takes a range.
    fireEvent.click(screen.getByRole("button", { name: "Select Claim expenses" }), {
      shiftKey: true,
    });
    expect(bar.textContent).toContain("3 selected");
    fireEvent.click(screen.getByRole("button", { name: "Select Book a room" }));
    expect(bar.textContent).toContain("2 selected");
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
    expect(titles(bulk.onMerge.mock.calls[0]?.[0] ?? [])).toEqual([
      "Add a supplier",
      "Claim expenses",
    ]);
    // Acting starts afresh.
    expect(screen.queryByRole("region", { name: "Guides selected" })).toBeNull();
  });

  it("selects every guide with Ctrl+A and clears them with Escape; Select shows the boxes", async () => {
    const { bulk, onOpen } = showBulk();
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    expect(screen.getByRole("region", { name: "Guides selected" }).textContent).toContain(
      "3 selected",
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Guides selected" })).toBeNull();
    // Without a selection a click opens the guide, and Ctrl-click ticks it.
    fireEvent.click(screen.getByRole("button", { name: "Open Book a room" }));
    expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Open Add a supplier" }), { ctrlKey: true });
    expect(box("Add a supplier")).toHaveProperty("checked", true);

    fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Finance team" }));
    expect(bulk.onMove).toHaveBeenCalledWith([guides[0]], "lib-2");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Book a room" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Bin" }));
    expect(bulk.onTrash).toHaveBeenCalledWith([guides[1]]);
  });

  it("has no serious accessibility problems while selecting", async () => {
    showBulk();
    fireEvent.click(box("Add a supplier"));
    await expectNoSeriousAxeViolations(document.body);
  });
});
