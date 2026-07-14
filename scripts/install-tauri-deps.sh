#!/usr/bin/env bash
set -e

echo "Installing Tauri system dependencies for Linux..."

sudo apt-get update -qq

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
