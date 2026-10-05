import { describe, expect, it } from "vitest";

import { shorten, wordStep } from "./wording.ts";

describe("clicks", () => {
  it.each([
    [{ tagName: "BUTTON", innerText: "Send invoice" }, 'Click "Send invoice"'],
    [{ tagName: "A", innerText: "Pricing" }, 'Click "Pricing"'],
    [{ tagName: "IMG", alt: "Company logo" }, 'Click "Company logo"'],
    [{ tagName: "INPUT", elementType: "submit", value: "Pay now" }, 'Click "Pay now"'],
    [
      { tagName: "INPUT", elementType: "checkbox", labelText: "Keep me signed in" },
      'Click "Keep me signed in"',
    ],
    [{ tagName: "INPUT", elementType: "radio", name: "delivery" }, 'Click "delivery"'],
    [{ tagName: "INPUT", elementType: "text", labelText: "Surname" }, 'Click "Surname" field'],
    [{ tagName: "INPUT", placeholder: "Search staff" }, 'Click "Search staff" field'],
    [{ tagName: "SELECT", labelText: "Country" }, 'Click "Country"'],
    [{ tagName: "TEXTAREA", placeholder: "Notes" }, 'Click "Notes"'],
    [{ tagName: "DIV", role: "switch", labelText: "Dark mode" }, 'Click "Dark mode"'],
    [{ tagName: "SPAN", innerText: "Reports" }, 'Click "Reports"'],
  ])("names %j", (target, words) => {
    expect(wordStep("click", target)).toBe(words);
  });

  it("uses an explicit accessible name before anything else", () => {
    expect(
      wordStep("click", { tagName: "INPUT", ariaLabel: "Find a customer", labelText: "Search" }),
    ).toBe('Click "Find a customer"');
  });

  it("says nothing when nothing names the element", () => {
    expect(wordStep("click", { tagName: "BUTTON" })).toBeUndefined();
    expect(wordStep("click", { tagName: "DIV", role: "button" })).toBeUndefined();
    expect(wordStep("click", null)).toBeUndefined();
  });
});

describe("typing", () => {
  it("names the field and, when shown, the value", () => {
    const field = { tagName: "INPUT", labelText: "Customer name" };
    expect(wordStep("input", { ...field, value: "Acme Ltd" })).toBe(
      'Type "Acme Ltd" in "Customer name" field',
    );
    expect(wordStep("input", field)).toBe('Type in "Customer name" field');
  });

  it("takes the field's label before its other names", () => {
    expect(
      wordStep("input", { labelText: "Email", ariaLabel: "Work email", placeholder: "you@" }),
    ).toBe('Type in "Email" field');
    expect(wordStep("input", { ariaLabel: "Work email", placeholder: "you@" })).toBe(
      'Type in "Work email" field',
    );
  });

  it("names a spreadsheet cell by its reference", () => {
    const cell = { tagName: "TD", role: "gridcell", labelText: "B6" };
    expect(wordStep("input", { ...cell, value: "Q3" })).toBe('Type "Q3" in cell B6');
    expect(wordStep("input", cell)).toBe("Type in cell B6");
  });

  it("words typing into a drop-down list as choosing from it", () => {
    const list = { tagName: "SELECT", labelText: "Country" };
    expect(wordStep("input", { ...list, value: "France" })).toBe('Choose "France" in "Country"');
    expect(wordStep("input", list)).toBe('Choose in "Country"');
    expect(wordStep("input", { role: "combobox", ariaLabel: "Size" })).toBe('Choose in "Size"');
  });

  it("words typing with no field by its value", () => {
    expect(wordStep("input", null, "hello")).toBe('Type "hello"');
    expect(wordStep("input", { value: "42" })).toBe('Type "42"');
    expect(wordStep("input", {})).toBeUndefined();
  });
});

describe("keys and other steps", () => {
  it("quotes a key combination whole", () => {
    expect(wordStep("keypress", null, null, "Ctrl + Shift + S")).toBe('Press "Ctrl + Shift + S"');
  });

  it("names a shortcut Windows has a name for", () => {
    expect(wordStep("keypress", null, null, "Ctrl + C")).toBe('Press "Ctrl + C" (Copy)');
    expect(wordStep("keypress", null, null, "Control + v")).toBe('Press "Ctrl + v" (Paste)');
    expect(wordStep("keypress", null, null, "Shift + Win + S")).toBe(
      'Press "Shift + Win + S" (Snipping Tool)',
    );
    expect(wordStep("keypress", null, null, "Ctrl + N")).toBe('Press "Ctrl + N"');
  });

  it("leaves a navigation to its site's wording (\"Go to\"), never an element's", () => {
    expect(wordStep("navigation", { ariaLabel: "Home" })).toBeUndefined();
    expect(wordStep("navigation", { innerText: "Home" })).toBeUndefined();
  });
});

describe("shortening", () => {
  it("keeps 80 characters, trims the cut, and marks it", () => {
    expect(shorten("x".repeat(80))).toBe("x".repeat(80));
    expect(shorten(`${"a".repeat(79)} tail`)).toBe(`${"a".repeat(79)}...`);
    expect(wordStep("input", null, "y".repeat(90))).toBe(`Type "${"y".repeat(80)}..."`);
  });
});
