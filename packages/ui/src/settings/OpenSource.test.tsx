// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import type { RecorderBridge } from "../recorder-bridge";
import attributions from "./attributions.json";
import { licenceKey, licenceSummary, OpenSource, type Attribution } from "./OpenSource";

initI18n();
afterEach(cleanup);

const component = (name: string, licence: string): Attribution => ({
  ecosystem: "cargo",
  name,
  version: "1.0.0",
  licence,
});

describe("open-source components in Settings > About", () => {
  it("counts the same choice of licences once, however it's written", () => {
    expect(licenceKey("MIT/Apache-2.0")).toBe(licenceKey("Apache-2.0 OR MIT"));
    const { top, others } = licenceSummary(
      [
        component("a", "MIT"),
        component("b", "MIT"),
        component("c", "MIT OR Apache-2.0"),
        component("d", "Apache-2.0/MIT"),
        component("e", "BSD-3-Clause"),
        component("f", "MPL-2.0"),
      ],
      2,
    );
    expect(top).toEqual([
      ["Apache-2.0 or MIT", 2],
      ["MIT", 2],
    ]);
    expect(others).toBe(2);
  });

  // Renders all 500-odd rows: about a second alone, but it has passed 5 s with the whole suite
  // running in parallel, so it gets longer.
  it("lists every shipped component, and opens its page", async () => {
    const openWebPage = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <OpenSource recorder={{ openWebPage } as unknown as RecorderBridge} />,
    );
    expect(screen.getByRole("heading", { name: "Open source" })).toBeTruthy();
    expect(screen.getByText(new RegExp(`work of ${attributions.length} open-source`))).toBeTruthy();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
    // Scanned closed: axe over five hundred rows is slow, and they're a plain table.
    await expectNoSeriousAxeViolations(container);
    const open = (details: HTMLDetailsElement) => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    };
    open(container.querySelector("details") as HTMLDetailsElement);
    // Each group is folded away until opened.
    expect(screen.queryAllByRole("table")).toHaveLength(0);
    container.querySelectorAll<HTMLDetailsElement>("details details").forEach(open);
    // One table each for Rust and JavaScript, with a header row each.
    const rust = attributions.filter((item) => item.ecosystem === "cargo").length;
    expect(screen.getByRole("heading", { name: `Rust (${rust})` })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: `JavaScript (${attributions.length - rust})` }),
    ).toBeTruthy();
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getAllByRole("row")).toHaveLength(attributions.length + 2);
    fireEvent.click(screen.getByRole("button", { name: "Open the page for serde" }));
    expect(openWebPage).toHaveBeenCalledWith("crate", "serde");
  }, 20_000);
});
