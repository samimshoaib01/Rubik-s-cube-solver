#!/usr/bin/env bash
#
# Builds the browser version of the solver.
#
# Requires the Emscripten SDK on PATH (emcc). Run from anywhere:
#   ./web/build.sh
#
# Outputs web/public/solver.js + solver.wasm, and the gzipped corner database.

set -euo pipefail
cd "$(dirname "$0")/.."

OUT=web/public
mkdir -p "$OUT"

echo "==> Compiling solver to WebAssembly"
emcc \
  -O3 \
  -std=c++14 \
  -I compat \
  -fexceptions \
  web/solver_wasm.cpp \
  Model/RubiksCube.cpp \
  PatternDatabases/CornerPatternDatabase.cpp \
  PatternDatabases/PatternDatabase.cpp \
  PatternDatabases/NibbleArray.cpp \
  PatternDatabases/math.cpp \
  -lembind \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createSolver \
  -s ENVIRONMENT=web,worker \
  -s FORCE_FILESYSTEM=1 \
  -s EXPORTED_RUNTIME_METHODS=FS \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=160MB \
  -s MAXIMUM_MEMORY=512MB \
  -s STACK_SIZE=8MB \
  -o "$OUT/solver.js"

echo "==> Compressing pattern database"
# 48 MB raw -> ~19.5 MB on the wire. The browser gunzips it with
# DecompressionStream and caches the result in IndexedDB, so this download
# happens once per visitor.
if [ ! -f "$OUT/cornerDepth8V1.bin.gz" ] || \
   [ Databases/cornerDepth8V1.txt -nt "$OUT/cornerDepth8V1.bin.gz" ]; then
  gzip -9 -c Databases/cornerDepth8V1.txt > "$OUT/cornerDepth8V1.bin.gz"
fi

echo
echo "Build complete:"
ls -lh "$OUT"/solver.js "$OUT"/solver.wasm "$OUT"/cornerDepth8V1.bin.gz | awk '{print "  " $9 "  " $5}'
echo
echo "Preview locally:  python3 -m http.server -d $OUT 8000"
