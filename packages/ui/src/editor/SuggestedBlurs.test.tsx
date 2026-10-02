// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Finding } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import { SuggestedBlurs } from "./SuggestedBlurs";

initI18n();
afterEach(cleanup);

const email: Finding = {
  kind: "email",
  text: "sam@example.com",
  rect: { x: 60, y: 30, w: 12, h: 2.5 },
};
const postcode: Finding = {
  kind: "postcode",
  text: "SW1A 1AA",
  rect: { x: 70, y: 62, w: 7, h: 2.5 },
};

const panel = () => {
  const props = { onBlur: vi.fn(), onDismiss: vi.fn(), onShow: vi.fn(), onPoint: vi.fn() };
  render(<SuggestedBlurs findings={[email, postcode]} {...props} />);
  return props;
};

describe("SuggestedBlurs", () => {
  it("blurs one of two findings on its own (30/09/2026)", () => {
    const props = panel();
    fireEvent.click(screen.getByRole("button", { name: "Blur postcode (2)" }));
    expect(props.onBlur).toHaveBeenCalledWith([postcode]);
    fireEvent.click(screen.getByRole("button", { name: "Blur all 2" }));
    expect(props.onBlur).toHaveBeenLastCalledWith([email, postcode]);
  });

  it("shows, dismisses and points at each finding by itself", () => {
    const props = panel();
    fireEvent.click(screen.getByRole("button", { name: "Show email (1) on the screenshot" }));
    expect(props.onShow).toHaveBeenCalledWith(email);
    fireEvent.click(screen.getByRole("button", { name: "email (1) isn’t personal" }));
    expect(props.onDismiss).toHaveBeenCalledWith([email]);
    fireEvent.mouseEnter(screen.getByText("postcode"));
    expect(props.onPoint).toHaveBeenLastCalledWith(1);
  });

  it("shows nothing when there's nothing to suggest", () => {
    const { container } = render(
      <SuggestedBlurs
        findings={[]}
        onBlur={vi.fn()}
        onDismiss={vi.fn()}
        onShow={vi.fn()}
        onPoint={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
