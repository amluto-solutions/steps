import { describe, expect, it } from "vitest";

import {
  codeForClipboard,
  codeSchema,
  describeCommand,
  describeFormula,
  keyCombo,
  keyName,
  mergeCode,
} from "./code.ts";
import { parseStep } from "./guide.ts";

describe("code steps", () => {
  it("are worded by where they run", () => {
    expect(describeCommand("powershell")).toBe("Run in PowerShell");
    expect(describeCommand("cmd")).toBe("Run in Command Prompt");
    expect(describeCommand("bash")).toBe("Run in Bash");
    expect(describeCommand("plain")).toBe("Run in the terminal");
    expect(describeFormula(" B6 ")).toBe("Type the formula in cell B6");
    expect(describeFormula(null)).toBe("Type the formula in the selected cell");
  });

  it("read an unknown language as plain, and refuse code longer than a step keeps", () => {
    const code = { text: "ls", language: "cobol", output: null, outputShortened: false };
    expect(codeSchema.parse(code).language).toBe("plain");
    expect(codeSchema.safeParse({ ...code, text: "x".repeat(20_001) }).success).toBe(false);
    expect(codeSchema.safeParse({ ...code, output: "y".repeat(16_385) }).success).toBe(false);
  });

  it("are optional on a step: older steps have none", () => {
    const step = {
      id: "a",
      sortKey: "a0",
      kind: "interaction",
      action: "click",
      actionText: "Click",
      textParts: { verb: "Click", target: "", kind: "" },
      showValue: false,
      textEdited: false,
      context: { app: null, windowTitle: "" },
      target: null,
      media: null,
      highlight: null,
      capturedAt: "",
      updatedAt: "",
      formatVersion: 1,
    };
    expect(parseStep(step).code).toBeUndefined();
    const code = { text: "Get-Date", language: "powershell", output: null, outputShortened: false };
    expect(parseStep({ ...step, code }).code).toEqual(code);
  });

  it("merge into one script, keeping the language when they share one", () => {
    const merged = mergeCode([
      { text: "cd C:\\Temp", language: "powershell", output: null, outputShortened: false },
      { text: "Get-ChildItem", language: "powershell", output: "a.txt", outputShortened: true },
    ]);
    expect(merged).toEqual({
      text: "cd C:\\Temp\nGet-ChildItem",
      language: "powershell",
      output: "a.txt",
      outputShortened: true,
    });
    expect(
      mergeCode([
        { text: "dir", language: "cmd", output: null, outputShortened: false },
        { text: "ls", language: "bash", output: null, outputShortened: false },
      ]).language,
    ).toBe("plain");
  });

  it("copy with Windows line endings, so a script pastes as one block", () => {
    expect(codeForClipboard("a\nb\r\nc")).toBe("a\r\nb\r\nc");
  });
});

describe("key names", () => {
  it("come from the virtual-key code, or what the key types where the layout decides", () => {
    expect(keyName(0x4e)).toBe("N");
    expect(keyName(0x35)).toBe("5");
    expect(keyName(0x73)).toBe("F4");
    expect(keyName(0x2e)).toBe("Delete");
    expect(keyName(0x0d)).toBe("Enter");
    expect(keyName(0x61)).toBe("Num 1");
    expect(keyName(0xba, ";")).toBe(";");
    expect(keyName(0xdb, "ß")).toBe("ß");
    expect(keyName(0xde, "é")).toBe("É");
    expect(keyName(0xff)).toBe("Key 255");
  });

  it("make combinations the way the Add-shortcut popup writes them", () => {
    const keys = { ctrl: true, alt: false, shift: true, win: false, vkey: 0x4e, key: "n" };
    expect(keyCombo(keys)).toBe("Ctrl + Shift + N");
    expect(keyCombo({ ...keys, ctrl: false, shift: false, win: true, vkey: 0x52 })).toBe("Win + R");
  });
});
