// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../i18n";
import { Toast } from "./Toast";

initI18n();
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the toast", () => {
  it("closes after 8 seconds, but not while the pointer or the keyboard is on it", () => {
    const onClose = vi.fn();
    render(
      <Toast
        toast={{ id: 1, text: "Step deleted", action: { label: "Undo", run: vi.fn() } }}
        onClose={onClose}
      />,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    const box = undo.parentElement as HTMLElement;
    fireEvent.mouseEnter(box);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(onClose).not.toHaveBeenCalled();
    // The keyboard reaches Undo, then the pointer leaves: still paused.
    fireEvent.focusIn(undo);
    fireEvent.mouseLeave(box);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.focusOut(undo);
    act(() => void vi.advanceTimersByTime(7_900));
    expect(onClose).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps an error until it's closed", () => {
    const onClose = vi.fn();
    render(<Toast toast={{ id: 1, kind: "error", text: "Couldn't save" }} onClose={onClose} />);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn't save")).toBeTruthy();
  });
});
