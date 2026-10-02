// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModalDialog } from "./ModalDialog";

afterEach(cleanup);

function Harness({ onEscape }: { onEscape?: () => void }) {
  const [open, setOpen] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Discard recording
      </button>
      <button type="button">Behind the dialog</button>
      {open && (
        <ModalDialog
          role="alertdialog"
          labelledBy="title"
          initialFocus={keepRef}
          onEscape={() => {
            onEscape?.();
            setOpen(false);
          }}
        >
          <h2 id="title">Discard this recording?</h2>
          <button ref={keepRef} type="button" onClick={() => setOpen(false)}>
            Keep recording
          </button>
          <button type="button">Discard</button>
        </ModalDialog>
      )}
    </>
  );
}

describe("ModalDialog", () => {
  it("opens on the safe choice, keeps focus inside, and closes on Escape back to its opener", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    const opener = screen.getByRole("button", { name: "Discard recording" });
    opener.focus();
    fireEvent.click(opener);

    const keep = screen.getByRole("button", { name: "Keep recording" });
    expect(document.activeElement).toBe(keep);
    expect(screen.getByRole("alertdialog", { name: "Discard this recording?" })).toBeDefined();

    // Focus that wanders to the page behind is brought back.
    screen.getByRole("button", { name: "Behind the dialog" }).focus();
    expect(document.activeElement).toBe(keep);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("ignores Escape when the dialog needs an explicit choice", () => {
    render(
      <ModalDialog labelledBy="choice">
        <h2 id="choice">Include what you type?</h2>
        <button type="button">Continue</button>
      </ModalDialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Include what you type?" })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
  });

  it("gives Ctrl+Z and Ctrl+Y to a dialog that changes the guide, only the one on top", () => {
    const outerUndo = vi.fn();
    const innerUndo = vi.fn();
    const innerRedo = vi.fn();
    // As in the app: the quick fix opens inside the export review.
    render(
      <ModalDialog labelledBy="outer" onUndo={outerUndo}>
        <h2 id="outer">Check before exporting</h2>
        <button type="button">Blur all</button>
        <ModalDialog labelledBy="inner" onUndo={innerUndo} onRedo={innerRedo}>
          <h2 id="inner">Step 1</h2>
          <button type="button">Blur</button>
        </ModalDialog>
      </ModalDialog>,
    );
    fireEvent.keyDown(document.activeElement ?? document, { key: "z", ctrlKey: true });
    fireEvent.keyDown(document.activeElement ?? document, { key: "y", ctrlKey: true });
    fireEvent.keyDown(document.activeElement ?? document, {
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(innerUndo).toHaveBeenCalledTimes(1);
    expect(innerRedo).toHaveBeenCalledTimes(2);
    expect(outerUndo).not.toHaveBeenCalled();
  });
});
