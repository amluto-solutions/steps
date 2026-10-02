import { describe, expect, it } from "vitest";

import { checkFont, embeddable, fontName, localFontFamily, type LocalFont } from "./fonts";

/**
 * A minimal TrueType file: its table directory, a `name` table with Windows records, and an
 * `OS/2` table holding only what's read (`fsType`).
 */
function ttf(options: {
  names: { id: number; text: string; language?: number }[];
  fsType?: number;
  version?: number[];
}): Uint8Array {
  const strings: number[] = [];
  const records: number[] = [];
  const push16 = (into: number[], value: number) => into.push((value >> 8) & 0xff, value & 0xff);
  for (const name of options.names) {
    const utf16 = [...name.text].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]);
    for (const value of [3, 1, name.language ?? 0x0409, name.id, utf16.length, strings.length])
      push16(records, value);
    strings.push(...utf16);
  }
  const name: number[] = [];
  for (const value of [0, options.names.length, 6 + records.length]) push16(name, value);
  name.push(...records, ...strings);
  const os2 = [0, 4, 0, 0, 0, 0, 0, 0, (options.fsType ?? 0) >> 8, (options.fsType ?? 0) & 0xff];

  const header = [...(options.version ?? [0, 1, 0, 0]), 0, 2, 0, 0, 0, 0, 0, 0];
  const directory: number[] = [];
  const nameOffset = 12 + 2 * 16;
  const os2Offset = nameOffset + name.length;
  for (const [tag, offset, length] of [
    ["name", nameOffset, name.length],
    ["OS/2", os2Offset, os2.length],
  ] as const) {
    directory.push(...[...tag].map((ch) => ch.charCodeAt(0)), 0, 0, 0, 0);
    directory.push(0, 0, offset >> 8, offset & 0xff, 0, 0, length >> 8, length & 0xff);
  }
  return new Uint8Array([...header, ...directory, ...name, ...os2]);
}

const face = (family: string, style: string, fsType = 0) =>
  ttf({
    names: [
      { id: 1, text: family },
      { id: 2, text: style },
    ],
    fsType,
  });

describe("brand fonts in the browser", () => {
  it("reads the English family and style, as the desktop does", () => {
    const font = ttf({
      names: [
        { id: 1, text: "Century Gothic" },
        { id: 2, text: "Negreta", language: 0x0403 },
        { id: 2, text: "Bold" },
      ],
    });
    expect(fontName(font, 1)).toBe("Century Gothic");
    expect(fontName(font, 2)).toBe("Bold");
    expect(fontName(font, 16)).toBeNull();
  });

  it.each([
    [0x0000, true],
    [0x0004, true],
    [0x0008, true],
    [0x0002, false],
    [0x0200, false],
  ])("follows the licence's embedding rules (fsType %i)", (fsType, allowed) => {
    expect(embeddable(face("Brand Sans", "Regular", fsType))).toBe(allowed);
  });

  it("takes an uploaded TrueType font, and refuses anything else", () => {
    expect(checkFont(face("Brand Sans", "Regular"))).toEqual({
      family: "Brand Sans",
      subfamily: "Regular",
      embeddable: true,
    });
    const otf = ttf({ names: [{ id: 1, text: "Brand" }], version: [0x4f, 0x54, 0x54, 0x4f] });
    expect(() => checkFont(otf)).toThrow("TrueType");
    expect(() => checkFont(new Uint8Array(5 * 1024 * 1024))).toThrow("TrueType");
  });

  it("finds an installed family's faces that may be embedded", async () => {
    const installed = (family: string, style: string, bytes: Uint8Array): LocalFont => ({
      family,
      style,
      blob: () => Promise.resolve(new Blob([bytes.slice()])),
    });
    const regular = face("Brand Sans", "Regular");
    const fonts = [
      installed("Brand Sans", "Regular", regular),
      installed("Brand Sans", "Bold", face("Brand Sans", "Bold")),
      // A restricted face and another family are left out.
      installed("Brand Sans", "Italic", face("Brand Sans", "Italic", 0x0002)),
      installed("Other", "Regular", face("Other", "Regular")),
    ];
    const faces = await localFontFamily(fonts, "brand sans");
    expect(faces.italic).toBeNull();
    expect(faces.boldItalic).toBeNull();
    expect(faces.bold).not.toBeNull();
    const decoded = Uint8Array.from(atob(faces.regular ?? ""), (ch) => ch.charCodeAt(0));
    expect(decoded).toEqual(regular);
  });
});
