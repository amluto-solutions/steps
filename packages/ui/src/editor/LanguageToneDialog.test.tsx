// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGuide, parseStep, type GuideStep } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import type { EditorDoc } from "./document";
import { LanguageToneDialog } from "./LanguageToneDialog";

initI18n();
afterEach(cleanup);

const step = (id: string, target: string): GuideStep =>
  parseStep({
    id,
    sortKey: id,
    kind: "interaction",
    action: "click",
    actionText: `Click "${target}"`,
    textParts: { verb: "click", target, kind: "button" },
    showValue: false,
    context: { app: null, windowTitle: "Suppliers" },
    target: { tagName: "BUTTON", innerText: target },
    media: null,
    highlight: null,
    capturedAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    formatVersion: 1,
  });

/** A merged guide's heading: a header block, which the steps list doesn't number or count. */
const heading = (id: string, title: string): GuideStep =>
  parseStep({
    id,
    sortKey: id,
    kind: "block",
    action: "block",
    actionText: "",
    textParts: { verb: "", target: "", kind: "block" },
    showValue: false,
    context: { app: null, windowTitle: "" },
    target: null,
    media: null,
    highlight: null,
    block: { type: "header", heading: title, body: null },
    capturedAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    formatVersion: 1,
  });

const merged = (): EditorDoc => ({
  guide: parseGuide({
    id: "g1",
    title: "Set up a supplier",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    formatVersion: 1,
  }),
  steps: [
    heading("h1", "Add a supplier"),
    step("a", "New"),
    step("b", "Save"),
    heading("h2", "Pay a supplier"),
    step("c", "Pay"),
  ],
});

describe("Language and tone", () => {
  it("counts and numbers the steps as the steps list does, leaving out a merged guide's headings (#84)", () => {
    render(<LanguageToneDialog doc={merged()} busy={false} onCancel={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "3 steps" })).toBeTruthy();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(screen.getByRole("checkbox", { name: "Reword step 3" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Reword step 4" })).toBeNull();
    expect(rows[2]?.textContent).toContain('Click "Pay"');
  });
});
