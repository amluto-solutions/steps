/**
 * Ids, times, errors and checks, made exactly as the desktop's `library` crate makes them
 * (`util.rs`, `error.rs`, `guides.rs`), so a guide moves between the editions unchanged.
 */

/** An error the UI words from en.json by its `code` (`errors.<code>`), as for the desktop. */
export class LibraryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

export const errors = {
  invalidId: (what: string) => new LibraryError("invalidId", `The ${what} id is invalid.`),
  invalid: (message: string) => new LibraryError("invalidRequest", message),
  guideNotFound: () =>
    new LibraryError(
      "guideNotFound",
      "The guide was not found. It may have been moved or deleted.",
    ),
  guideExists: () =>
    new LibraryError("guideExists", "A guide with this id already exists in the library."),
  versionNotFound: () =>
    new LibraryError("versionNotFound", "That version of the guide was not found."),
  trashNotFound: () => new LibraryError("trashNotFound", "That guide is no longer in the bin."),
  imageNotFound: () => new LibraryError("imageNotFound", "The image was not found."),
  newerFormat: () =>
    new LibraryError("newerFormat", "This guide was made by a newer version of Steps."),
  unsupportedImage: (reason: string) =>
    new LibraryError("unsupportedImage", `This image can't be used: ${reason}`),
  notInBrowser: () =>
    new LibraryError("invalidRequest", "That isn't available in Steps for the browser."),
  noSiteAccess: () =>
    new LibraryError(
      "noSiteAccess",
      "Steps needs to see the sites you record. Allow it when Firefox asks, or under Permissions for Steps in Firefox's Add-ons and themes.",
    ),
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A guide, step, image, version or bin id: letters, digits, `_` and `-`, up to 128. */
export const isSafeId = (value: unknown): value is string =>
  typeof value === "string" && SAFE_ID.test(value);

export function checkId(value: unknown, what: string): string {
  if (!isSafeId(value)) throw errors.invalidId(what);
  return value;
}

/** The last time an id used, so ids made in the same instant still sort in the order made. */
let lastNanos = 0n;

/**
 * 32 lowercase hex characters: the time in nanoseconds (so ids sort by creation, as the desktop's
 * do), then 64 random bits. The browser's clock is finer than a millisecond but not a nanosecond,
 * so an id made in the same instant as the last is given the next nanosecond.
 */
export function newId(now = performance.timeOrigin + performance.now()): string {
  let nanos = BigInt(Math.round(now * 1_000_000)) & 0xffff_ffff_ffff_ffffn;
  if (nanos <= lastNanos) nanos = lastNanos + 1n;
  lastNanos = nanos;
  const random = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return nanos.toString(16).padStart(16, "0") + hex;
}

/** UTC with milliseconds and `Z`, as the desktop writes: `2026-09-25T10:32:00.000Z`. */
export const nowIso = (now = new Date()) => now.toISOString();

/** `formatVersion` 1 is read; a higher one is a newer Steps's; anything else is invalid. */
export function checkFormatVersion(value: Record<string, unknown>, what: string): void {
  const version = value.formatVersion;
  if (typeof version === "number" && Number.isInteger(version) && version >= 0) {
    if (version === 1) return;
    if (version > 1) throw errors.newerFormat();
  }
  throw errors.invalid(`The ${what} has no valid formatVersion.`);
}

export const UNTITLED = "Untitled guide";
const MAX_TITLE = 300;

/** A title as typed: trimmed, at most 300 characters, and "Untitled guide" when empty. */
export function cleanTitle(title: string): string {
  const trimmed = title.trim();
  if ([...trimmed].length > MAX_TITLE)
    throw errors.invalid(`Enter a title of up to ${MAX_TITLE} characters.`);
  return trimmed || UNTITLED;
}

/** Plain string order, as the desktop sorts (by UTF-16 code units, never by locale). */
export const byString = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Steps in guide order: sort key, then id. */
export function sortSteps<T>(steps: T[]): T[] {
  const key = (step: T) => {
    const record = step as { sortKey?: unknown; id?: unknown };
    return {
      sortKey: typeof record.sortKey === "string" ? record.sortKey : "",
      id: typeof record.id === "string" ? record.id : "",
    };
  };
  return [...steps].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    return byString(left.sortKey, right.sortKey) || byString(left.id, right.id);
  });
}

/** An object's field as a string, or `fallback`. */
export const text = (value: Record<string, unknown>, field: string, fallback = "") => {
  const found = value[field];
  return typeof found === "string" ? found : fallback;
};
