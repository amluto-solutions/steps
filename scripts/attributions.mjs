// Writes packages/ui/src/settings/attributions.json: every open-source component Steps ships, with
// its version and licence, for Settings > About. The same list as the release's third-party
// notices (scripts/lib/notices.mjs). `npm run attributions` after changing dependencies.
// `--check` (in `npm run check`) only compares: the release stops on an out-of-date list, and
// finding that out at the end of a 40-minute build cost a rebuild (07/10/2026).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ATTRIBUTIONS_PATH,
  npmPackages,
  renderAttributions,
  rustPackages,
} from "./lib/notices.mjs";

const root = join(import.meta.dirname, "..");
const components = [
  ...rustPackages(join(root, "apps", "desktop", "src-tauri")),
  ...npmPackages(root),
];
const rendered = renderAttributions(components);
if (process.argv.includes("--check")) {
  if (readFileSync(join(root, ATTRIBUTIONS_PATH), "utf8") !== rendered) {
    console.error(`${ATTRIBUTIONS_PATH} is out of date: run npm run attributions and commit it`);
    process.exit(1);
  }
  console.log(`${ATTRIBUTIONS_PATH} lists the ${components.length} components shipped`);
} else {
  writeFileSync(join(root, ATTRIBUTIONS_PATH), rendered);
  console.log(`${components.length} components written to ${ATTRIBUTIONS_PATH}`);
}
