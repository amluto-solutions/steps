import type { FaceSet, Fonts, LocalFonts } from "./fonts";

/**
 * A stand-in font file for `fakeFonts().checkFont`: only its family, and whether its licence
 * allows embedding.
 */
export const fakeFontFile = (family: string, embeddable = true) =>
  new TextEncoder().encode(`font:${family}:${embeddable ? "embeddable" : "restricted"}`);

/**
 * Fonts for tests and the preview: `installed` families' faces (none unless given), files made by
 * `fakeFontFile` (anything else isn't a font), and `localFonts` where a browser would ask
 * (absent unless given, as on the desktop).
 */
export function fakeFonts(
  options: { installed?: Record<string, FaceSet>; localFonts?: LocalFonts } = {},
): Fonts {
  const none: FaceSet = { regular: null, bold: null, italic: null, boldItalic: null };
  return {
    getFontFamily: (family) => Promise.resolve(options.installed?.[family] ?? none),
    checkFont(bytes) {
      const [kind, family, licence] = new TextDecoder().decode(bytes).split(":");
      if (kind !== "font" || !family)
        return Promise.reject(new Error("That isn't a TrueType font file (.ttf)."));
      return Promise.resolve({
        family,
        subfamily: "Regular",
        embeddable: licence === "embeddable",
      });
    },
    localFonts: options.localFonts ?? null,
  };
}
