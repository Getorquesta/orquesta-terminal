#!/usr/bin/env bash
# Builds the manifest the in-app updater reads and attaches it to the release.
#
# `tauri build` signs every updater artifact and drops a sibling `.sig` file;
# the three release jobs upload both. This script gathers what actually made it
# onto the release and writes a latest.json pointing at those assets, so a
# platform whose job failed is simply absent from the manifest instead of
# offering an update that 404s.
#
# Usage: scripts/build-updater-manifest.sh v0.1.25
set -euo pipefail

TAG="${1:?usage: build-updater-manifest.sh <tag>}"
REPO="${GITHUB_REPOSITORY:-Getorquesta/orquesta-terminal}"
VERSION="${TAG#v}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

release_json="$workdir/release.json"
gh release view "$TAG" --repo "$REPO" \
  --json assets,body,publishedAt,createdAt > "$release_json"

assets="$(jq -r '.assets[].name' "$release_json")"

# First asset whose name matches, ignoring the .sig files themselves.
find_asset() {
  printf '%s\n' "$assets" | grep -v '\.sig$' | grep -iE "$1" | head -1
}

download_url() {
  printf 'https://github.com/%s/releases/download/%s/%s' \
    "$REPO" "$TAG" "$(jq -rn --arg s "$1" '$s|@uri')"
}

# The `.sig` holds one base64 line — exactly what the manifest's `signature` is.
read_signature() {
  local sig="$1.sig"
  printf '%s\n' "$assets" | grep -Fxq "$sig" || return 1
  gh release download "$TAG" --repo "$REPO" --pattern "$sig" \
    --dir "$workdir" --clobber >/dev/null 2>&1 || return 1
  tr -d '\r\n' < "$workdir/$sig"
}

platforms="$workdir/platforms.json"
echo '{}' > "$platforms"

# add_platform <manifest-key> <asset-name>
add_platform() {
  local key="$1" asset="$2" signature
  [ -n "$asset" ] || return 0
  if ! signature="$(read_signature "$asset")"; then
    echo "warning: $asset has no .sig on the release — skipping $key" >&2
    return 0
  fi
  jq --arg key "$key" --arg url "$(download_url "$asset")" --arg sig "$signature" \
    '.[$key] = { signature: $sig, url: $url }' "$platforms" > "$platforms.tmp"
  mv "$platforms.tmp" "$platforms"
  echo "added $key -> $asset"
}

add_platform linux-x86_64   "$(find_asset '\.AppImage$')"
add_platform windows-x86_64 "$(find_asset '\.exe$')"

# macOS ships one universal .app.tar.gz; the updater looks it up per arch.
mac_asset="$(find_asset '\.app\.tar\.gz$')"
add_platform darwin-x86_64  "$mac_asset"
add_platform darwin-aarch64 "$mac_asset"

if [ "$(jq 'length' "$platforms")" -eq 0 ]; then
  echo "error: no signed updater artifacts on $TAG — refusing to publish an empty manifest" >&2
  exit 1
fi

jq -n \
  --arg version "$VERSION" \
  --slurpfile release "$release_json" \
  --slurpfile platforms "$platforms" \
  '{
     version: $version,
     notes: ($release[0].body // ""),
     pub_date: ($release[0].publishedAt // $release[0].createdAt),
     platforms: $platforms[0]
   }' > "$workdir/latest.json"

cat "$workdir/latest.json"
gh release upload "$TAG" "$workdir/latest.json" --repo "$REPO" --clobber
