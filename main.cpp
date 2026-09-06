//
// Rubik's Cube Solver — Demo
// Author: Shoaib Samim
//
// Usage:
//   ./rubiks_cube_solver               — random scramble + solve
//   ./rubiks_cube_solver --scan        — scan physical cube via webcam + solve
//   ./rubiks_cube_solver [db_path]     — use custom database path
//

#include <bits/stdc++.h>
#include "Model/RubiksCubeBitboard.cpp"
#include "Solver/IDAstarSolver.h"
#include "Solver/IDAstarSolverMT.h"
#include "PatternDatabases/CornerDBMaker.h"
#include "Scanner/CubeScanner.h"

using namespace std;

// ── Helpers ──────────────────────────────────────────────────────────────────

static void printSeparator(const string &title) {
    cout << "\n========================================\n";
    cout << "  " << title << "\n";
    cout << "========================================\n";
}

static void printMoves(const vector<RubiksCube::MOVE> &moves) {
    if (moves.empty()) { cout << "(none — already solved)\n"; return; }
    for (auto m : moves) cout << RubiksCube::getMove(m) << " ";
    cout << "\n";
}

// ── Build RubiksCubeBitboard from a 54-element scanned colour array ──────────
//
// faceColors layout: [face 0..5][sticker 0..8], where
//   face 0=UP  1=LEFT  2=FRONT  3=RIGHT  4=BACK  5=DOWN
//   sticker index = row*3 + col  (row 0=top, col 0=left)
//
// RubiksCubeBitboard bitboard layout per face:
//   positions 0-7 around the face (clockwise from top-left), position 8 = centre
//   arr mapping:  row,col -> position
//     (0,0)->0  (0,1)->1  (0,2)->2
//     (1,0)->7  (1,1)->8  (1,2)->3
//     (2,0)->6  (2,1)->5  (2,2)->4
//   Each position occupies 8 bits; bit k set means colour k.
//
static RubiksCubeBitboard buildCubeFromScan(
        const array<RubiksCube::COLOR, 54> &fc) {

    // Position lookup: pos = posMap[row][col]
    static const int posMap[3][3] = {{0,1,2},{7,8,3},{6,5,4}};

    RubiksCubeBitboard cube;
    // Clear all bitboards (we'll fill every position from scan data)
    for (int f = 0; f < 6; f++) cube.bitboard[f] = 0;

    for (int face = 0; face < 6; face++) {
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 3; col++) {
                int pos   = posMap[row][col];
                RubiksCube::COLOR c = fc[face * 9 + row * 3 + col];
                uint64_t colorBit = (uint64_t)(1 << (int)c);

                if (pos == 8) {
                    // Centre position is implicit in the bitboard (not stored),
                    // but we can verify it matches the face's expected colour.
                    continue;
                }
                // Place colour bit in the correct 8-bit slot
                cube.bitboard[face] |= (colorBit << (8 * pos));
            }
        }
    }
    return cube;
}

// ── Validate that the 54 scanned colours form a valid cube ───────────────────
static bool validateScan(const array<RubiksCube::COLOR, 54> &fc) {
    int count[6] = {0};
    for (auto c : fc) count[(int)c]++;
    for (int i = 0; i < 6; i++) {
        if (count[i] != 9) {
            cerr << "[Validate] Color " << i << " appears " << count[i]
                 << " times (expected 9).\n";
            return false;
        }
    }
    return true;
}

// ── Solve and print ───────────────────────────────────────────────────────────
static void solveAndPrint(RubiksCubeBitboard &cube, const string &dbPath,
                          bool fast = false) {
    int nThreads = fast ? min(18, (int)thread::hardware_concurrency()) : 1;

    if (fast)
        printSeparator("SOLVING — MULTITHREADED IDA* (" +
                       to_string(nThreads) + " threads)");
    else
        printSeparator("SOLVING — IDA* + CORNER PATTERN DATABASE");

    cout << "Loading database: " << dbPath << " ...\n";

    auto t0 = chrono::high_resolution_clock::now();
    vector<RubiksCube::MOVE> moves;
    RubiksCubeBitboard solvedCube;

    if (fast) {
        IDAstarSolverMT<RubiksCubeBitboard, HashBitboard> solver(cube, dbPath);
        moves = solver.solve();
        solvedCube = solver.rubiksCube;
    } else {
        IDAstarSolver<RubiksCubeBitboard, HashBitboard> solver(cube, dbPath);
        moves = solver.solve();
        solvedCube = solver.rubiksCube;
    }

    auto t1 = chrono::high_resolution_clock::now();

    printSeparator("SOLVED CUBE");
    solvedCube.print();

    cout << "Solution (" << moves.size() << " moves): ";
    printMoves(moves);
    cout << "\nTime   : " << fixed << setprecision(3)
         << chrono::duration<double>(t1 - t0).count() << " s";
    if (fast) cout << "  [" << nThreads << " threads on M4]";
    cout << "\nCheck  : " << (solvedCube.isSolved() ? "SOLVED ✓" : "FAILED ✗") << "\n\n";
}

// ── main ──────────────────────────────────────────────────────────────────────
int main(int argc, char *argv[]) {
    bool scanMode = false;
    bool fastMode = false;           // --fast  → multithreaded IDA*
    string dbPath = "Databases/cornerDepth8V1.txt";

    for (int i = 1; i < argc; i++) {
        if (string(argv[i]) == "--scan") scanMode = true;
        else if (string(argv[i]) == "--fast") fastMode = true;
        else dbPath = argv[i];
    }

    if (scanMode) {
        // ── Camera scan mode ─────────────────────────────────────────────────
        printSeparator("RUBIK'S CUBE SCANNER");
        cout << "Camera will open. Hold each face inside the yellow grid.\n"
             << "SPACE = capture    R = redo    ESC = quit\n\n"
             << "Face order you will be asked:\n"
             << "  1. UP face (top)\n"
             << "  2. FRONT face (facing you)\n"
             << "  3. RIGHT face (your right)\n"
             << "  4. LEFT face (your left)\n"
             << "  5. BACK face (away from you)\n"
             << "  6. DOWN face (bottom)\n\n"
             << "Press ENTER to open camera...";
        cin.get();

        CubeScanner scanner;
        array<RubiksCube::COLOR, 54> faceColors;
        if (!scanner.scan(faceColors)) {
            cout << "Scan cancelled.\n";
            return 1;
        }

        cout << "\nScanned colours:\n";
        const char *fnames[] = {"UP","LEFT","FRONT","RIGHT","BACK","DOWN"};
        for (int f = 0; f < 6; f++) {
            cout << "  " << fnames[f] << ": ";
            for (int s = 0; s < 9; s++) {
                char letters[] = {'W','G','R','B','O','Y'};
                cout << letters[(int)faceColors[f*9+s]];
            }
            cout << "\n";
        }

        if (!validateScan(faceColors)) {
            cout << "\n[Error] Invalid colour distribution — check scan and retry.\n"
                 << "Tip: ensure good even lighting and hold each face steady.\n";
            return 1;
        }

        printSeparator("SCANNED CUBE");
        RubiksCubeBitboard cube = buildCubeFromScan(faceColors);
        cube.print();

        if (cube.isSolved()) {
            cout << "The cube is already solved!\n";
            return 0;
        }

        solveAndPrint(cube, dbPath, fastMode);

    } else {
        // ── Random scramble mode (default) ───────────────────────────────────
        printSeparator("SCRAMBLED CUBE (random 10 moves)");

        RubiksCubeBitboard cube;
        auto shuffleMoves = cube.randomShuffleCube(10);
        cube.print();

        cout << "Shuffle: ";
        printMoves(shuffleMoves);

        solveAndPrint(cube, dbPath, fastMode);
    }

    return 0;
}
