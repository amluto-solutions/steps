// `npm run check`: the local gate before every push (docs/engineering.md#gates).
// Runs every step even after a failure, prints a summary, and exits 1 if anything failed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { folderBytes, removeFolder } from "./lib/folders.mjs";

const root = new URL("..", import.meta.url);
const tauriDir = new URL("../apps/desktop/src-tauri/", import.meta.url);

// A fresh rustup install isn't on PATH until the shell restarts. Windows spells the key "Path".
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const env = {
  ...process.env,
  [pathKey]: [join(homedir(), ".cargo", "bin"), process.env[pathKey]].join(delimiter),
};

// Cargo never deletes old build output, so `target` grows with every dependency update (it once
// reached 77 GB). Past the limit it's cleared, and this run rebuilds it from scratch.
const TARGET_LIMIT_GB = 30;
const target = fileURLToPath(new URL("target", tauriDir));
const targetGb = folderBytes(target) / 1024 ** 3;
if (targetGb > TARGET_LIMIT_GB) {
  console.log(
    `\n• The Rust build folder is ${targetGb.toFixed(0)} GB (limit ${TARGET_LIMIT_GB} GB): clearing it, so this run builds from scratch.`,
  );
  if (!removeFolder(target))
    console.log(`  Couldn't clear all of ${target}: close the app and retry.`);
}

const steps = [
  ["Prettier", "npx prettier --check .", root],
  // Only in the private repository, where the snapshot script lives (it isn't published).
  ...(existsSync(new URL("scripts/public-snapshot.mjs", root))
    ? [["Public files clean", "node scripts/public-snapshot.mjs --check", root]]
    : []),
  ["ESLint", "npx eslint .", root],
  ["TypeScript", "npx tsc -b", root],
  ["Vitest (incl. axe)", "npx vitest run", root],
  ["npm audit (shipped deps)", "npm audit --omit=dev --audit-level=high", root],
  ["cargo fmt", "cargo fmt --all --check", tauriDir],
  ["cargo clippy", "cargo clippy --workspace --all-targets --locked -- -D warnings", tauriDir],
  ["cargo test", "cargo test --workspace --locked", tauriDir],
  ["cargo deny", "cargo deny check", tauriDir],
  ["cargo audit", "cargo audit", tauriDir],
];

const results = [];
for (const [name, command, cwd] of steps) {
  console.log(`\n▶ ${name}: ${command}`);
  const started = Date.now();
  const { status } = spawnSync(command, { cwd, env, shell: true, stdio: "inherit" });
  results.push({ name, ok: status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log("\n── npm run check ──");
for (const { name, ok, seconds } of results) {
  console.log(`${ok ? "✔" : "✘"} ${name} (${seconds}s)`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.log(`\n${failed.length} check(s) failed. Fix them before pushing.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
