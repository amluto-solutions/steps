#!/usr/bin/env bash
# Checks the Linux beta's self-update end to end (docs/spec/10-distribution.md#linux): an
# "installed" AppImage finds a newer one on a local update server, downloads it, checks its
# signature and replaces itself. Both are signed with a throwaway key made here, never Amluto's.
#
#   bash tools/linux-e2e/update.sh        (in WSL, from the repo; takes a few minutes)
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="${TMPDIR:-/tmp}/steps-update-test"
rm -rf "$work"
mkdir -p "$work/site/update" "$work/site/download"
port=8765

cd "$root/apps/desktop"
npx tauri signer generate --ci -w "$work/test.key" >/dev/null
pubkey="$(cat "$work/test.key.pub")"
updater="\"plugins\":{\"updater\":{\"pubkey\":\"$pubkey\",\"endpoints\":[\"http://127.0.0.1:$port/update/release.json\"],\"dangerousInsecureTransportProtocol\":true}}"
printf '{%s}' "$updater" >"$work/old.json"
printf '{"version":"9.9.9",%s,"bundle":{"createUpdaterArtifacts":true}}' "$updater" >"$work/new.json"

bundle="src-tauri/target/debug/bundle/appimage"
echo "▶ the installed version"
rm -rf "$bundle"
APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --debug --bundles appimage --config "$work/old.json" >"$work/build-old.log" 2>&1
cp "$bundle"/Steps_*_amd64.AppImage "$work/Steps.AppImage"

echo "▶ the new version, signed"
rm -rf "$bundle"
TAURI_SIGNING_PRIVATE_KEY="$(cat "$work/test.key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --debug --bundles appimage --config "$work/new.json" \
  >"$work/build-new.log" 2>&1
cp "$bundle/Steps_9.9.9_amd64.AppImage" "$work/site/download/new.AppImage"
signature="$(cat "$bundle/Steps_9.9.9_amd64.AppImage.sig")"
printf '{"version":"9.9.9","pub_date":"2026-10-01T09:00:00Z","platforms":{"linux-x86_64-appimage":{"signature":"%s","url":"http://127.0.0.1:%s/download/new.AppImage"}}}' \
  "$signature" "$port" >"$work/site/update/release.json"

python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/site" >"$work/server.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

cd "$root"
APPIMAGE_EXTRACT_AND_RUN=1 APP="$work/Steps.AppImage" NEW_APPIMAGE="$work/site/download/new.AppImage" \
  bash scripts/linux/with-display.sh node tools/linux-e2e/update.mjs
