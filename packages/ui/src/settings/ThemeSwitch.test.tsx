// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import type { Theme } from "./preferences";
import { ThemeSwitch } from "./ThemeSwitch";

initI18n();
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

function Harness({ start, onTheme }: { start: Theme; onTheme: (theme: Theme) => void }) {
  const [theme, setTheme] = useState(start);
  return (
    <>
      <span id="theme-label">Theme</span>
      <ThemeSwitch
        labelledBy="theme-label"
        theme={theme}
        onTheme={(next) => {
          onTheme(next);
          setTheme(next);
        }}
      />
    </>
  );
}

describe("the light and dark switch", () => {
  it("is a switch named by its row, and turns the page dark and back", async () => {
    const onTheme = vi.fn();
    const view = render(<Harness start="light" onTheme={onTheme} />);
    const toggle = screen.getByRole("switch", { name: "Theme" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onTheme).toHaveBeenLastCalledWith("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onTheme).toHaveBeenLastCalledWith("light");
    await expectNoSeriousAxeViolations(view.container);
  });

  it("offers Match my device once a theme is picked, and says when it's following", () => {
    const onTheme = vi.fn();
    render(<Harness start="dark" onTheme={onTheme} />);
    fireEvent.click(screen.getByRole("button", { name: "Match my device" }));
    expect(onTheme).toHaveBeenLastCalledWith("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(screen.getByText("Following your device")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Match my device" })).toBeNull();
  });
});
