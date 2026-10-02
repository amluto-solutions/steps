// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { contrast, newBrandProfile } from "@amluto-steps/core";

import { appColourVariables, applyAppColours, APP_COLOUR_VARIABLES } from "./appColours";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

// A pale brand: the worst case for readable text.
const pale = { ...newBrandProfile("client", "Client", "#F4D35E"), accent: "#FFE066" };

describe("app colours from a brand", () => {
  it("keep text and lines readable in light and dark, whatever the brand's colours", () => {
    const light = appColourVariables(pale, "light");
    expect(contrast(light["--amluto-navy"] ?? "", "#FFFFFF")).toBeGreaterThanOrEqual(4.6);
    expect(contrast(light["--amluto-link"] ?? "", "#FFFFFF")).toBeGreaterThanOrEqual(4.6);
    expect(contrast(light["--amluto-blue"] ?? "", "#FFFFFF")).toBeGreaterThanOrEqual(3);
    expect(contrast(light["--amluto-sidebar"] ?? "", "#D7E1EE")).toBeGreaterThanOrEqual(4.6);
    const dark = appColourVariables({ ...pale, primary: "#0B1F3A" }, "dark");
    expect(contrast(dark["--amluto-navy"] ?? "", "#111C2E")).toBeGreaterThanOrEqual(4.6);
    expect(contrast(dark["--amluto-link"] ?? "", "#111C2E")).toBeGreaterThanOrEqual(4.6);
  });

  it("keep links readable on the selected tint and the sidebar's grey labels on the sidebar", () => {
    // Accents that came out at 4.03:1 and 3.89:1 on the selected tint when checked on white only.
    for (const accent of ["#0078D4", "#E4007C"]) {
      for (const mode of ["light", "dark"] as const) {
        const colours = appColourVariables({ ...pale, primary: "#1F6F43", accent }, mode);
        const selected = colours["--amluto-selected"] ?? "";
        expect(contrast(colours["--amluto-link"] ?? "", selected)).toBeGreaterThanOrEqual(4.6);
        expect(contrast(colours["--amluto-navy"] ?? "", selected)).toBeGreaterThanOrEqual(4.6);
        expect(contrast("#A9B8CC", colours["--amluto-sidebar"] ?? "")).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("use a brand's own dark colours, still checked", () => {
    const dark = appColourVariables({ ...pale, dark: { primary: "#223344" } }, "dark");
    // Too dark to read on the dark surface, so it is lightened, not used as it is.
    expect(dark["--amluto-navy"]).not.toBe("#223344");
    expect(contrast(dark["--amluto-navy"] ?? "", "#111C2E")).toBeGreaterThanOrEqual(4.6);
  });

  it("go on the page for the current mode, and come off for Amluto's own", () => {
    applyAppColours(pale);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--amluto-navy")).not.toBe("");
    document.documentElement.setAttribute("data-theme", "dark");
    applyAppColours(pale);
    expect(style.getPropertyValue("--amluto-navy")).toBe(
      appColourVariables(pale, "dark")["--amluto-navy"],
    );
    applyAppColours(null);
    for (const name of APP_COLOUR_VARIABLES) expect(style.getPropertyValue(name)).toBe("");
  });
});
