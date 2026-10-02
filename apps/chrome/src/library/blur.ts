/**
 * Burning blur into a screenshot for good, as the desktop does (`library/src/media.rs`): each
 * area is pixelated, then box-blurred, both confined to the area, so nothing outside it is read
 * or changed and the hidden text can't be recovered.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** One axis of an area, in pixels: `[low, high)`, or null when it covers nothing. */
function span(start: number, size: number, total: number): [number, number] | null {
  if (!Number.isFinite(start) || !Number.isFinite(size)) return null;
  const [from, to] = size < 0 ? [start + size, start] : [start, start + size];
  const low = Math.floor((clamp(from, 0, 100) / 100) * total);
  const high = Math.ceil((clamp(to, 0, 100) / 100) * total);
  return high > low ? [low, high] : null;
}

/** Blurs each area of an RGBA image in place, in the order given; overlapping areas compound. */
export function burnRedactions(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rects: readonly Rect[],
): void {
  const block = Math.max(Math.floor(Math.max(width, height) / 64), 12);
  const radius = Math.floor(block / 2);
  for (const rect of rects) {
    const xs = span(rect.x, rect.w, width);
    const ys = span(rect.y, rect.h, height);
    if (!xs || !ys) continue;
    const [left, right] = xs;
    const [top, bottom] = ys;
    pixelate(pixels, width, left, right, top, bottom, block);
    boxBlur(pixels, width, left, right, top, bottom, radius);
  }
}

function pixelate(
  pixels: Uint8ClampedArray,
  width: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
  block: number,
) {
  for (let tileTop = top; tileTop < bottom; tileTop += block) {
    const tileBottom = Math.min(tileTop + block, bottom);
    for (let tileLeft = left; tileLeft < right; tileLeft += block) {
      const tileRight = Math.min(tileLeft + block, right);
      const sums = [0, 0, 0, 0];
      const count = (tileRight - tileLeft) * (tileBottom - tileTop);
      for (let y = tileTop; y < tileBottom; y += 1)
        for (let x = tileLeft; x < tileRight; x += 1)
          for (let channel = 0; channel < 4; channel += 1)
            sums[channel] = (sums[channel] ?? 0) + (pixels[(y * width + x) * 4 + channel] ?? 0);
      const means = sums.map((sum) => Math.floor(sum / count));
      for (let y = tileTop; y < tileBottom; y += 1)
        for (let x = tileLeft; x < tileRight; x += 1)
          for (let channel = 0; channel < 4; channel += 1)
            pixels[(y * width + x) * 4 + channel] = means[channel] ?? 0;
    }
  }
}

/** A box blur of `radius`: along each row, then down each column, within the area only. */
function boxBlur(
  pixels: Uint8ClampedArray,
  width: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
  radius: number,
) {
  const pass = (count: number, lines: number, at: (line: number, index: number) => number) => {
    // Running sums of the line as it was, so each pixel's window costs the same at any radius.
    const prefix = new Float64Array((count + 1) * 4);
    for (let line = 0; line < lines; line += 1) {
      for (let index = 0; index < count; index += 1)
        for (let channel = 0; channel < 4; channel += 1)
          prefix[(index + 1) * 4 + channel] =
            (prefix[index * 4 + channel] ?? 0) + (pixels[at(line, index) * 4 + channel] ?? 0);
      for (let index = 0; index < count; index += 1) {
        const from = Math.max(index - radius, 0);
        const to = Math.min(index + radius + 1, count);
        for (let channel = 0; channel < 4; channel += 1) {
          const sum = (prefix[to * 4 + channel] ?? 0) - (prefix[from * 4 + channel] ?? 0);
          pixels[at(line, index) * 4 + channel] = Math.floor(sum / (to - from));
        }
      }
    }
  };
  pass(right - left, bottom - top, (row, index) => (top + row) * width + left + index);
  pass(bottom - top, right - left, (column, index) => (top + index) * width + left + column);
}
