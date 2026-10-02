import known from "../../../../packages/core/test-vectors/known-fields.json";

type Json = Record<string, unknown>;

/** The most fields from a newer Steps one file carries forward, and their size together. */
const MAX_NEWER_FIELDS = 32;
const MAX_NEWER_BYTES = 1024 * 1024;

/**
 * `value` with the fields a newer Steps wrote to the file (`onDisk`) and this version doesn't
 * know, so a colleague on this version editing a shared guide doesn't wipe a later feature's data
 * (docs/spec/03-data-and-sharing.md#versions-of-steps). The desktop does the same
 * (`with_newer_fields`). Only top-level fields this version has no name for are kept, never shown,
 * used or exported; more than 32 of them, or over 1 MB, and none are.
 */
export function withNewerFields(kind: "guide" | "step", onDisk: unknown, value: Json): Json {
  if (typeof onDisk !== "object" || onDisk === null || Array.isArray(onDisk)) return value;
  const names: string[] = known[kind];
  const newer = Object.entries(onDisk as Json).filter(
    ([key]) => !names.includes(key) && !(key in value),
  );
  if (
    newer.length === 0 ||
    newer.length > MAX_NEWER_FIELDS ||
    new TextEncoder().encode(JSON.stringify(Object.fromEntries(newer))).length > MAX_NEWER_BYTES
  )
    return value;
  return { ...value, ...Object.fromEntries(newer) };
}
