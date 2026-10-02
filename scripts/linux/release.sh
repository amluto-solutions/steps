#!/usr/bin/env bash
# The Linux beta's packages for a release (docs/release-runbook.md#linux-beta), run in WSL by
# `npm run release -- vX.Y.Z --linux`, or by hand:
#
#   wsl -d Ubuntu -- bash scripts/linux/release.sh v1.2.3 /mnt/c/…/release-out/1.2.3/linux
#
# As on Windows, it never builds from a working copy: it clones the tag into a new temporary
# folder, installs from the lockfiles, runs the Rust checks on Linux, builds the .deb and the
# AppImage with locked dependencies, records tasks with the AppImage on a virtual display
# (tools/linux-e2e: a GTK window, then LibreOffice and Files), and copies the packages to the
# folder given. Anything that fails stops it; the clone is removed either way.
#
# Updates are signed with the updater key (docs/release-runbook.md#the-updater-key), passed in
# TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD (from Windows through WSLENV).
# They're taken out of the environment at once and given to the build that signs, and nothing
# else: `npm ci` runs packages' install scripts.
set -euo pipefail
signing_key="${TAURI_SIGNING_PRIVATE_KEY:-}"
signing_password="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD TAURI_SIGNING_PRIVATE_KEY_PATH
[ -n "$signing_key" ] || { echo "No updater key: the packages must be signed for updates" >&2; exit 1; }

tag="${1:?the tag to build, e.g. v1.2.3}"
out="${2:?the folder to put the packages in}"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-rc\.[0-9]+)?$ ]] || { echo "Not a release tag: $tag" >&2; exit 1; }
version="${tag#v}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.local/node/bin:$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Clones left by a release that was killed outright, once they're half a day old.
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'amluto-steps-release.*' -mmin +720 -exec rm -rf {} +
work="$(mktemp -d -t amluto-steps-release.XXXXXX)"
trap 'rm -rf "$work"' EXIT
# Ctrl+C goes through exit, so the trap above still removes the clone.
trap 'exit 130' INT TERM HUP
step() { printf '\n▶ %s\n' "$*"; }

step "clone $tag"
git clone --quiet --no-local --branch "$tag" "$repo" "$work/steps"
cd "$work/steps"
[ "$(git describe --exact-match --tags HEAD)" = "$tag" ] || { echo "HEAD isn't $tag" >&2; exit 1; }
[ -z "$(git status --porcelain --ignored)" ] || { echo "The clone isn't clean" >&2; exit 1; }

step "install from the lockfiles"
npm ci --no-fund --no-audit

step "Rust checks on Linux"
(
  cd apps/desktop/src-tauri
  cargo fmt --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  # The checks' development build is gigabytes the packages don't use.
  rm -rf target/debug
)

step "build the .deb and the AppImage, signed for updates"
printf '{"bundle":{"createUpdaterArtifacts":true}}' > "$work/updater.json"
# AppImage's own tools run extracted: WSL has no FUSE.
(
  cd apps/desktop
  TAURI_SIGNING_PRIVATE_KEY="$signing_key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$signing_password" \
    APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --config "$work/updater.json" -- --locked
)
unset signing_key signing_password
bundle=apps/desktop/src-tauri/target/release/bundle
deb="$bundle/deb/Steps_${version}_amd64.deb"
appimage="$bundle/appimage/Steps_${version}_amd64.AppImage"
[ -f "$deb" ] && [ -f "$appimage" ] || { echo "A package wasn't built" >&2; exit 1; }
[ -f "$deb.sig" ] && [ -f "$appimage.sig" ] || { echo "A package wasn't signed" >&2; exit 1; }
[ "$(dpkg-deb -f "$deb" Version)" = "$version" ] || { echo "The .deb's version isn't $version" >&2; exit 1; }

step "record tasks with the AppImage: a GTK window, LibreOffice and Files, the browsers, terminals"
for test in run apps browsers terminals; do
  APPIMAGE_EXTRACT_AND_RUN=1 APP="$work/steps/$appimage" \
    bash scripts/linux/with-display.sh node "tools/linux-e2e/$test.mjs"
done

mkdir -p "$out"
cp "$deb" "$out/amluto-steps-${version}-amd64.deb"
cp "$appimage" "$out/amluto-steps-${version}-x86_64.AppImage"
chmod +x "$out/amluto-steps-${version}-x86_64.AppImage"
# The update signatures, for release.json (they aren't published as files).
mkdir -p "$out/signatures"
cp "$deb.sig" "$out/signatures/amluto-steps-${version}-amd64.deb.sig"
cp "$appimage.sig" "$out/signatures/amluto-steps-${version}-x86_64.AppImage.sig"
echo
echo "✔ Linux packages for $version in $out"
