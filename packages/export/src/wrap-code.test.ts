import { describe, expect, it } from "vitest";

import { wrapCode } from "./wrap-code";

describe("code on paper", () => {
  it("wraps only at spaces, so a -Parameter is never split", () => {
    const command =
      'Add-MailboxPermission -Identity "sales@contoso.co.uk" -User "anna@contoso.co.uk" -AccessRights FullAccess';
    const lines = wrapCode(command, 40).split("\n");
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    expect(lines.some((line) => line.trimEnd().endsWith("-"))).toBe(false);
    expect(lines.some((line) => line.includes("-AccessRights"))).toBe(true);
    // Continued lines are indented, and the words all survive in order.
    expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
    expect(lines.map((line) => line.trim()).join(" ")).toBe(command);
  });

  it("keeps short lines, blank lines and indentation as they are", () => {
    expect(wrapCode("a\n\n    b", 40)).toBe("a\n\n    b");
    const indented = `    ${"word ".repeat(12).trim()}`;
    const lines = wrapCode(indented, 30).split("\n");
    expect(lines[0]?.startsWith("    word")).toBe(true);
    expect(lines[1]?.startsWith("      word")).toBe(true);
  });

  it("cuts a word longer than the line rather than overflowing", () => {
    const lines = wrapCode("x".repeat(50), 20).split("\n");
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.join("").replace(/ /g, "")).toBe("x".repeat(50));
  });
});
