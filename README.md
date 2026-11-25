# Rubik's Cube Solver

An **optimal** Rubik's Cube solver in C++ — Korf's IDA\* guided by a corner
pattern database covering all 100,179,840 corner configurations. Because the
heuristic never overestimates, the first solution found is provably the
shortest one that exists.

**[▶ Try the live demo](https://samimshoaib01.github.io/Rubik-s-cube-solver/)**
— the solver compiled to WebAssembly, running in your browser.

---

## What's in here

| Component | Where | Notes |
|---|---|---|
| Cube models | `Model/` | Three interchangeable representations: 1D array, 3D array, bitboard |
| Solvers | `Solver/` | BFS, DFS, IDDFS, IDA\*, and a multithreaded IDA\* |
| Pattern database | `PatternDatabases/` | Nibble-packed table + Lehmer-code ranking |
| Webcam scanner | `Scanner/` | OpenCV HSV sticker detection |
| Browser demo | `web/` | Emscripten bindings + three.js front-end |

### The cube model

The bitboard representation stores one 64-bit word per face, eight bits per
sticker position, so a face turn reduces to a few shifts and masks rather than
copying arrays around. All three models implement the same `RubiksCube`
interface, which made it possible to benchmark them against identical solvers.

### The search

BFS and IDDFS are exhaustive and stall past roughly depth 8 — the branching
factor is 18 and the state space is 4.3 × 10¹⁹. IDA\* fixes this by bounding a
depth-first search with an admissible heuristic and raising the bound until a
solution appears.

The heuristic is a **corner pattern database**: the exact number of moves to
solve the eight corners, for every one of their 100,179,840
permutation-and-orientation states, computed once by breadth-first search and
stored to disk. Corner distance is a lower bound on full-cube distance, so it
is admissible.

Storing one byte per state would need 96 MB. Since no entry exceeds 11, four
bits are enough, so `NibbleArray` packs two states per byte and the table fits
in **48 MB** — eight times smaller than a 32-bit lookup table. States are
addressed by **Lehmer-code ranking**, which maps a permutation to its index in
lexicographic order with no gaps, so the array has no wasted slots.

### Parallelism

`IDAstarSolverMT` splits the 18 root moves across one thread per core. Each
thread runs an independent DFS over its own cube copy — no shared mutable state
and therefore no locking — and the first to find a solution flips an atomic flag
the others poll. Measured at **8–10× faster** than the single-threaded search on
a 10-core M4.

### Scanning a physical cube

`--scan` opens a webcam feed, samples a 3×3 grid of sticker centres per face,
converts to HSV and classifies each by hue band. Saturation and value
thresholds separate white from the coloured stickers, which hue alone cannot do.
The scan is validated (nine of each colour) before being handed to the solver.

## Building

### Desktop

Requires CMake 3.31+, a C++14 compiler and OpenCV.

```bash
cmake -B build && cmake --build build

./build/rubiks_cube_solver          # random scramble, then solve
./build/rubiks_cube_solver --scan   # scan a real cube over webcam
```

### Browser

Requires the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html).

```bash
./web/build.sh
python3 -m http.server -d web/public 8000
```

Pushing to `master` rebuilds and redeploys the demo automatically via
`.github/workflows/deploy-demo.yml`.

The browser build differs from the desktop one in two ways: it is
single-threaded, because shared-memory threads need COOP/COEP response headers
that GitHub Pages cannot set; and it loads the 48 MB database over the network
(19.5 MB gzipped, then cached in IndexedDB) instead of from disk.

## Performance

Single-threaded, Apple M4, optimal solutions:

| Scramble depth | Typical | Worst observed |
|---|---|---|
| 8 moves | < 3 ms | 3 ms |
| 10 moves | ~30 ms | 3.6 s |
| 12 moves | ~600 ms | 1.4 s |

Times vary by orders of magnitude at the same depth: a scramble whose corners
happen to be nearly solved gives the heuristic little to work with, so the
search explores far more of the tree.
