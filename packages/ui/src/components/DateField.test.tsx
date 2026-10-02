// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import { DateField } from "./DateField";

const i18n = initI18n();
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("DateField", () => {
  it("shows and reads dates as the app's language writes them, never yyyy-mm-dd", async () => {
    const onChange = vi.fn();
    render(
      <>
        <label htmlFor="review-by">Review by</label>
        <DateField id="review-by" value="2026-12-31" onChange={onChange} />
      </>,
    );
    const box = screen.getByRole("textbox", { name: "Review by" }) as HTMLInputElement;
    expect(box.value).toBe("31/12/2026");
    fireEvent.change(box, { target: { value: "1/2/2027" } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith("2027-02-01");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenLastCalledWith(null);
    await expectNoSeriousAxeViolations(document.body);
  });

  it("says how to write a date when the one typed isn't one", () => {
    const onChange = vi.fn();
    render(<DateField value={null} onChange={onChange} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "31/02/2026" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Type a date like 31/12/2026.");
  });

  it("writes German dates the German way", async () => {
    await i18n.changeLanguage("de");
    render(<DateField value="2026-12-31" onChange={vi.fn()} />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("31.12.2026");
  });
});
