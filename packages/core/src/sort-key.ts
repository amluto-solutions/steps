/**
 * Fractional sort keys for step order (docs/spec/03-data-and-sharing.md). Moving a step writes a
 * new key for that one step only, so two people syncing a shared library rarely touch the same
 * file. Keys are base-36 strings compared byte by byte (plain `<`), never with `localeCompare`,
 * so TypeScript and Rust order them the same way.
 */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

const digitAt = (key: string, index: number): number => {
  const value = DIGITS.indexOf(key[index] ?? "0");
  if (value < 0) throw new Error(`Invalid sort key: ${key}`);
  return value;
};

/** Trailing zeros don't change a key's position, and a generated key never ends in one. */
const trimZeros = (key: string): string => key.replace(/0+$/, "");

/** True when `key` only uses the sort-key alphabet. */
export const isSortKey = (key: string): boolean => /^[0-9a-z]+$/.test(key);

/** Byte-order comparison, the one order used everywhere for sort keys. */
export const compareSortKeys = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// The midpoint of two fractions written as base-36 digits after the point (the usual
// fractional-indexing midpoint). `low` < `high`, neither has trailing zeros, and `high` null
// means 1.
const midpoint = (low: string, high: string | null): string => {
  if (high !== null) {
    let shared = 0;
    while ((low[shared] ?? "0") === high[shared]) shared += 1;
    if (shared > 0) return high.slice(0, shared) + midpoint(low.slice(shared), high.slice(shared));
  }
  const lowDigit = low ? digitAt(low, 0) : 0;
  const highDigit = high !== null ? digitAt(high, 0) : BASE;
  if (highDigit - lowDigit > 1) return DIGITS[Math.round((lowDigit + highDigit) / 2)] ?? "i";
  if (high !== null && high.length > 1) return high.slice(0, 1);
  return (DIGITS[lowDigit] ?? "0") + midpoint(low.slice(1), null);
};

/**
 * Past this length a new key is refused and the guide renumbered instead. Keys grow by about one
 * character for every few inserts in the same place (a thousand appends made one of 200, the most
 * a step file may hold), so they are kept well short of that.
 */
export const MAX_SORT_KEY_LENGTH = 64;

/**
 * A key that sorts strictly after `before` and strictly before `after` (either may be null for
 * "the start" / "the end"). Returns null when no key fits, e.g. between `"1"` and `"10"`, or
 * when it would be longer than {@link MAX_SORT_KEY_LENGTH}; the caller then renumbers the whole
 * guide with {@link spreadKeys}.
 */
export function keyBetween(before: string | null, after: string | null): string | null {
  const low = before === null ? "" : trimZeros(before);
  const high = after === null ? null : trimZeros(after);
  if (high !== null && !(low < high)) return null;
  const key = midpoint(low, high);
  if (before !== null && !(key > before)) return null;
  if (after !== null && !(key < after)) return null;
  return key.length > MAX_SORT_KEY_LENGTH ? null : key;
}

/** `count` evenly spread keys in order, for a new guide or a renumbering. */
export function spreadKeys(count: number): string[] {
  const width = Math.max(1, Math.ceil(Math.log(count + 1) / Math.log(BASE)) + 1);
  const span = BASE ** width;
  return Array.from({ length: count }, (_, index) => {
    const value = Math.floor(((index + 1) * span) / (count + 1));
    return trimZeros(value.toString(BASE).padStart(width, "0")) || "i";
  });
}
