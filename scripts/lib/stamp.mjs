// The installer type the Tauri CLI stamps into the program (tauri-utils `bundle_type()`), which
// the updater uses to decide whether a copy may update itself
// (docs/spec/10-distribution.md#updates-for-the-exe). The CLI (2.11) stamps the program while
// it builds each installer and then leaves the build folder's copy "unknown" again (seen in the
// 27/09/2026 end-to-end test). The loose amluto-steps.exe and the Store package's copy are
// re-stamped "unknown" all the same, so no change in the CLI can make them ask for updates: only
// the copy the setup .exe installs should.
import { readFileSync, writeFileSync } from "node:fs";

const MARK = /__TAURI_BUNDLE_TYPE_VAR_(UNK|DEB|RPM|APP|MSI|NSS)/g;

/** The stamp in a program ("NSS", "MSI", "UNK"…). Throws unless there is exactly one. */
export function readStamp(bytes) {
  const found = [...Buffer.from(bytes).toString("latin1").matchAll(MARK)];
  if (found.length !== 1) throw new Error(`expected one installer stamp, found ${found.length}`);
  return found[0][1];
}

/** A copy of the program's bytes stamped "unknown" (the same length, so nothing moves). */
export function unstamped(bytes) {
  const buffer = Buffer.from(bytes);
  readStamp(buffer);
  const text = buffer.toString("latin1");
  const at = text.search(MARK);
  const result = Buffer.from(buffer);
  result.write("__TAURI_BUNDLE_TYPE_VAR_UNK", at, "latin1");
  return result;
}

/** Re-stamps a program file as "unknown" in place; returns the stamp it had. */
export function unstampFile(path) {
  const bytes = readFileSync(path);
  const before = readStamp(bytes);
  writeFileSync(path, unstamped(bytes));
  return before;
}
