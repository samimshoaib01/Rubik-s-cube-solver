//
// solver_wasm.cpp — Emscripten entry point for the browser build.
//
// Wraps the existing cube model and corner pattern database in a small C API
// exposed to JavaScript. The desktop build (main.cpp) is untouched; this file
// only replaces the CLI front-end and the OpenCV scanner, neither of which has
// a meaning in the browser.
//
// Two deliberate differences from the desktop solver:
//   1. Single-threaded. SharedArrayBuffer needs COOP/COEP response headers,
//      which GitHub Pages cannot set, so pthreads are off the table.
//   2. Plain recursive IDA* (the IDAstarSolverMT strategy minus the threads)
//      instead of IDAstarSolver's priority_queue + unordered_map. The queue
//      version memoises every visited state, which costs hundreds of MB on a
//      deep scramble — fine on a laptop, fatal in a browser tab.
//

#if defined(__EMSCRIPTEN_PTHREADS__) || !defined(__EMSCRIPTEN__)
#define SOLVER_HAS_THREADS 1
#else
#define SOLVER_HAS_THREADS 0
#endif

#include <emscripten/bind.h>
#include <string>
#include <vector>
#include <random>
#include <sstream>
#include <climits>
#if SOLVER_HAS_THREADS
#include <thread>
#include <atomic>
#include <mutex>
#endif

#include "../Model/RubiksCubeBitboard.cpp"
#include "../PatternDatabases/CornerPatternDatabase.h"

using MOVE = RubiksCube::MOVE;

namespace {

CornerPatternDatabase *g_db = nullptr;
RubiksCubeBitboard g_cube;

// ── Move <-> string ──────────────────────────────────────────────────────────

bool parseMove(const std::string &tok, MOVE &out) {
    for (int i = 0; i < 18; i++) {
        if (RubiksCube::getMove(MOVE(i)) == tok) {
            out = MOVE(i);
            return true;
        }
    }
    return false;
}

std::string movesToString(const std::vector<MOVE> &moves) {
    std::string s;
    for (size_t i = 0; i < moves.size(); i++) {
        if (i) s += ' ';
        s += RubiksCube::getMove(moves[i]);
    }
    return s;
}

// ── IDA* search ──────────────────────────────────────────────────────────────
//
// `lastFace` carries the face index (move/3) of the previous move so we can
// skip consecutive turns of the same face. Those are always reducible to a
// single turn, so pruning them keeps the search optimal while cutting the
// branching factor from 18 to 15.

bool dfs(RubiksCubeBitboard &cube, int g, int bound, int lastFace,
         std::vector<MOVE> &path, int &nextBound) {

    int h = (int) g_db->getNumMoves(cube);
    int f = g + h;

    if (f > bound) {
        if (f < nextBound) nextBound = f;
        return false;
    }
    if (cube.isSolved()) return true;

    for (int i = 0; i < 18; i++) {
        if (i / 3 == lastFace) continue;

        MOVE m = MOVE(i);
        cube.move(m);
        path.push_back(m);

        if (dfs(cube, g + 1, bound, i / 3, path, nextBound)) return true;

        path.pop_back();
        cube.invert(m);
    }
    return false;
}

} // namespace

// ── Exported API ─────────────────────────────────────────────────────────────

// Loads the nibble-packed corner database from a path in Emscripten's in-memory
// filesystem. JS fetches + gunzips the file and writes it to MEMFS first, which
// lets PatternDatabase::fromFile stay exactly as it is on desktop.
bool loadDatabase(const std::string &path) {
    if (g_db) delete g_db;
    g_db = new CornerPatternDatabase();
    return g_db->fromFile(path);
}

// Loads the database from a buffer the JS side has already written into the
// WebAssembly heap. Avoids staging 48 MB through MEMFS, which meant holding the
// table twice and pushing every byte through the emulated filesystem.
bool loadDatabaseFromMemory(uintptr_t ptr, size_t len) {
    if (g_db) delete g_db;
    g_db = new CornerPatternDatabase();
    if (!g_db->fromMemory(reinterpret_cast<const uint8_t *>(ptr), len)) {
        delete g_db;
        g_db = nullptr;
        return false;
    }
    return true;
}

bool isReady() { return g_db != nullptr; }

// 54 colour letters, face order U L F R B D, each face read row-major.
std::string getFacelets() {
    static const RubiksCube::FACE order[6] = {
        RubiksCube::FACE::UP, RubiksCube::FACE::LEFT, RubiksCube::FACE::FRONT,
        RubiksCube::FACE::RIGHT, RubiksCube::FACE::BACK, RubiksCube::FACE::DOWN
    };
    std::string s;
    s.reserve(54);
    for (int f = 0; f < 6; f++)
        for (unsigned r = 0; r < 3; r++)
            for (unsigned c = 0; c < 3; c++)
                s += RubiksCube::getColorLetter(g_cube.getColor(order[f], r, c));
    return s;
}

// ── Loading a scanned cube ───────────────────────────────────────────────────
//
// Takes the same 54 colour letters getFacelets() produces: faces in the order
// U L F R B D, each read row-major. Mirrors buildCubeFromScan in main.cpp,
// which does this for the OpenCV scanner on the desktop side.
//
// Returns an empty string on success, or a human-readable reason it was
// rejected. A scan with a misread sticker is the normal case, not an
// exceptional one, so the caller gets told what was wrong rather than throwing.

static bool colorFromLetter(char c, RubiksCube::COLOR &out) {
    switch (c) {
        case 'W': out = RubiksCube::COLOR::WHITE;  return true;
        case 'G': out = RubiksCube::COLOR::GREEN;  return true;
        case 'R': out = RubiksCube::COLOR::RED;    return true;
        case 'B': out = RubiksCube::COLOR::BLUE;   return true;
        case 'O': out = RubiksCube::COLOR::ORANGE; return true;
        case 'Y': out = RubiksCube::COLOR::YELLOW; return true;
        default:  return false;
    }
}

std::string setFacelets(const std::string &facelets) {
    if (facelets.size() != 54)
        return "Expected 54 stickers, got " + std::to_string(facelets.size());

    RubiksCube::COLOR parsed[54];
    int count[6] = {0, 0, 0, 0, 0, 0};

    for (int i = 0; i < 54; i++) {
        if (!colorFromLetter(facelets[i], parsed[i]))
            return std::string("Unknown colour '") + facelets[i] + "' at sticker " + std::to_string(i);
        count[(int) parsed[i]]++;
    }

    for (int c = 0; c < 6; c++) {
        if (count[c] != 9) {
            static const char *names[6] = {"white", "green", "red", "blue", "orange", "yellow"};
            return std::string("Found ") + std::to_string(count[c]) + " " + names[c] +
                   " stickers, expected 9";
        }
    }

    // Centres are fixed by the cube's construction and define each face, so a
    // scan whose centres disagree with the model has been read in the wrong
    // orientation. Checking here gives a clearer error than an unsolvable cube.
    static const char expectedCentres[6] = {'W', 'G', 'R', 'B', 'O', 'Y'};
    for (int f = 0; f < 6; f++) {
        if (facelets[f * 9 + 4] != expectedCentres[f]) {
            static const char *faceNames[6] = {"U", "L", "F", "R", "B", "D"};
            return std::string("Face ") + faceNames[f] + " has a " + facelets[f * 9 + 4] +
                   " centre, expected " + expectedCentres[f] + " — faces scanned out of order?";
        }
    }

    // Same layout as buildCubeFromScan: eight bits per position, position 8 is
    // the centre and stays implicit.
    static const int posMap[3][3] = {{0, 1, 2}, {7, 8, 3}, {6, 5, 4}};

    RubiksCubeBitboard cube;
    for (int f = 0; f < 6; f++) cube.bitboard[f] = 0;

    for (int face = 0; face < 6; face++) {
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 3; col++) {
                int pos = posMap[row][col];
                if (pos == 8) continue;   // centre is implicit

                uint64_t colorBit = (uint64_t) (1 << (int) parsed[face * 9 + row * 3 + col]);
                cube.bitboard[face] |= (colorBit << (8 * pos));
            }
        }
    }

    g_cube = cube;
    return "";
}

bool isSolved() { return g_cube.isSolved(); }

// The pattern database's distance-to-solved for the current state. Because the
// heuristic is admissible this is a guaranteed lower bound on the real answer,
// which makes it a useful thing to show next to the solution length.
int heuristic() { return g_db ? (int) g_db->getNumMoves(g_cube) : -1; }

void resetCube() { g_cube = RubiksCubeBitboard(); }

// Applies a space-separated move sequence. Returns false (and stops) on the
// first token that isn't valid notation.
bool applyMoves(const std::string &seq) {
    std::istringstream in(seq);
    std::string tok;
    while (in >> tok) {
        MOVE m;
        if (!parseMove(tok, m)) return false;
        g_cube.move(m);
    }
    return true;
}

// Scrambles from the current state and returns the moves applied.
std::string scramble(int n) {
    static std::mt19937 rng(std::random_device{}());
    std::uniform_int_distribution<int> pick(0, 17);

    std::vector<MOVE> applied;
    int lastFace = -1;
    for (int i = 0; i < n; i++) {
        int idx;
        do { idx = pick(rng); } while (idx / 3 == lastFace);
        lastFace = idx / 3;
        MOVE m = MOVE(idx);
        g_cube.move(m);
        applied.push_back(m);
    }
    return movesToString(applied);
}

// Runs IDA* on the current state and returns the optimal solution as notation.
// The cube is left solved. Returns "!" if no database is loaded.
std::string solve() {
    if (!g_db) return "!";
    if (g_cube.isSolved()) return "";

    int bound = (int) g_db->getNumMoves(g_cube);
    std::vector<MOVE> path;

    while (true) {
        int nextBound = 1000;
        path.clear();
        RubiksCubeBitboard work = g_cube;

        if (dfs(work, 0, bound, -1, path, nextBound)) break;
        if (nextBound == 1000) return "!";
        bound = nextBound;
    }

    for (MOVE m : path) g_cube.move(m);
    return movesToString(path);
}


// ── Multithreaded search ─────────────────────────────────────────────────────
//
// Same strategy as the desktop IDAstarSolverMT: the 18 root moves are dealt out
// to N threads, each of which runs an independent DFS over its own copy of the
// cube. There is no shared mutable state in the hot loop, so no locking — the
// only coordination is an atomic flag the threads poll to stop once one of them
// has an answer.
//
// Optimality survives the parallelism. Within one bound iteration every
// solution has length exactly `bound`: nothing shorter can exist, or the
// previous iteration would have returned it, and nothing longer can be reached,
// because f > bound is pruned. So it does not matter which thread wins the race.

#if SOLVER_HAS_THREADS
namespace {

bool dfsMT(RubiksCubeBitboard &cube, int g, int bound, int lastFace,
           std::vector<MOVE> &path, int &nextBound,
           const std::atomic<bool> &found) {

    if (found.load(std::memory_order_relaxed)) return false;

    int h = (int) g_db->getNumMoves(cube);
    int f = g + h;

    if (f > bound) {
        if (f < nextBound) nextBound = f;
        return false;
    }
    if (cube.isSolved()) return true;

    for (int i = 0; i < 18; i++) {
        if (i / 3 == lastFace) continue;

        MOVE m = MOVE(i);
        cube.move(m);
        path.push_back(m);

        if (dfsMT(cube, g + 1, bound, i / 3, path, nextBound, found)) return true;

        path.pop_back();
        cube.invert(m);
    }
    return false;
}

void atomicMin(std::atomic<int> &target, int value) {
    int prev = target.load();
    while (value < prev && !target.compare_exchange_weak(prev, value)) {}
}

} // namespace

// Usable thread count: one per core, but never more than the preallocated
// pthread pool holds.
//
// Browser threads cannot be conjured on demand. pthread_create needs a Worker,
// Worker creation is asynchronous, and pthread_create is not, so Emscripten
// hands out threads from a pool fixed at build time. Asking for more than the
// pool has does not fail — it blocks forever waiting for one to come free.
// That is a deadlock, and it is why a 10-core machine hung where a 7-core one
// was fine.
//
// SOLVER_PTHREAD_POOL is defined by web/build.sh from the same variable it
// passes to -s PTHREAD_POOL_SIZE, so the two cannot drift apart.
#ifndef SOLVER_PTHREAD_POOL
#define SOLVER_PTHREAD_POOL 18
#endif

int maxThreads() {
    unsigned n = std::thread::hardware_concurrency();
    if (n == 0) n = 4;

    unsigned cap = SOLVER_PTHREAD_POOL;   // never oversubscribe the pool
    if (cap > 18u) cap = 18u;             // 18 root moves is all the work there is
    return (int) (n < cap ? n : cap);
}

std::string solveMT(int numThreads) {
    if (!g_db) return "!";
    if (g_cube.isSolved()) return "";
    if (numThreads < 1) numThreads = 1;
    if (numThreads > maxThreads()) numThreads = maxThreads();

    int bound = (int) g_db->getNumMoves(g_cube);
    std::vector<MOVE> result;

    for (;;) {
        std::atomic<bool> found(false);
        std::atomic<int> nextBound(INT_MAX);
        std::mutex resultMutex;
        std::vector<std::thread> pool;

        for (int t = 0; t < numThreads; t++) {
            pool.emplace_back([&, t]() {
                int localNext = INT_MAX;

                // Thread t takes root moves t, t+N, t+2N, ...
                for (int i = t; i < 18; i += numThreads) {
                    if (found.load(std::memory_order_relaxed)) break;

                    RubiksCubeBitboard cube = g_cube;
                    cube.move(MOVE(i));

                    std::vector<MOVE> path;
                    path.push_back(MOVE(i));

                    if (dfsMT(cube, 1, bound, i / 3, path, localNext, found)) {
                        std::lock_guard<std::mutex> lk(resultMutex);
                        if (!found.exchange(true)) result = path;
                        break;
                    }
                }
                atomicMin(nextBound, localNext);
            });
        }
        for (auto &th : pool) th.join();

        if (found.load()) {
            for (MOVE m : result) g_cube.move(m);
            return movesToString(result);
        }
        int nb = nextBound.load();
        if (nb == INT_MAX) return "!";
        bound = nb;
    }
}
#else
int maxThreads() { return 1; }
std::string solveMT(int) { return solve(); }
#endif

EMSCRIPTEN_BINDINGS(rubiks) {
    emscripten::function("loadDatabase", &loadDatabase);
    emscripten::function("loadDatabaseFromMemory", &loadDatabaseFromMemory);
    emscripten::function("isReady", &isReady);
    emscripten::function("getFacelets", &getFacelets);
    emscripten::function("setFacelets", &setFacelets);
    emscripten::function("isSolved", &isSolved);
    emscripten::function("heuristic", &heuristic);
    emscripten::function("resetCube", &resetCube);
    emscripten::function("applyMoves", &applyMoves);
    emscripten::function("scramble", &scramble);
    emscripten::function("solve", &solve);
    emscripten::function("solveMT", &solveMT);
    emscripten::function("maxThreads", &maxThreads);
}
