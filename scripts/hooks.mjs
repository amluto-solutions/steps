// Switches on the pre-push hook (.githooks/pre-push, which runs `npm run check`) as `npm install`
// runs. Outside a git checkout, such as a sources zip being rebuilt, there's nothing to switch on.
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
  process.exit(0);
}
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
