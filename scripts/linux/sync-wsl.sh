#!/usr/bin/env bash
# Copies this checkout (from its Windows path) into a Linux folder in WSL, for building and
# testing the Linux edition there (docs/engineering.md#linux). Build output, dependencies and
# git history stay out: the Linux folder gets its own node_modules and target.
#
#   wsl -d Ubuntu -- bash scripts/linux/sync-wsl.sh [destination, default ~/steps]
set -euo pipefail

source_dir="$(cd "$(dirname "$0")/../.." && pwd)"
destination="${1:-$HOME/steps}"
mkdir -p "$destination"
rsync -a --delete \
  --exclude .git/ \
  --exclude node_modules/ \
  --exclude target/ \
  --exclude dist/ \
  --exclude .output/ \
  --exclude .wxt/ \
  --exclude release-out/ \
  --exclude test-results/ \
  "$source_dir/" "$destination/"
# Cargo never deletes old build output; past 30 GB the Linux copy's is cleared, as `npm run check`
# does on Windows.
target="$destination/apps/desktop/src-tauri/target"
if [ -d "$target" ] && [ "$(du -s --block-size=1G "$target" | cut -f1)" -gt 30 ]; then
  echo "The Linux build folder is over 30 GB: clearing it"
  rm -rf "$target"
fi
echo "Synced to $destination"
