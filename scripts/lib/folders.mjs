// Folder helpers for the release and the gate: comparing builds, and keeping build output from
// filling the disk (a release clone is several gigabytes; the working copy's `target` once
// reached 77 GB).
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every file under `folder`, as paths relative to it with forward slashes. */
export const filesIn = (folder, prefix = "") =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesIn(join(folder, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );

/** The total size of the files under `folder`, in bytes (0 when it doesn't exist). */
export function folderBytes(folder) {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) total += folderBytes(path);
    else if (entry.isFile()) {
      // A build running beside this (the dev app rebuilding) can delete a file between the
      // listing and this look at it (06/10/2026: the gate stopped on one).
      try {
        total += statSync(path).size;
      } catch {
        // gone: nothing to count
      }
    }
  }
  return total;
}

/** How two folders differ, file by file: an empty list when they're byte for byte the same. */
export function folderDifferences(expected, actual) {
  const left = new Set(filesIn(expected));
  const right = new Set(filesIn(actual));
  const differences = [];
  for (const name of [...left].sort()) {
    if (!right.has(name)) differences.push(`${name} is missing`);
    else if (!readFileSync(join(expected, name)).equals(readFileSync(join(actual, name))))
      differences.push(`${name} differs`);
  }
  for (const name of [...right].sort()) {
    if (!left.has(name)) differences.push(`${name} is extra`);
  }
  return differences;
}

/**
 * Removes a folder, retrying while Windows still holds a file in it (a build tool or the virus
 * scanner closing it). Returns false rather than throwing, so a clean-up can't hide the error that
 * led to it.
 */
export function removeFolder(folder) {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    return true;
  } catch {
    return false;
  }
}

const versionParts = (name) => name.split(".").map(Number);
const newerFirst = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let index = 0; index < 3; index += 1) {
    if (x[index] !== y[index]) return y[index] - x[index];
  }
  return 0;
};

/**
 * The version folders in release-out to remove, keeping the newest `keep`. Older versions are
 * already published (and can be rebuilt from their tags), so they only take space. Anything not
 * named like a version is left alone.
 */
export function oldReleases(names, keep) {
  return names
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort(newerFirst)
    .slice(keep);
}

/**
 * Temporary folders left by a release that was killed before it could tidy up: named with one of
 * `prefixes` and untouched for longer than `maxAgeMs` (a release takes about an hour, so a running
 * one is never caught).
 */
export function staleTemporaries(entries, prefixes, now, maxAgeMs) {
  return entries
    .filter(({ name }) => prefixes.some((prefix) => name.startsWith(prefix)))
    .filter(({ modified }) => now - modified > maxAgeMs)
    .map(({ name }) => name);
}
