#!/usr/bin/env bash
# Downloads static macOS ffmpeg & ffprobe binaries for both Apple Silicon (arm64) and Intel
# (x86_64), combines each pair into a single universal Mach-O binary with `lipo`, and verifies that
# the required encoders (libx264, aac) are present.
#
# Run by the release workflow (.github/workflows/release.yml) before bundling the macOS app so Mac
# users can record and export immediately without installing Homebrew or opening Terminal.
# `services/utility.rs` already checks `BaseDirectory::Resource/binaries/ffmpeg/{ffmpeg,ffprobe}`
# first and falls back to the system PATH if the bundled files are absent.
#
# Usage: scripts/bundle-macos-ffmpeg.sh <output-dir> [work-dir]
set -euo pipefail

OUT="${1:?Usage: scripts/bundle-macos-ffmpeg.sh <output-dir> [work-dir]}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="${2:-$(mktemp -d)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "scripts/bundle-macos-ffmpeg.sh must be run on macOS (needs lipo)." >&2
  exit 1
fi

BASE_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos"

fetch_tool() { # <arch: arm64|amd64> <tool: ffmpeg|ffprobe>
  local arch="$1"
  local tool="$2"
  local zip="$WORK/${tool}-${arch}.zip"
  local dest="$WORK/${tool}-${arch}"
  mkdir -p "$dest"
  curl --location --fail --silent --show-error --retry 3 --retry-delay 2 \
    -o "$zip" "${BASE_URL}/${arch}/release/${tool}.zip"
  unzip -qo "$zip" -d "$dest"
  if [ ! -f "$dest/$tool" ]; then
    echo "Expected $dest/$tool after unzipping ${zip}" >&2
    exit 1
  fi
}

for tool in ffmpeg ffprobe; do
  fetch_tool arm64 "$tool"
  fetch_tool amd64 "$tool"
  lipo -create "$WORK/${tool}-arm64/${tool}" "$WORK/${tool}-amd64/${tool}" -output "$OUT/${tool}"
  chmod +x "$OUT/${tool}"
  lipo -info "$OUT/${tool}"
done

# Sanity check: executable runs on this runner and includes the encoders ffmpeg_check.rs requires.
"$OUT/ffmpeg" -hide_banner -version | head -2
encoders="$("$OUT/ffmpeg" -hide_banner -encoders)"
for enc in libx264 aac; do
  if ! grep -qw "$enc" <<<"$encoders"; then
    echo "Bundled macOS ffmpeg is missing required encoder: $enc" >&2
    exit 1
  fi
done
du -sh "$OUT" | awk '{print "bundled macOS ffmpeg size: " $1}'
