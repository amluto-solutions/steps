import { checkFormatVersion, isSafeId, LibraryError } from "../library/ids";

import type { Dir } from "./dir";

/**
 * Reading and writing a shared library's files as the desktop's `library/src/util.rs` does:
 * pretty JSON, whole files only, and temporary files left out of everything.
 */

export type Json = Record<string, unknown>;

export const obj = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const damaged = (name: string, error: unknown) =>
  new LibraryError(
    "damagedFile",
    `A file in the library is damaged: ${name} (${error instanceof Error ? error.message : String(error)})`,
  );

/** A file's JSON; undefined when there's no such file; `damagedFile` when it doesn't parse. */
export async function readJson(dir: Dir, name: string): Promise<unknown> {
  const blob = await dir.read(name);
  if (!blob) return undefined;
  try {
    return JSON.parse(await blob.text()) as unknown;
  } catch (error) {
    throw damaged(name, error);
  }
}

/** A file's JSON, or null when it's missing or unreadable (half-synced files are skipped). */
export async function tryJson(dir: Dir | null, name: string): Promise<unknown> {
  if (!dir) return null;
  try {
    return (await readJson(dir, name)) ?? null;
  } catch {
    return null;
  }
}

/** Pretty JSON, as serde_json writes it. */
export const jsonText = (value: unknown) => JSON.stringify(value, null, 2);

export const writeJson = (dir: Dir, name: string, value: unknown) =>
  dir.write(name, jsonText(value));

export const createJson = (dir: Dir, name: string, value: unknown) =>
  dir.create(name, jsonText(value));

/**
 * A temporary file from an interrupted write: the desktop's `*.tmp`, or the swap file Chrome
 * writes beside a file while saving it (`*.crswap`).
 */
export const isTemporary = (name: string) => /\.(tmp|crswap)$/i.test(name);

/** Every `*.json` file directly in `dir`, by name, in name order; unreadable ones left out. */
export async function jsonFiles(dir: Dir | null): Promise<[string, unknown][]> {
  if (!dir) return [];
  const names = (await dir.entries())
    .filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort(byName);
  const found: [string, unknown][] = [];
  for (const name of names) {
    const value = await tryJson(dir, name);
    if (value !== null) found.push([name, value]);
  }
  return found;
}

/** Name order by UTF-16 code units, as Rust sorts strings (never by locale). */
export const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Copies every file in `from` whose name ends with one of `endings` into `to`. Temporary files
 * are never copied; a missing `from` copies nothing (a sync client may not have delivered it).
 */
export async function copyFiles(from: Dir | null, to: Dir, endings: string[]): Promise<void> {
  if (!from) return;
  for (const entry of await from.entries()) {
    const lower = entry.name.toLowerCase();
    if (entry.kind !== "file" || isTemporary(lower)) continue;
    if (!endings.some((ending) => lower.endsWith(ending))) continue;
    const data = await from.read(entry.name);
    if (data) await to.write(entry.name, data);
  }
}

/** Copies a folder tree, leaving temporary files out: a guide's history when it changes library. */
export async function copyTree(from: Dir | null, to: Dir): Promise<void> {
  if (!from) return;
  for (const entry of await from.entries()) {
    if (isTemporary(entry.name)) continue;
    if (entry.kind === "directory") {
      const child = await from.folder(entry.name);
      if (child) await copyTree(child, await to.makeFolder(entry.name));
    } else {
      const data = await from.read(entry.name);
      if (data) await to.write(entry.name, data);
    }
  }
}

/**
 * The file a folder being built holds until it's whole. Folders can't be renamed through the
 * browser, so where the desktop builds a guide in a `.finalizing-` folder and renames it, Steps
 * for Chrome builds it in place with this marker, writes the file that makes it a guide (or a
 * version) last, then removes the marker. A folder a crash left without that file is swept.
 */
export const BUILDING = ".copying";

/** Checks an id before it becomes part of a path. */
export function checked(value: unknown, what: string): string {
  if (!isSafeId(value)) throw new LibraryError("invalidId", `The ${what} id is invalid.`);
  return value;
}

export { checkFormatVersion };

/**
 * When a guide last changed: its own `updatedAt` or a step's, whichever is later. A step edited
 * after the guide was saved (a blur, new wording) changes only the step's file, and the card said
 * "Edited 9 minutes ago" a minute after Blur all. ISO times compare as text.
 */
export const lastEdited = (guideUpdatedAt: string, steps: unknown[]): string =>
  steps.reduce<string>((latest, step) => {
    const at =
      typeof step === "object" && step !== null
        ? (step as { updatedAt?: unknown }).updatedAt
        : null;
    return typeof at === "string" && at > latest ? at : latest;
  }, guideUpdatedAt);

/** How many steps a guide has, as the editor counts them: recorded ones, not notes or headers. */
export const stepCount = (steps: unknown[]): number =>
  steps.filter(
    (step) =>
      typeof step !== "object" || step === null || (step as { kind?: unknown }).kind !== "block",
  ).length;
