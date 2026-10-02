// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import type { LibraryGuideSummary } from "../library-bridge";
import { ExportAndRemoveDialog } from "./ExportAndRemoveDialog";

initI18n();
afterEach(cleanup);

const guide = (id: string, title: string, updatedAt: string, sizeBytes: number) =>
  ({
    id,
    title,
    updatedAt,
    stepCount: 3,
    tags: [],
    owner: "Sam",
    reviewBy: null,
    thumbnailMediaId: null,
    sizeBytes,
  }) satisfies LibraryGuideSummary;

const guides = [
  guide("new", "Book a room", "2026-09-28T10:00:00.000Z", 2 * 1024 ** 2),
  guide("old", "Add a supplier", "2026-03-01T10:00:00.000Z", 300 * 1024 ** 2),
];

describe("Export and remove", () => {
  it("lists the least recently edited first and adds up what the chosen ones free", async () => {
    const onExport = vi.fn();
    const view = render(
      <ExportAndRemoveDialog
        guides={guides}
        progress={null}
        onCancel={vi.fn()}
        onExport={onExport}
      />,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual([
      expect.stringContaining("Add a supplier"),
      expect.stringContaining("Book a room"),
    ]);
    const exportButton = screen.getByRole("button", { name: /Export and remove/ });
    expect(exportButton).toHaveProperty("disabled", true);

    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    expect(screen.getByText("2 guides chosen, freeing 302 MB.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export and remove 2 guides" }));
    expect(onExport).toHaveBeenCalledWith(["old", "new"]);
    await expectNoSeriousAxeViolations(view.container);
  });

  it("can't be changed or closed while it works", () => {
    const onCancel = vi.fn();
    render(
      <ExportAndRemoveDialog
        guides={guides}
        progress={{ done: 1, total: 2 }}
        onCancel={onCancel}
        onExport={vi.fn()}
      />,
    );
    expect(screen.getByText("Exporting 2 of 2…")).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toHaveProperty("disabled", true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
