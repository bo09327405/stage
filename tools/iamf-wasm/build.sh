#!/usr/bin/env bash
#
# Builds public/iamf/iamf.wasm: the AOMedia IAMF reference decoder (libiamf) + its binaural renderer (OAR) + Opus,
# compiled to a standalone WebAssembly module with the C wrapper iamf_web.c.
#
# Needs: git, python >= 3.10, cmake >= 3.28, ninja, and the Emscripten SDK (https://emscripten.org) on PATH
# (source emsdk_env.sh first). Downloads (all official): github.com/AOMediaCodec/libiamf (+ its submodule
# AOMediaCodec/oar, and Abseil via CMake FetchContent), downloads.xiph.org/releases/opus/opus-1.4.tar.gz.
# AAC (fdk-aac) and FLAC are NOT built: the module decodes Opus and PCM IAMF streams.
#
#   tools/iamf-wasm/build.sh            # work dir: tools/iamf-wasm/.work (git-ignored)
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/.work}"
OUT="$HERE/../../public/iamf"
# Built and tested with libiamf commit 67eaf12 (AOM IAMF v2.0.0).
mkdir -p "$WORK" "$OUT"
command -v emcc >/dev/null || { echo "emcc not found: install the Emscripten SDK and source emsdk_env.sh"; exit 1; }

# 1. sources (only libiamf/code: the repository also holds ~5 GB of conformance test vectors we do not need)
if [ ! -d "$WORK/libiamf/.git" ]; then
  git clone --depth 1 --filter=blob:none --sparse https://github.com/AOMediaCodec/libiamf.git "$WORK/libiamf"
  git -C "$WORK/libiamf" sparse-checkout set code
fi
git -C "$WORK/libiamf" submodule update --init --recursive --depth 1
CODE="$WORK/libiamf/code"

# 2. Opus 1.4 (static, for WebAssembly) installed where libiamf looks for codecs
if [ ! -f "$CODE/dep_codecs/lib/libopus.a" ]; then
  [ -f "$WORK/opus-1.4.tar.gz" ] || curl -fsSL -o "$WORK/opus-1.4.tar.gz" https://downloads.xiph.org/releases/opus/opus-1.4.tar.gz
  tar -xzf "$WORK/opus-1.4.tar.gz" -C "$WORK"
  emcmake cmake -S "$WORK/opus-1.4" -B "$WORK/opus-build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF -DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF -DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF \
    -DCMAKE_INSTALL_PREFIX="$CODE/dep_codecs" -DCMAKE_POLICY_VERSION_MINIMUM=3.5
  cmake --build "$WORK/opus-build" && cmake --install "$WORK/opus-build"
fi

# 3. libiamf + OAR. CMAKE_FIND_ROOT_PATH is essential: under Emscripten, find_library ignores directories outside the
#    sysroot, so without it libiamf silently builds WITHOUT Opus ("The opus library was not found").
emcmake cmake -S "$CODE" -B "$WORK/iamf-build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DIAMF_BUILD_SHARED_LIB=OFF \
  -DIAMF_ENABLE_BINAURALIZER=ON -DENABLE_BUILD_CODECS=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_FIND_ROOT_PATH="$CODE/dep_codecs"
cmake --build "$WORK/iamf-build"

# 4. link everything with the wrapper into one standalone module (no JS glue: it also runs in an AudioWorklet)
LIBS=()
while IFS= read -r f; do LIBS+=("$f"); done < <(find "$WORK/iamf-build" -name '*.a')
emcc "$HERE/iamf_web.c" -O3 -I"$CODE/include" "${LIBS[@]}" "$CODE/dep_codecs/lib/libopus.a" \
  -sSTANDALONE_WASM=1 --no-entry -sDEFAULT_TO_CXX=1 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4194304 \
  -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=1073741824 -sERROR_ON_UNDEFINED_SYMBOLS=1 -Wl,--allow-multiple-definition \
  -o "$OUT/iamf.wasm"

# 5. licences that must travel with the binary
{
  echo "iamf.wasm contains software under these licences."; echo
  echo "=== libiamf and OAR (Alliance for Open Media) — BSD 3-Clause Clear License + AOM Patent License 1.0 ==="
  cat "$CODE/LICENSE"; echo; cat "$CODE/PATENTS"; echo
  echo "=== Opus 1.4 (Xiph.Org, Skype, Broadcom, Octasic, Jean-Marc Valin et al.) — BSD 3-Clause ==="
  cat "$WORK/opus-1.4/COPYING"; echo
  echo "=== Abseil (Google) — Apache License 2.0 (used by OAR's binaural renderer): https://github.com/abseil/abseil-cpp/blob/master/LICENSE ==="
} > "$OUT/LICENSES.txt"
echo "built $OUT/iamf.wasm ($(wc -c < "$OUT/iamf.wasm") bytes)"
