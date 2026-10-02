import axe from "axe-core";
import { expect } from "vitest";

/**
 * Fails on any serious or critical axe finding (docs/spec/09-accessibility.md#checks).
 * jsdom has no layout, so colour-contrast is checked in the WebdriverIO runs instead.
 */
export async function expectNoSeriousAxeViolations(root: Element): Promise<void> {
  const results = await axe.run(root, { rules: { "color-contrast": { enabled: false } } });
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    serious.map((violation) => `${violation.id}: ${violation.help}`),
    "serious or critical axe violations",
  ).toEqual([]);
}
