/** Version of the on-disk guide format this build writes. See docs/spec/03-data-and-sharing.md. */
export const FORMAT_VERSION = 1;

/**
 * True when this build can read a file written with `formatVersion`.
 * Newer versions are refused rather than half-read (docs/spec/08-privacy-and-security.md#hostile-files).
 */
export function canReadFormat(formatVersion: number): boolean {
  return Number.isInteger(formatVersion) && formatVersion >= 1 && formatVersion <= FORMAT_VERSION;
}
