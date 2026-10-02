// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../i18n";
import { Sidebar } from "./Sidebar";

initI18n();
afterEach(cleanup);

const base = {
  libraries: [],
  libraryId: null,
  onLibrary: vi.fn(),
  view: { kind: "all" } as const,
  onView: vi.fn(),
  tags: [],
  guideCount: 0,
  reviewCount: 0,
  canRecord: false,
  recordHint: "A recording is running",
  onRecord: vi.fn(),
  onSettings: vi.fn(),
  settingsActive: false,
};

describe("the sidebar while recording (F002)", () => {
  it("offers Pause and Stop, then Resume once paused", () => {
    const onPause = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <Sidebar {...base} recordingControls={{ paused: false, onPause, onStop }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onPause).toHaveBeenCalled();
    expect(onStop).toHaveBeenCalled();
    rerender(<Sidebar {...base} recordingControls={{ paused: true, onPause, onStop }} />);
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });
});
