import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bundledCovers, charactersOf, fontCodePoints, fontsToTry } from "./coverage";

const windowsFont = (name: string) => {
  const path = `C:\\Windows\\Fonts\\${name}`;
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
};

describe("which characters a font has", () => {
  it("needs only what's past plain ASCII, once each", () => {
    expect(charactersOf("Click Save")).toEqual([]);
    expect(charactersOf("Łódź Łódź").map((point) => String.fromCodePoint(point))).toEqual([
      "Ł",
      "ó",
      "ź",
    ]);
  });

  it("knows the bundled Latin fallbacks can't show Polish or Greek, but can show French", () => {
    expect(bundledCovers(charactersOf("Cliquez sur « Enregistrer »"))).toBe(true);
    expect(bundledCovers(charactersOf("Kliknij „Zapisz”, łącznie"))).toBe(false);
    expect(bundledCovers(charactersOf("Κάντε κλικ"))).toBe(false);
  });

  it("reads a TrueType font's map: Century Gothic has no Korean, Malgun Gothic has", () => {
    const century = windowsFont("GOTHIC.TTF");
    const malgun = windowsFont("malgun.ttf");
    if (!century || !malgun) return; // Not on this machine.
    const korean = charactersOf("저장을 클릭하세요");
    const inCentury = fontCodePoints(century);
    const inMalgun = fontCodePoints(malgun);
    expect(korean.every((point) => inCentury?.has(point))).toBe(false);
    expect(korean.every((point) => inMalgun?.has(point))).toBe(true);
    expect(fontCodePoints(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("tries a script's own fonts first, then general ones", () => {
    expect(fontsToTry("ja")[0]).toBe("Yu Gothic");
    expect(fontsToTry("pl")[0]).toBe("Segoe UI");
    // An English guide titled in Chinese or Korean still gets a font for it (F050).
    expect(fontsToTry("en", charactersOf("Guide 测试"))[0]).toBe("Microsoft YaHei");
    expect(fontsToTry("en", charactersOf("저장"))[0]).toBe("Malgun Gothic");
  });
});
