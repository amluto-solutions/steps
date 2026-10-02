import type { StorageUse } from "../library-bridge";

/**
 * Browser storage in Steps for Chrome (docs/spec/03-data-and-sharing.md#chrome-edition-storage).
 * With `unlimitedStorage` Chrome never evicts the library, so these are warnings, not limits.
 */

/** Free browser space below which Steps says so, whatever the library's size. */
export const LOW_SPACE_BYTES = 512 * 1024 * 1024;

const UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;

/** "850 KB", "12.4 MB", "1.2 GB": sizes as Windows shows them, in powers of 1024. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} bytes`;
  const shown = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${UNITS[unit]}`;
}

/** Space the browser has left for Steps, when it says. */
export const freeBytes = (use: StorageUse): number | null =>
  use.quotaBytes !== null && use.usedBytes !== null
    ? Math.max(0, use.quotaBytes - use.usedBytes)
    : null;

/**
 * Why to offer "Export and remove", if at all: the browser is short of space, or the library has
 * grown past the size chosen in Settings.
 */
export function storageWarning(
  use: StorageUse | null,
  warnBytes: number,
): "lowSpace" | "large" | null {
  if (!use) return null;
  const free = freeBytes(use);
  if (free !== null && free < LOW_SPACE_BYTES) return "lowSpace";
  return use.libraryBytes > warnBytes ? "large" : null;
}
