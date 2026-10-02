import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { npmPackages, renderNotices } from "./notices.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("third-party notices", () => {
  it("lists the npm packages that ship, not dev tools or our own packages", () => {
    const packages = npmPackages(root);
    const names = packages.map((item) => item.name);
    expect(names).toContain("react");
    expect(names).toContain("pdfmake");
    expect(names).not.toContain("vitest");
    expect(names).not.toContain("eslint");
    expect(names.some((name) => name.startsWith("@amluto-steps/"))).toBe(false);
    const react = packages.find((item) => item.name === "react");
    expect(react?.licence).toBe("MIT");
    expect(react?.files.some((file) => /MIT License/i.test(file.text))).toBe(true);
  });

  it("gives a package without a licence file its authors and the standard text", () => {
    const text = renderNotices("1.2.3", [
      {
        ecosystem: "cargo",
        name: "bare",
        version: "0.1.0",
        licence: "MIT OR Apache-2.0",
        source: "https://example.test/bare",
        authors: ["Ada Lovelace"],
        files: [],
      },
      {
        ecosystem: "cargo",
        name: "full",
        version: "1.0.0",
        licence: "Apache-2.0",
        source: "https://example.test/full",
        authors: [],
        files: [
          {
            name: "LICENSE-APACHE",
            text: [
              "Apache License",
              "Version 2.0, January 2004",
              "...",
              "END OF TERMS AND CONDITIONS",
            ].join("\n"),
          },
        ],
      },
    ]);
    const lines = text.split("\n");
    expect(text).toContain("This package has no licence file of its own. Copyright: Ada Lovelace.");
    expect(lines[lines.indexOf("--- MIT ---") + 1]).toMatch(
      /^Copyright \(c\) the component's authors/,
    );
    expect(lines[lines.indexOf("--- Apache-2.0 ---") + 1]).toBe("Apache License");
  });

  it("says where MPL-2.0 source is, and carries each licence text", () => {
    const text = renderNotices("1.2.3", [
      {
        ecosystem: "cargo",
        name: "cssparser",
        version: "0.29.6",
        licence: "MPL-2.0",
        source: "https://github.com/servo/rust-cssparser",
        files: [{ name: "LICENSE", text: "Mozilla Public License Version 2.0" }],
      },
    ]);
    expect(text).toContain("Steps 1.2.3: third-party notices");
    expect(text).toContain("- cssparser 0.29.6 (cargo): MPL-2.0");
    expect(text).toContain("Source: https://github.com/servo/rust-cssparser");
    expect(text).toContain("used unmodified");
    expect(text).toContain("Mozilla Public License Version 2.0");
  });
});
