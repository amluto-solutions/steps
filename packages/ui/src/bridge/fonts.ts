export interface FaceSet {
  regular: string | null;
  bold: string | null;
  italic: string | null;
  boldItalic: string | null;
}

/**
 * Steps for Chrome: whether fonts installed on the computer can be used (Chrome's Local Font
 * Access, asked for once), and asking for them from a click.
 */
export interface LocalFonts {
  state(): Promise<"granted" | "prompt" | "denied" | "unsupported">;
  allow(): Promise<boolean>;
}

/**
 * Fonts for brands and PDFs, part of the recorder bridge: an installed family's faces, and
 * whether an uploaded font may be embedded. Brands and exports both read them.
 */
export interface Fonts {
  /** An installed font family's faces (base64) whose licence allows embedding them in a PDF. */
  getFontFamily(family: string): Promise<FaceSet>;
  /** What an uploaded font file is, and whether its licence allows embedding it. */
  checkFont(bytes: Uint8Array): Promise<{ family: string; subfamily: string; embeddable: boolean }>;
  /** Permission to read installed fonts, where the browser asks for it; null where it doesn't. */
  readonly localFonts: LocalFonts | null;
}
