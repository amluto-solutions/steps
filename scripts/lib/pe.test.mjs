import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { peImports } from "./pe.mjs";

describe.runIf(process.platform === "win32")("PE imports", () => {
  it("reads the DLLs and functions a real executable imports", () => {
    // node.exe is always there and imports from kernel32 by name.
    const imports = peImports(process.execPath);
    const kernel = imports.get("kernel32.dll");
    expect(kernel).toBeDefined();
    expect(kernel).toContain("GetProcAddress");
    expect([...imports.values()].flat()).not.toContain("InjectTouchInput");
  });

  it("refuses files that aren't executables", () => {
    expect(() => peImports(fileURLToPath(new URL("./pe.mjs", import.meta.url)))).toThrow(
      /not an MZ executable/,
    );
  });
});
