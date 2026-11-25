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

#include <emscripten/bind.h>
#include <string>
#include <vector>
#include <random>
#include <sstream>

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

EMSCRIPTEN_BINDINGS(rubiks) {
    emscripten::function("loadDatabase", &loadDatabase);
    emscripten::function("isReady", &isReady);
    emscripten::function("getFacelets", &getFacelets);
    emscripten::function("isSolved", &isSolved);
    emscripten::function("heuristic", &heuristic);
    emscripten::function("resetCube", &resetCube);
    emscripten::function("applyMoves", &applyMoves);
    emscripten::function("scramble", &scramble);
    emscripten::function("solve", &solve);
}
