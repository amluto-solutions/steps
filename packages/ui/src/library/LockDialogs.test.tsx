// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import type { GuideLocks } from "./guide-locks";
import { askNewPassword, LockHost } from "./LockDialogs";

initI18n();
afterEach(cleanup);

/** The Lock… screen, opened as the library opens it; resolves with what it answered. */
function openLock() {
  const view = render(<LockHost locks={{} as GuideLocks} library={undefined} libraries={[]} />);
  let answer: Promise<string | null> = Promise.resolve(null);
  act(() => {
    answer = askNewPassword("Lock “Add a supplier”", null, "Lock");
  });
  const first = screen.getByLabelText("Password");
  const second = screen.getByLabelText("Type the password again");
  const type = (field: HTMLElement, value: string) =>
    fireEvent.change(field, { target: { value } });
  const lock = () => fireEvent.click(screen.getByRole("button", { name: "Lock" }));
  return { view, first, second, type, lock, answer: () => answer };
}

describe("the Lock… screen", () => {
  it("shows two different passwords as an error on the fields, and clears it on the next change", async () => {
    const { view, first, second, type, lock } = openLock();
    type(first, "secret-one");
    type(second, "secret-two");
    lock();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The two passwords aren’t the same.");
    // The app's error colour (an undefined `text-danger` left it as plain text in 1.0.0).
    expect(alert.className).toContain("text-recording");
    for (const field of [first, second]) {
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    }
    await expectNoSeriousAxeViolations(view.container);

    // Correcting the second box takes the message away before Lock is pressed again.
    type(second, "secret-one");
    expect(screen.queryByRole("alert")).toBeNull();
    for (const field of [first, second]) {
      expect(field.getAttribute("aria-invalid")).toBeNull();
      expect(field.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("clears the message when the first password changes too", () => {
    const { first, second, type, lock } = openLock();
    type(first, "secret-one");
    type(second, "secret-two");
    lock();
    expect(screen.getByRole("alert")).toBeTruthy();
    type(first, "secret-two");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("answers with the password once both match", async () => {
    const { first, second, type, lock, answer } = openLock();
    type(first, "secret-one");
    type(second, "secret-one");
    lock();
    expect(await answer()).toBe("secret-one");
  });
});
