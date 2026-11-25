#!/usr/bin/env bash
#
# Builds the browser version of the solver.
#
# Requires the Emscripten SDK on PATH (emcc). Run from anywhere:
#   ./web/build.sh
#
# Produces two WebAssembly builds:
#   solver.js    — single-threaded, works everywhere
#   solver-mt.js — pthreads, needs SharedArrayBuffer (see coi-serviceworker.js)
#
# The page picks between them at runtime based on `crossOriginIsolated`, so a
# browser that refuses isolation still gets a working solver.

set -euo pipefail
cd "$(dirname "$0")/.."

OUT=web/public
mkdir -p "$OUT"

SOURCES=(
  web/solver_wasm.cpp
  Model/RubiksCube.cpp
  PatternDatabases/CornerPatternDatabase.cpp
  PatternDatabases/PatternDatabase.cpp
  PatternDatabases/NibbleArray.cpp
  PatternDatabases/math.cpp
)

COMMON=(
  -O3 -std=c++14 -I compat -fexceptions
  -s MODULARIZE=1
  -s ENVIRONMENT=web,worker
  -s FORCE_FILESYSTEM=1
  -s EXPORTED_RUNTIME_METHODS=FS
  -lembind
)

echo "==> Building single-threaded solver"
emcc "${SOURCES[@]}" "${COMMON[@]}" \
  -s EXPORT_NAME=createSolver \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=160MB \
  -s MAXIMUM_MEMORY=512MB \
  -s STACK_SIZE=8MB \
  -o "$OUT/solver.js"

echo "==> Building multithreaded solver"
# Shared memory cannot grow cheaply, so this build takes a fixed heap instead:
# 48 MB database + 48 MB transient MEMFS copy + 8 x 2 MB thread stacks, with
# room to spare. The pool is preallocated at startup because pthread_create
# cannot block waiting for a Worker to spin up, so the threads have to exist
# before the search asks for them.
emcc "${SOURCES[@]}" "${COMMON[@]}" \
  -pthread \
  -s EXPORT_NAME=createSolverMT \
  -s PTHREAD_POOL_SIZE=8 \
  -s DEFAULT_PTHREAD_STACK_SIZE=2MB \
  -s INITIAL_MEMORY=256MB \
  -s STACK_SIZE=8MB \
  -o "$OUT/solver-mt.js"

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
ls -lh "$OUT"/solver.js "$OUT"/solver.wasm "$OUT"/solver-mt.js "$OUT"/solver-mt.wasm \
       "$OUT"/cornerDepth8V1.bin.gz | awk '{print "  " $9 "  " $5}'
echo
echo "Preview locally:  python3 -m http.server -d $OUT 8000"
