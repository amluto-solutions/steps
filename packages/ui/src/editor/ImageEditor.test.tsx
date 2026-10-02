// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideStep } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import { blankStep } from "./edits";
import { describeSelected, ImageEditor, type ImageTool } from "./ImageEditor";
import i18next from "i18next";

initI18n();
afterEach(cleanup);

const step = (patch: Partial<GuideStep> = {}): GuideStep => ({
  ...blankStep("s1", { at: 0, by: "Robin" }),
  kind: "interaction",
  action: "click",
  actionText: "Click Save",
  media: { id: "m1", width: 1600, height: 1000, scale: 1, captureRect: null },
  ...patch,
});

function editor(tool: ImageTool, current = step()) {
  const onCommit = vi.fn();
  const onToolChange = vi.fn();
  render(
    <ImageEditor
      step={current}
      imageUrl="data:image/png;base64,AAAA"
      tool={tool}
      onToolChange={onToolChange}
      onCommit={onCommit}
    />,
  );
  return { onCommit, onToolChange, surface: screen.getByRole("application") };
}

describe("the image editor without a mouse", () => {
  it("adds each tool's mark with Enter, in the middle, and goes back to selecting", () => {
    for (const tool of ["blur", "box", "arrow", "crop"] as const) {
      const { onCommit, onToolChange, surface } = editor(tool);
      fireEvent.keyDown(surface, { key: "Enter" });
      expect(onCommit).toHaveBeenCalledTimes(1);
      const [geometry] = onCommit.mock.calls[0] as [
        { redactions: unknown[]; annotations: { type: string }[]; crop: unknown },
      ];
      if (tool === "blur") expect(geometry.redactions).toHaveLength(1);
      if (tool === "box") expect(geometry.annotations[0]?.type).toBe("box");
      if (tool === "arrow") expect(geometry.annotations[0]?.type).toBe("arrow");
      if (tool === "crop") expect(geometry.crop).not.toBeNull();
      expect(onToolChange).toHaveBeenCalledWith("select");
      cleanup();
    }
    // The label tool opens the label box instead.
    const { onCommit, surface } = editor("text");
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Label text" })).toBeTruthy();
  });

  it("adds a box with a single click, centred on it, so nothing needs dragging", () => {
    const { onCommit, onToolChange, surface } = editor("box");
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 }) as DOMRect;
    surface.setPointerCapture = vi.fn();
    fireEvent.pointerDown(surface, { button: 0, clientX: 700, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 700, clientY: 250, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [geometry] = onCommit.mock.calls[0] as [
      { annotations: { type: string; x: number; y: number; w: number; h: number }[] },
    ];
    expect(geometry.annotations).toEqual([{ type: "box", x: 60, y: 44, w: 20, h: 12 }]);
    expect(onToolChange).toHaveBeenCalledWith("select");
  });

  it("applies a typed size on Enter without losing focus, and never below 1%", () => {
    const blurred = step({ redactions: [{ x: 10, y: 10, w: 20, h: 10, source: "manual" }] });
    const { onCommit, surface } = editor("select", blurred);
    fireEvent.keyDown(surface, { key: "PageDown" });
    const width = screen.getByRole("spinbutton", { name: "Width %" }) as HTMLInputElement;
    width.focus();
    fireEvent.change(width, { target: { value: "30" } });
    fireEvent.keyDown(width, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(width);
    fireEvent.change(width, { target: { value: "0" } });
    fireEvent.keyDown(width, { key: "Enter" });
    const [last] = onCommit.mock.calls.at(-1) as [{ redactions: { w: number }[] }];
    expect(last.redactions[0]?.w).toBe(1);
  });
});

describe("mark colours", () => {
  it("offers the brand colour and five more for an arrow, box or label, and none for a blur", () => {
    const marked = step({
      annotations: [{ type: "box", x: 10, y: 10, w: 20, h: 10 }],
      redactions: [{ x: 50, y: 50, w: 10, h: 10, source: "manual" }],
    });
    const { onCommit, surface } = editor("select", marked);
    fireEvent.keyDown(surface, { key: "PageDown" });
    // Whichever mark came first, go on to the box.
    if (!screen.queryByRole("button", { name: "Red" }))
      fireEvent.keyDown(surface, { key: "PageDown" });
    expect(screen.getByRole("button", { name: "Brand colour" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    const [geometry] = onCommit.mock.calls.at(-1) as [{ annotations: { colour?: string }[] }];
    expect(geometry.annotations[0]?.colour).toBe("red");
    cleanup();

    // Back to the brand colour: stored as no colour at all.
    const red = step({ annotations: [{ type: "box", x: 10, y: 10, w: 20, h: 10, colour: "red" }] });
    const second = editor("select", red);
    fireEvent.keyDown(second.surface, { key: "PageDown" });
    fireEvent.click(screen.getByRole("button", { name: "Brand colour" }));
    const [back] = second.onCommit.mock.calls.at(-1) as [{ annotations: object[] }];
    expect(back.annotations[0]).not.toHaveProperty("colour");
    cleanup();

    const blurOnly = step({ redactions: [{ x: 50, y: 50, w: 10, h: 10, source: "manual" }] });
    const third = editor("select", blurOnly);
    fireEvent.keyDown(third.surface, { key: "PageDown" });
    expect(screen.queryByRole("button", { name: "Red" })).toBeNull();
  });
});

describe("the image editor with a mouse", () => {
  // jsdom can't hit-test, so these check the pointer rules the browser follows (found in the
  // live smoke test: the crop's inside hid the circle under it, and the circle only took its ring).
  it("shows an applied crop as the picture, and the whole picture again while editing it", () => {
    const cropped = step({
      highlight: { shape: "circle", x: 40, y: 40, w: 5, h: 5 },
      crop: { x: 10, y: 10, w: 80, h: 80, source: "manual" },
    });
    const { surface } = editor("select", cropped);
    const svg = surface.querySelector("svg");
    const pointer = (element: Element | null | undefined) =>
      (element as SVGElement | null)?.style.pointerEvents;
    // The highlight can be picked up anywhere inside, not only by its ring.
    expect(pointer(svg?.querySelector("ellipse"))).toBe("all");
    // Applied: no crop frame on the picture, and Edit crop to change it.
    expect(svg?.querySelector("rect[stroke-dasharray]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit crop" }));
    // Editing: the whole screenshot with the frame, which can be dragged by its inside, and Apply.
    expect(pointer(svg?.querySelector("rect[stroke-dasharray]"))).toBe("all");
    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));
    expect(svg?.querySelector("rect[stroke-dasharray]")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit crop" })).toBeTruthy();
  });
});

describe("the selected mark, for screen readers", () => {
  it("says which mark and where, in whole percentages", () => {
    const geometry = {
      highlight: null,
      annotations: [
        {
          type: "arrow" as const,
          from: [10, 20] as [number, number],
          to: [30.4, 40.6] as [number, number],
        },
        { type: "box" as const, x: 40, y: 44.2, w: 20, h: 12 },
      ],
      redactions: [],
      crop: null,
    };
    const t = i18next.t.bind(i18next);
    expect(describeSelected(geometry, { kind: "annotation", index: 1 }, t)).toBe(
      "Box 2 of 2: left 40%, top 44%, 20% wide, 12% high",
    );
    expect(describeSelected(geometry, { kind: "annotation", index: 0 }, t)).toBe(
      "Arrow 1 of 2: from 10%, 20% to 30%, 41%",
    );
    expect(describeSelected(geometry, null, t)).toBeNull();
  });
});
