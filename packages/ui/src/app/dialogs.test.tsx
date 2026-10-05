// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../i18n";
import { StartRecordingDialog } from "./dialogs";

initI18n();
afterEach(cleanup);

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("StartRecordingDialog", () => {
  it("starts with both boxes unticked unless told otherwise", () => {
    const onStart = vi.fn();
    render(
      <StartRecordingDialog
        defaults={{ keys: false, output: false }}
        onCancel={vi.fn()}
        onStart={onStart}
      />,
    );
    expect(box("Record what's typed").checked).toBe(false);
    expect(box("Include command output").checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(onStart).toHaveBeenCalledWith({ keys: false, output: false });
  });

  it("starts ticked when Settings or IT says so, and can still be unticked (30/09/2026)", () => {
    const onStart = vi.fn();
    render(
      <StartRecordingDialog
        defaults={{ keys: true, output: true }}
        onCancel={vi.fn()}
        onStart={onStart}
      />,
    );
    expect(box("Record what's typed").checked).toBe(true);
    expect(box("Include command output").checked).toBe(true);
    fireEvent.click(box("Record what's typed"));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(onStart).toHaveBeenCalledWith({ keys: false, output: false });
  });

  it("never starts output ticked without what's typed", () => {
    render(
      <StartRecordingDialog
        defaults={{ keys: false, output: true }}
        onCancel={vi.fn()}
        onStart={vi.fn()}
      />,
    );
    expect(box("Include command output").checked).toBe(false);
  });

  it("ticks the output too when what's typed is ticked, and it can be unticked (04/10/2026)", () => {
    const onStart = vi.fn();
    render(
      <StartRecordingDialog
        defaults={{ keys: false, output: false }}
        onCancel={vi.fn()}
        onStart={onStart}
      />,
    );
    fireEvent.click(box("Record what's typed"));
    expect(box("Include command output").checked).toBe(true);
    fireEvent.click(box("Include command output"));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(onStart).toHaveBeenCalledWith({ keys: true, output: false });
  });
});
