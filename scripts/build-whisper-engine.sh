#!/usr/bin/env bash
# Builds Briefcast's speech engine - whisper.cpp's `whisper-cli` - for macOS and Linux, so captions,
# editing by transcript and filler-word removal work there as they do on Windows (the Windows
# installer carries the official whisper.cpp release's Windows build; that project publishes no
# binaries for the other two). Run by the release workflow (.github/workflows/release.yml) before
# it bundles the app, and runnable by hand to test.
#
# The version is pinned to the one the Windows bundle uses (THIRD-PARTY-NOTICES.txt), because the
# app relies on its command line: --vad / -vm, --prompt, -oj with -ml 1 -sow, -ovtt. Change it
# there, here and in the notices together.
#
#   Linux  - shared libraries with the CPU backend as run-time-selected variants (AVX2, AVX-512,
#            ...), found next to the executable ($ORIGIN) - the same layout as the Windows bundle,
#            so it uses the best instructions each machine has instead of -march=native (which
#            would only run on the machine that built it).
#   macOS  - one static universal executable: Apple Silicon (with Metal and Accelerate) and Intel
#            (AVX2), joined with lipo. No dylibs to carry or sign separately.
#
# Requirements: git, CMake, a C++ compiler (Xcode's on macOS), make.
#
# Usage: scripts/build-whisper-engine.sh <output-dir> [work-dir]
# Output: <output-dir>/whisper-cli (plus lib*.so files on Linux) - src-tauri/binaries/whisper,
# which the release workflow bundles (through a config overlay, only when this succeeded). The speech model itself is not part
# of it: the app downloads it the first time it is needed (services/whisper_model.rs).
set -euo pipefail

VERSION="v1.9.3"
REPO="https://github.com/ggml-org/whisper.cpp.git"

OUT="${1:?Usage: scripts/build-whisper-engine.sh <output-dir> [work-dir]}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="${2:-$(mktemp -d)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"

if [ ! -d "$WORK/whisper.cpp" ]; then
  git clone --quiet --depth 1 --branch "$VERSION" "$REPO" "$WORK/whisper.cpp"
fi
SRC="$WORK/whisper.cpp"

COMMON=(-DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_NATIVE=OFF)

build() { # <build-dir> <cmake options...>
  local dir="$1"
  shift
  cmake -S "$SRC" -B "$dir" "${COMMON[@]}" "$@" >"$dir.configure.log" 2>&1 || { tail -30 "$dir.configure.log"; exit 1; }
  cmake --build "$dir" --target whisper-cli -j "$JOBS" >"$dir.build.log" 2>&1 || { tail -40 "$dir.build.log"; exit 1; }
}

case "$(uname -s)" in
  Linux)
    BUILD="$WORK/build-linux"
    build "$BUILD" -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON '-DCMAKE_INSTALL_RPATH=$ORIGIN'
    # Real files under the names the executable asks for (a resource copy doesn't keep symlinks).
    cp "$BUILD/bin/whisper-cli" "$OUT/whisper-cli"
    find "$BUILD" \( -name 'libwhisper.so*' -o -name 'libggml*.so*' \) \( -type f -o -type l \) -print0 |
      while IFS= read -r -d '' lib; do cp -L "$lib" "$OUT/$(basename "$lib")"; done
    ;;
  Darwin)
    build "$WORK/build-arm64" -DBUILD_SHARED_LIBS=OFF -DGGML_BACKEND_DL=OFF -DCMAKE_OSX_ARCHITECTURES=arm64 \
      -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
    build "$WORK/build-x86_64" -DBUILD_SHARED_LIBS=OFF -DGGML_BACKEND_DL=OFF -DCMAKE_OSX_ARCHITECTURES=x86_64 \
      -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 -DGGML_METAL=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON
    lipo -create "$WORK/build-arm64/bin/whisper-cli" "$WORK/build-x86_64/bin/whisper-cli" -output "$OUT/whisper-cli"
    lipo -info "$OUT/whisper-cli"
    ;;
  *)
    echo "This builds the speech engine for macOS and Linux; Windows bundles the official release." >&2
    exit 1
    ;;
esac

chmod +x "$OUT/whisper-cli"
# It has to start from where it will be bundled: the Linux build finds its libraries and CPU
# variants next to itself.
"$OUT/whisper-cli" --version 2>&1 | grep -v '^load_backend' | head -3
du -sh "$OUT" | awk '{print "engine size: " $1}'
