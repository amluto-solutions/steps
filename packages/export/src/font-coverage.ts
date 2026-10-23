/**
 * Which characters a font has (its `cmap` table). The UI uses it to choose a PDF's fonts for its
 * language (docs/spec/05-export.md#languages), and the PDF to know which symbols its text fonts
 * lack, so the emoji font draws them (docs/spec/05-export.md#emoji).
 */

const u16 = (view: DataView, at: number) => view.getUint16(at);
const u32 = (view: DataView, at: number) => view.getUint32(at);
const tagAt = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

/** The code points a `cmap` table maps (formats 4 and 12, Unicode subtables). */
function cmapCodePoints(view: DataView, cmap: number): Set<number> {
  const subtables = u16(view, cmap + 2);
  const offsets: number[] = [];
  for (let index = 0; index < subtables; index += 1) {
    const record = cmap + 4 + index * 8;
    const platform = u16(view, record);
    const encoding = u16(view, record + 2);
    // Unicode (platform 0), or Windows' Unicode BMP (3, 1) and full repertoire (3, 10).
    if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))
      offsets.push(cmap + u32(view, record + 4));
  }
  const points = new Set<number>();
  for (const at of offsets) {
    const format = u16(view, at);
    if (format === 4) {
      const segments = u16(view, at + 6) / 2;
      const ends = at + 14;
      const starts = ends + segments * 2 + 2;
      for (let index = 0; index < segments; index += 1) {
        const end = u16(view, ends + index * 2);
        const start = u16(view, starts + index * 2);
        // 0xFFFF ends the table; it maps nothing.
        for (let point = start; point <= end && point !== 0xffff; point += 1) points.add(point);
      }
    } else if (format === 12) {
      const groups = u32(view, at + 12);
      for (let index = 0; index < groups; index += 1) {
        const group = at + 16 + index * 12;
        const start = u32(view, group);
        const end = Math.min(u32(view, group + 4), start + 0x30000);
        for (let point = start; point <= end; point += 1) points.add(point);
      }
    }
  }
  return points;
}

/** The code points a TrueType or OpenType font maps, or null if it can't be read. */
export function sfntCodePoints(bytes: Uint8Array): Set<number> | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = u16(view, 4);
    let cmap = -1;
    for (let index = 0; index < tables; index += 1) {
      const record = 12 + index * 16;
      if (tagAt(bytes, record) === "cmap") cmap = u32(view, record + 8);
    }
    if (cmap < 0) return null;
    const points = cmapCodePoints(view, cmap);
    return points.size > 0 ? points : null;
  } catch {
    return null;
  }
}

/** zlib data inflated (a WOFF file's compressed tables). */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The code points a font maps, read from a TrueType or OpenType font or a WOFF file (the bundled
 * fonts are WOFF, their tables compressed); null if it can't be read.
 */
export async function fontCodePoints(bytes: Uint8Array): Promise<Set<number> | null> {
  try {
    if (bytes.length < 44 || tagAt(bytes, 0) !== "wOFF") return sfntCodePoints(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = u16(view, 12);
    for (let index = 0; index < tables; index += 1) {
      const entry = 44 + index * 20;
      if (tagAt(bytes, entry) !== "cmap") continue;
      const offset = u32(view, entry + 4);
      const compressed = u32(view, entry + 8);
      const original = u32(view, entry + 12);
      const stored = bytes.subarray(offset, offset + compressed);
      const table = compressed < original ? await inflate(stored) : stored;
      const points = cmapCodePoints(
        new DataView(table.buffer, table.byteOffset, table.byteLength),
        0,
      );
      return points.size > 0 ? points : null;
    }
    return null;
  } catch {
    return null;
  }
}
