// Writes packages/ui/src/settings/attributions.json: every open-source component Steps ships, with
// its version and licence, for Settings > About. The same list as the release's third-party
// notices (scripts/lib/notices.mjs). `npm run attributions` after changing dependencies; the
// release stops if the committed list is out of date.
import { writeFileSync } from "node:fs";
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
writeFileSync(join(root, ATTRIBUTIONS_PATH), renderAttributions(components));
console.log(`${components.length} components written to ${ATTRIBUTIONS_PATH}`);
