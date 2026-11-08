#!/usr/bin/env bash
# Builds the Windows voice/music separation engine that Briefcast downloads on first use
# (src-tauri/src/commands/audio_tracks.rs, EXE_V3_ASSET / EXE_V2_ASSET).
#
# demucs.cpp (https://github.com/sevagh/demucs.cpp) publishes no Windows binaries, so we build
# demucs_mt.cpp.main ourselves:
#   - Eigen + OpenBLAS (prebuilt static libopenblas.a from OpenBLAS's own GitHub release) + OpenMP.
#   - Fully static: the result depends only on KERNEL32 and the Universal CRT that ships with
#     Windows 10+, so it runs on a machine with no MinGW installed.
#   - Two CPU levels instead of upstream's -march=native (which would only run on the build
#     machine): x86-64-v3 (AVX2/FMA) and an x86-64-v2 fallback. The app picks one at download time.
#
# Requirements (Git Bash on Windows): git, curl, unzip, CMake, MinGW-w64 UCRT gcc/g++ with
# OpenMP (e.g. WinLibs).
#
# Usage: scripts/build-demucs-engine.sh [work-dir]
# Output: <work-dir>/dist/demucs_mt-win-x64-v3.exe and demucs_mt-win-x64-v2.exe, plus their sizes
# and SHA-256. Paste those into audio_tracks.rs, then upload both files to the matching GitHub
# release (a rebuild changes the hashes, so use a new tag and update the URLs too).
set -euo pipefail

WORK="$(mkdir -p "${1:-build-demucs}" && cd "${1:-build-demucs}" && pwd)"
OPENBLAS_VERSION="0.3.34"
MINGW_ROOT="$(dirname "$(dirname "$(command -v gcc)")")"

cd "$WORK"

if [ ! -d demucs.cpp ]; then
  git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/sevagh/demucs.cpp
  cd demucs.cpp
  # Make the arch flags configurable, and drop the googletest target we don't need.
  sed -i 's/-Ofast -march=native /-Ofast ${DEMUCS_ARCH_FLAGS} /' CMakeLists.txt
  sed -i 's|^add_subdirectory(vendor/googletest)|#&|; s|^add_executable(demucs.cpp.test|#&|; s|^target_link_libraries(demucs.cpp.test|#&|; s|^add_test(|#&|' CMakeLists.txt
  # std::filesystem::path is wide on Windows and doesn't convert implicitly to std::string.
  sed -i 's/write_audio_file(target_waveform, p_target);/write_audio_file(target_waveform, p_target.string());/' cli-apps/demucs_mt.cpp
  cd ..
fi

if [ ! -f openblas/lib/libopenblas.a ]; then
  curl -sL -o openblas.zip "https://github.com/OpenMathLib/OpenBLAS/releases/download/v${OPENBLAS_VERSION}/OpenBLAS-${OPENBLAS_VERSION}-x64.zip"
  mkdir -p openblas && unzip -q -o openblas.zip -d openblas
fi

# OpenBLAS's static lib was built against the MSVC runtime and calls _cprintf (only for error
# messages) through a dllimport thunk that MinGW's UCRT import libs don't provide.
cat > cprintf_shim.c <<'EOF'
#include <stdio.h>
#include <stdarg.h>
static int shim_cprintf(const char *fmt, ...) { va_list ap; va_start(ap, fmt); int r = vfprintf(stderr, fmt, ap); va_end(ap); return r; }
int (*__imp__cprintf)(const char *, ...) = shim_cprintf;
EOF
gcc -O2 -c cprintf_shim.c -o cprintf_shim.o

mkdir -p dist
cd demucs.cpp
for level in v3 v2; do
  # -include intrin.h: the vendored WavPack calls MSVC's _BitScanForward/_BitScanReverse on
  # Windows without including <intrin.h>; GCC 14+ makes that implicit declaration a hard error.
  # OpenMP_gomp/dl_LIBRARY: CMake's FindOpenMP picks the DLL import libs by default, which would
  # leave libgomp-1.dll/libdl.dll as runtime dependencies.
  cmake -S . -B "build-$level" -G "MinGW Makefiles" \
    -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ \
    -DUSE_OPENBLAS=ON -DBLA_VENDOR=OpenBLAS \
    "-DBLAS_LIBRARIES=$WORK/openblas/lib/libopenblas.a;$WORK/cprintf_shim.o" \
    -DCMAKE_BUILD_TYPE=Release \
    "-DDEMUCS_ARCH_FLAGS=-march=x86-64-$level -mtune=generic -fopenmp" \
    "-DCMAKE_C_FLAGS=-include intrin.h" \
    "-DCMAKE_EXE_LINKER_FLAGS=-static -static-libgcc -static-libstdc++ -fopenmp" \
    "-DOpenMP_gomp_LIBRARY=$MINGW_ROOT/lib/libgomp.a" \
    "-DOpenMP_dl_LIBRARY=$MINGW_ROOT/x86_64-w64-mingw32/lib/libdl.a" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5
  cmake --build "build-$level" --target demucs_mt.cpp.main -j "$(nproc)"
  cp "build-$level/demucs_mt.cpp.main.exe" "../dist/demucs_mt-win-x64-$level.exe"
done

cd ../dist
strip --strip-all demucs_mt-win-x64-v3.exe demucs_mt-win-x64-v2.exe
for f in demucs_mt-win-x64-v3.exe demucs_mt-win-x64-v2.exe; do
  extra_dlls="$(objdump -p "$f" | grep 'DLL Name' | grep -v -i 'api-ms-win-crt\|KERNEL32' || true)"
  if [ -n "$extra_dlls" ]; then
    echo "ERROR: $f is not self-contained:" >&2
    echo "$extra_dlls" >&2
    exit 1
  fi
  echo "$f  size=$(stat -c %s "$f")  sha256=$(sha256sum "$f" | cut -d' ' -f1)"
done
