/**
 * Brand fonts in Steps for Chrome (docs/spec/06-brands-and-theming.md): the same rules as the
 * desktop's `export_files.rs`, in the browser. An uploaded `.ttf` is read for its family and
 * whether its licence allows embedding; a font installed on the computer is found with Chrome's
 * Local Font Access, once the person allows it, and only TrueType faces that may be embedded
 * are used. Nothing about the fonts leaves the browser.
 */

/** A font family's faces as base64, as the export takes them (`FaceSet`). */
export interface Faces {
  regular: string | null;
  bold: string | null;
  italic: string | null;
  boldItalic: string | null;
}

/** What Chrome's `queryLocalFonts` gives for each installed face. */
export interface LocalFont {
  family: string;
  style: string;
  blob(): Promise<Blob>;
}

/** The largest font file read, as on the desktop. */
const MAX_FONT_BYTES = 4 * 1024 * 1024;

const be16 = (bytes: Uint8Array, at: number) =>
  at + 2 <= bytes.length ? (bytes[at] ?? 0) * 256 + (bytes[at + 1] ?? 0) : null;
const be32 = (bytes: Uint8Array, at: number) => {
  const high = be16(bytes, at);
  const low = be16(bytes, at + 2);
  return high === null || low === null ? null : high * 65_536 + low;
};

/** TrueType starts with version 1.0 (or "true" on older Macs); not OpenType CFF or a collection. */
export const isTrueType = (bytes: Uint8Array) =>
  (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) ||
  String.fromCharCode(...bytes.subarray(0, 4)) === "true";

/** The offset of a table in the font. */
function table(bytes: Uint8Array, tag: string): number | null {
  const count = be16(bytes, 4) ?? 0;
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag)
      return be32(bytes, record + 8);
  }
  return null;
}

/**
 * A name from the `name` table (1 = family, 2 = subfamily), in its Windows (UTF-16) form: the
 * English (United States) record first, then any Windows one, as the desktop reads it.
 */
export function fontName(bytes: Uint8Array, nameId: number): string | null {
  const base = table(bytes, "name");
  if (base === null) return null;
  const count = be16(bytes, base + 2) ?? 0;
  const strings = base + (be16(bytes, base + 4) ?? 0);
  const records: { record: number; language: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = base + 6 + index * 12;
    if (be16(bytes, record) === 3 && be16(bytes, record + 6) === nameId)
      records.push({ record, language: be16(bytes, record + 4) ?? 0 });
  }
  const chosen = records.find((record) => record.language === 0x0409) ?? records[0];
  if (!chosen) return null;
  const length = be16(bytes, chosen.record + 8) ?? 0;
  const offset = be16(bytes, chosen.record + 10) ?? 0;
  const raw = bytes.subarray(strings + offset, strings + offset + length);
  if (raw.length !== length) return null;
  let text = "";
  for (let at = 0; at + 1 < raw.length; at += 2)
    text += String.fromCharCode((raw[at] ?? 0) * 256 + (raw[at + 1] ?? 0));
  return text;
}

/**
 * The OS/2 `fsType` rules allow putting this font in a document: installable, editable, or
 * preview & print. "Restricted" (bit 1 alone) and bitmap-only (bit 9) are refused.
 */
export function embeddable(bytes: Uint8Array): boolean {
  const base = table(bytes, "OS/2");
  if (base === null) return true;
  const fsType = be16(bytes, base + 8);
  if (fsType === null) return false;
  return (fsType & 0x000f) !== 0x0002 && (fsType & 0x0200) === 0;
}

/** An uploaded font: its family and style, and whether it may be embedded. */
export function checkFont(bytes: Uint8Array) {
  const family = bytes.length <= MAX_FONT_BYTES && isTrueType(bytes) ? fontName(bytes, 1) : null;
  if (!family) throw new Error("That isn't a TrueType font file (.ttf).");
  return { family, subfamily: fontName(bytes, 2) ?? "", embeddable: embeddable(bytes) };
}

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

const SLOTS: Record<string, keyof Faces> = {
  regular: "regular",
  bold: "bold",
  italic: "italic",
  "bold italic": "boldItalic",
};

/** An installed family's faces that may be embedded, from the fonts Chrome lists. */
export async function localFontFamily(fonts: LocalFont[], family: string): Promise<Faces> {
  const faces: Faces = { regular: null, bold: null, italic: null, boldItalic: null };
  const wanted = family.trim().toLowerCase();
  for (const font of fonts) {
    if (font.family.toLowerCase() !== wanted) continue;
    const bytes = new Uint8Array(await (await font.blob()).arrayBuffer());
    if (bytes.length > MAX_FONT_BYTES * 8 || !isTrueType(bytes) || !embeddable(bytes)) continue;
    if (fontName(bytes, 1)?.toLowerCase() !== wanted) continue;
    const slot = SLOTS[(fontName(bytes, 2) ?? font.style).toLowerCase()];
    if (slot && faces[slot] === null) faces[slot] = base64(bytes);
  }
  return faces;
}

/** Chrome's Local Font Access, where the page can use it. */
interface FontWindow {
  queryLocalFonts?: () => Promise<LocalFont[]>;
}

/** Whether Steps may read installed fonts: asked once, then remembered by Chrome. */
export async function localFontsState(): Promise<"granted" | "prompt" | "denied" | "unsupported"> {
  if (!(globalThis as FontWindow).queryLocalFonts) return "unsupported";
  try {
    const status = await navigator.permissions.query({ name: "local-fonts" as PermissionName });
    return status.state;
  } catch {
    return "prompt";
  }
}

/** The installed fonts; asks the person the first time (from a click). */
export async function installedFonts(): Promise<LocalFont[]> {
  const query = (globalThis as FontWindow).queryLocalFonts;
  if (!query) throw new Error("This browser can't read installed fonts.");
  return query.call(globalThis);
}
