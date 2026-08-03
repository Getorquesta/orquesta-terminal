#!/usr/bin/env bash
set -e

echo "Installing Tauri system dependencies for Linux..."

# A broken third-party repo (bad GPG key, unreachable host) must not block us —
# the packages below usually resolve from the lists already on disk.
sudo apt-get update -qq || echo "apt-get update failed; continuing with cached package lists"

sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libdbus-1-dev \
  libssl-dev \
  pkg-config \
  patchelf

echo "Done. Run: cargo check"
