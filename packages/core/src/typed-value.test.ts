import { describe, expect, it } from "vitest";

import { typedValueInText, visibleStepText, withoutTypedValue } from "./typed-value.ts";

const step = (actionText: string, value: string | undefined, showValue: boolean) => ({
  actionText,
  textParts: { verb: "input", target: "Name", kind: "field", ...(value ? { value } : {}) },
  showValue,
});

describe("typed values in wording", () => {
  it("are taken out wherever and however they're written", () => {
    expect(withoutTypedValue('Type "Acme" in Name, then check ACME appears', "acme")).toBe(
      'Type "…" in Name, then check … appears',
    );
    // Characters that mean something in a pattern are matched as themselves.
    expect(withoutTypedValue("Enter a+b (x)", "a+b (x)")).toBe("Enter …");
    expect(withoutTypedValue("Nothing to hide", undefined)).toBe("Nothing to hide");
    expect(withoutTypedValue("Keep it", "   ")).toBe("Keep it");
  });

  it("are taken out in the shortened form wording gives a long value", () => {
    const address =
      "Flat 4, 221 Baker Street, London, NW1 6XE - customer ref ACME-778812 for Mrs J Smith";
    const shortened = `${address.slice(0, 80).trimEnd()}...`;
    const wording = `Type "${shortened}" in "Address" field and press Tab`;
    expect(withoutTypedValue(wording, address)).toBe('Type "…" in "Address" field and press Tab');
    expect(
      typedValueInText({ actionText: wording, textParts: step("", address, false).textParts }),
    ).toBe(true);
  });

  it("only match the value on its own, never inside another word", () => {
    expect(withoutTypedValue('Type "e" in "Customer name"', "e")).toBe(
      'Type "…" in "Customer name"',
    );
    expect(visibleStepText(step('Type in "Customer name" field', "e", false))).toBe(
      'Type in "Customer name" field',
    );
    expect(withoutTypedValue("Order 1234 and 12345", "1234")).toBe("Order … and 12345");
  });

  it("only reach a reader when the step shows them", () => {
    expect(visibleStepText(step("Type Acme", "Acme", true))).toBe("Type Acme");
    expect(visibleStepText(step("Type Acme", "Acme", false))).toBe("Type …");
    expect(typedValueInText(step("Type acme here", "Acme", false))).toBe(true);
    expect(typedValueInText(step("Type the name", "Acme", false))).toBe(false);
  });
});

describe("finding a value in wording that was edited (F028)", () => {
  it("finds it across line breaks and spacing, and by its start when the rest was changed", () => {
    const value = "Hello from Quinn. Test invoice INV-.txtC:\\Users\\RobinHale\\testdata";
    expect(
      withoutTypedValue(
        'Type "Hello from Quinn.\nTest invoice INV-.txtC:\\Users\\RobinHale\\testdata"',
        value,
      ),
    ).toBe('Type "…"');
    expect(
      withoutTypedValue(
        'Type "Hello from Quinn. Test invoice INV-.txtC:\\Users\\USERNAME\\testdata..." in "File name:"',
        value,
      ),
    ).toBe('Type "…" in "File name:"');
    // A short value is only ever found whole.
    expect(withoutTypedValue("Acme Ltd and Acme Limited", "Acme Ltd")).toBe("… and Acme Limited");
  });
});
