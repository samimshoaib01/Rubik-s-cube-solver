#include "CubeScanner.h"
#include <cmath>
#include <iostream>
#include <limits>

using namespace cv;
using namespace std;

const char *CubeScanner::FACE_NAMES[6] = {
    "UP face (top)",
    "FRONT face (facing you)",
    "RIGHT face (your right)",
    "LEFT face (your left)",
    "BACK face (away from you)",
    "DOWN face (bottom)"
};

// Face order: U(0) F(2) R(3) L(1) B(4) D(5)
static const int SCAN_ORDER[6] = {0, 2, 3, 1, 4, 5};

// Net layout constants (face index -> col,row in the 4x3 net grid)
static const int NET_FC[6] = {1, 0, 1, 2, 3, 1};
static const int NET_FR[6] = {0, 1, 1, 1, 1, 2};
static const char *NET_LBL[6] = {"UP", "L", "F", "R", "B", "DN"};

// Fixed panel dimensions used during scanning (no runtime resize → mouse coords work)
static const int PANEL_CELL = 48;
static const int PANEL_PAD  = 3;
static const int PANEL_GAP  = 8;
static const int PANEL_FACE = PANEL_CELL * 3 + PANEL_PAD * 2;                // 150
static const int PANEL_H    = PANEL_GAP + 3 * (PANEL_FACE + PANEL_GAP);      // 482
static const int PANEL_W    = PANEL_GAP + 4 * (PANEL_FACE + PANEL_GAP);      // 640

// ── Helpers ───────────────────────────────────────────────────────────────────
static Vec3b bgrToHSV(Vec3b bgr) {
    Mat px(1, 1, CV_8UC3, Scalar(bgr[0], bgr[1], bgr[2]));
    Mat hsv;
    cvtColor(px, hsv, COLOR_BGR2HSV);
    return hsv.at<Vec3b>(0, 0);
}

static Vec3b samplePatch(const Mat &frame, const Rect &roi, int row, int col) {
    int cellW = roi.width  / 3;
    int cellH = roi.height / 3;
    int cx = roi.x + col * cellW + cellW / 2;
    int cy = roi.y + row * cellH + cellH / 2;
    int pr = 8;
    Rect patch(cx - pr, cy - pr, pr * 2, pr * 2);
    patch &= Rect(0, 0, frame.cols, frame.rows);
    Scalar m = cv::mean(frame(patch));
    return Vec3b((uchar)m[0], (uchar)m[1], (uchar)m[2]);
}

static RubiksCube::COLOR classifyByHue(Vec3b bgr) {
    Vec3b hsv = bgrToHSV(bgr);
    int H = hsv[0], S = hsv[1], V = hsv[2];
    // White: any bright pixel with low-to-moderate saturation.
    // (Real cube whites are rarely S<60 under warm/blue lighting.)
    if (V > 180 && S < 100) return RubiksCube::COLOR::WHITE;
    if (S < 60)             return RubiksCube::COLOR::WHITE;
    if (H < 8 || H > 170)   return RubiksCube::COLOR::RED;
    if (H < 16)             return RubiksCube::COLOR::ORANGE;
    if (H < 42)             return RubiksCube::COLOR::YELLOW;
    if (H < 90)             return RubiksCube::COLOR::GREEN;
    return RubiksCube::COLOR::BLUE;
}

// ── Perceptual Lab distance for auto-calibration classification ──────────────
static float labDist(Vec3b a, Vec3b b) {
    Mat ma(1, 1, CV_8UC3, Scalar(a[0], a[1], a[2]));
    Mat mb(1, 1, CV_8UC3, Scalar(b[0], b[1], b[2]));
    Mat la, lb;
    cvtColor(ma, la, COLOR_BGR2Lab);
    cvtColor(mb, lb, COLOR_BGR2Lab);
    Vec3b ca = la.at<Vec3b>(0, 0);
    Vec3b cb = lb.at<Vec3b>(0, 0);
    float dL = (float)ca[0] - cb[0];
    float da = (float)ca[1] - cb[1];
    float db = (float)ca[2] - cb[2];
    return sqrtf(dL*dL + da*da + db*db);
}

static int classifyByFace(Vec3b bgr, const Vec3b centerBGR[6]) {
    float bestDist = numeric_limits<float>::max();
    int bestFace = 0;
    for (int f = 0; f < 6; f++) {
        float d = labDist(bgr, centerBGR[f]);
        if (d < bestDist) { bestDist = d; bestFace = f; }
    }
    return bestFace;
}

static void reclassifyAll(
        const array<array<Vec3b, 9>, 6> &rawBGR,
        const Vec3b centerBGR[6],
        array<array<RubiksCube::COLOR, 9>, 6> &classified) {
    for (int f = 0; f < 6; f++)
        for (int s = 0; s < 9; s++)
            classified[f][s] =
                RubiksCube::COLOR(classifyByFace(rawBGR[f][s], centerBGR));
}

// ── BGR palette for drawing classified colours ───────────────────────────────
Scalar CubeScanner::colorToBGR(RubiksCube::COLOR c) {
    switch (c) {
        case RubiksCube::COLOR::WHITE:  return {255, 255, 255};
        case RubiksCube::COLOR::GREEN:  return {  0, 200,  50};
        case RubiksCube::COLOR::RED:    return {  0,   0, 220};
        case RubiksCube::COLOR::BLUE:   return {220,  90,   0};
        case RubiksCube::COLOR::ORANGE: return {  0, 140, 255};
        case RubiksCube::COLOR::YELLOW: return {  0, 230, 230};
    }
    return {128, 128, 128};
}

// ── Draw cube net with CLASSIFIED colours ─────────────────────────────────────
static Mat drawClassifiedNet(
        const array<array<RubiksCube::COLOR, 9>, 6> &classified,
        const array<bool, 6> &done,
        int CELL, int PAD, int GAP,
        int activeFace = -1,
        bool showHint = false) {

    int FACE = CELL * 3 + PAD * 2;
    int W = GAP + 4 * (FACE + GAP);
    int H = GAP + 3 * (FACE + GAP) + (showHint ? 60 : 0);

    Mat panel(H, W, CV_8UC3, Scalar(25, 25, 25));

    for (int f = 0; f < 6; f++) {
        int px = GAP + NET_FC[f] * (FACE + GAP);
        int py = GAP + NET_FR[f] * (FACE + GAP);

        bool isActive = (f == activeFace);
        Scalar border = isActive ? Scalar(0, 255, 255) : Scalar(80, 80, 80);
        rectangle(panel, Rect(px-2, py-2, FACE+4, FACE+4), border,
                  isActive ? 3 : 1);
        rectangle(panel, Rect(px, py, FACE, FACE), Scalar(55, 55, 55), -1);

        if (done[f]) {
            for (int r = 0; r < 3; r++) {
                for (int c = 0; c < 3; c++) {
                    int sx = px + PAD + c * CELL;
                    int sy = py + PAD + r * CELL;
                    Scalar col = CubeScanner::colorToBGR(classified[f][r*3+c]);
                    rectangle(panel, Rect(sx, sy, CELL-2, CELL-2), col, -1);
                    if (r == 1 && c == 1) {
                        // Locked centre — white border
                        rectangle(panel, Rect(sx, sy, CELL-2, CELL-2),
                                  Scalar(255, 255, 255), 2);
                    } else {
                        rectangle(panel, Rect(sx, sy, CELL-2, CELL-2),
                                  Scalar(0, 0, 0), 1);
                    }
                }
            }
        } else {
            int base = 0;
            Size ts = getTextSize(NET_LBL[f], FONT_HERSHEY_SIMPLEX, 0.7, 2, &base);
            Point tp(px + (FACE - ts.width) / 2,
                     py + FACE / 2 + ts.height / 2);
            putText(panel, NET_LBL[f], tp, FONT_HERSHEY_SIMPLEX, 0.7,
                    Scalar(110, 110, 110), 2);
        }
    }

    if (showHint) {
        string l1 = "Click any sticker to cycle its colour (centres are locked)";
        string l2 = "SPACE / ENTER = solve      R = rescan      ESC = quit";
        int base = 0;
        Size s1 = getTextSize(l1, FONT_HERSHEY_SIMPLEX, 0.5, 1, &base);
        Size s2 = getTextSize(l2, FONT_HERSHEY_SIMPLEX, 0.55, 1, &base);
        putText(panel, l1, Point((W - s1.width)/2, H - 34),
                FONT_HERSHEY_SIMPLEX, 0.5, Scalar(200, 200, 200), 1);
        putText(panel, l2, Point((W - s2.width)/2, H - 10),
                FONT_HERSHEY_SIMPLEX, 0.55, Scalar(0, 220, 220), 1);
    } else {
        putText(panel, "Cube State", Point(GAP, H - 6),
                FONT_HERSHEY_SIMPLEX, 0.5, Scalar(160, 160, 160), 1);
    }
    return panel;
}

// ── Combined view: camera resized to PANEL_H, panel at native size ───────────
static Mat makeCombined(const Mat &camFrame,
                         const array<array<RubiksCube::COLOR, 9>, 6> &classified,
                         const array<bool, 6> &facesDone,
                         int activeFace,
                         int *camWOut = nullptr) {
    Mat camR;
    double sc = (double)PANEL_H / camFrame.rows;
    int camW = (int)(camFrame.cols * sc);
    resize(camFrame, camR, Size(camW, PANEL_H));
    if (camWOut) *camWOut = camW;

    Mat net = drawClassifiedNet(classified, facesDone,
                                 PANEL_CELL, PANEL_PAD, PANEL_GAP,
                                 activeFace, false);
    Mat combined;
    hconcat(camR, net, combined);
    return combined;
}

// Draw text on a solid dark background pill — clean, always readable.
static void drawTextPill(Mat &frame, const string &text, Point centerBaseline,
                          double scale, int thick, Scalar textCol) {
    int base = 0;
    Size ts = getTextSize(text, FONT_HERSHEY_SIMPLEX, scale, thick, &base);
    int padX = 10, padY = 6;
    Point tl(centerBaseline.x - ts.width / 2 - padX,
             centerBaseline.y - ts.height - padY);
    Point br(centerBaseline.x + ts.width / 2 + padX,
             centerBaseline.y + base + padY);

    // Semi-transparent black background
    Mat overlay = frame.clone();
    rectangle(overlay, tl, br, Scalar(0, 0, 0), FILLED);
    addWeighted(overlay, 0.65, frame, 0.35, 0, frame);

    // Text on top
    putText(frame, text,
            Point(centerBaseline.x - ts.width / 2, centerBaseline.y),
            FONT_HERSHEY_SIMPLEX, scale, textCol, thick, LINE_AA);
}

// ── Grid overlay on live camera ──────────────────────────────────────────────
void CubeScanner::drawOverlay(Mat &frame, const Rect &roi,
                               const string &instruction,
                               const array<RubiksCube::COLOR, 9> *) const {
    rectangle(frame, roi, Scalar(0, 255, 255), 3);
    int cW = roi.width / 3, cH = roi.height / 3;
    for (int i = 1; i < 3; i++) {
        line(frame, {roi.x + i*cW, roi.y},
                    {roi.x + i*cW, roi.y + roi.height}, {0,255,255}, 1);
        line(frame, {roi.x, roi.y + i*cH},
                    {roi.x + roi.width, roi.y + i*cH}, {0,255,255}, 1);
    }

    // Top instruction: yellow text on dark pill
    drawTextPill(frame, instruction,
                 Point(frame.cols / 2, roi.y - 14),
                 0.65, 2, Scalar(0, 255, 255));

    // Bottom hint: light gray text on dark pill
    string hint = "SPACE = capture    R = redo    ESC = quit";
    drawTextPill(frame, hint,
                 Point(frame.cols / 2, roi.y + roi.height + 34),
                 0.55, 1, Scalar(220, 220, 220));
}

// Unused virtual stubs required by header
RubiksCube::COLOR CubeScanner::classifyColor(const cv::Vec3b &) const {
    return RubiksCube::COLOR::WHITE;
}
array<RubiksCube::COLOR, 9> CubeScanner::extractFaceColors(
        const cv::Mat &, const cv::Rect &) const { return {}; }

// ── Mouse callback: click stickers to cycle colours ──────────────────────────
// Two modes:
//   During per-face confirmation: only current face's stickers are editable.
//   During final review:          all faces are editable.
struct ClickCtx {
    array<array<RubiksCube::COLOR, 9>, 6> *classified;
    array<array<bool, 9>, 6> *manuallyFixed;
    int camW;
    int activeFace;
    bool enabled;
};

static void onClick(int event, int x, int y, int, void* userdata) {
    if (event != EVENT_LBUTTONDOWN) return;
    ClickCtx *ctx = (ClickCtx*)userdata;
    if (!ctx->enabled) return;

    int px = x - ctx->camW;
    int py = y;
    if (px < 0) return;

    for (int f = 0; f < 6; f++) {
        if (ctx->activeFace >= 0 && f != ctx->activeFace) continue;
        int fx = PANEL_GAP + NET_FC[f] * (PANEL_FACE + PANEL_GAP);
        int fy = PANEL_GAP + NET_FR[f] * (PANEL_FACE + PANEL_GAP);
        if (px < fx || px >= fx + PANEL_FACE) continue;
        if (py < fy || py >= fy + PANEL_FACE) continue;
        int lx = px - fx - PANEL_PAD;
        int ly = py - fy - PANEL_PAD;
        if (lx < 0 || ly < 0) return;
        int col = lx / PANEL_CELL;
        int row = ly / PANEL_CELL;
        if (col < 0 || col > 2 || row < 0 || row > 2) return;
        int s = row * 3 + col;
        if (s == 4) return;
        auto &c = (*ctx->classified)[f][s];
        c = RubiksCube::COLOR(((int)c + 1) % 6);
        (*ctx->manuallyFixed)[f][s] = true;
        return;
    }
}

// ── Draw review panel (bigger, standalone window after all faces scanned) ────
static const int REV_CELL = 55, REV_PAD = 3, REV_GAP = 12;
static const int REV_FACE = REV_CELL * 3 + REV_PAD * 2;

struct ReviewCtx {
    array<array<RubiksCube::COLOR, 9>, 6> *classified;
    array<array<bool, 9>, 6> *manuallyFixed;
};

static void onReviewClick(int event, int x, int y, int, void* userdata) {
    if (event != EVENT_LBUTTONDOWN) return;
    ReviewCtx *ctx = (ReviewCtx*)userdata;
    for (int f = 0; f < 6; f++) {
        int fx = REV_GAP + NET_FC[f] * (REV_FACE + REV_GAP);
        int fy = REV_GAP + NET_FR[f] * (REV_FACE + REV_GAP);
        if (x < fx || x >= fx + REV_FACE) continue;
        if (y < fy || y >= fy + REV_FACE) continue;
        int lx = x - fx - REV_PAD;
        int ly = y - fy - REV_PAD;
        if (lx < 0 || ly < 0) return;
        int col = lx / REV_CELL;
        int row = ly / REV_CELL;
        if (col < 0 || col > 2 || row < 0 || row > 2) return;
        int s = row * 3 + col;
        if (s == 4) return;
        auto &c = (*ctx->classified)[f][s];
        c = RubiksCube::COLOR(((int)c + 1) % 6);
        (*ctx->manuallyFixed)[f][s] = true;
        return;
    }
}

// ── Main scan loop ────────────────────────────────────────────────────────────
bool CubeScanner::scan(array<RubiksCube::COLOR, 54> &faceColors) {
    VideoCapture cap(0);
    if (!cap.isOpened()) {
        cerr << "[Scanner] Cannot open camera 0.\n";
        return false;
    }
    cap.set(CAP_PROP_FRAME_WIDTH,  1280);
    cap.set(CAP_PROP_FRAME_HEIGHT,  720);
    const char *WIN = "Rubik's Cube Scanner";
    namedWindow(WIN, WINDOW_AUTOSIZE);

    array<array<Vec3b, 9>, 6> rawBGR{};
    array<array<RubiksCube::COLOR, 9>, 6> classified{};
    array<array<bool, 9>, 6> manuallyFixed{};   // per-sticker manual override
    array<bool, 6> facesDone{};
    facesDone.fill(false);
    for (auto &row : manuallyFixed) row.fill(false);

    ClickCtx cctx;
    cctx.classified = &classified;
    cctx.manuallyFixed = &manuallyFixed;
    cctx.camW = 0;
    cctx.activeFace = -1;
    cctx.enabled = false;
    setMouseCallback(WIN, onClick, &cctx);

    for (int step = 0; step < 6; step++) {
        int face = SCAN_ORDER[step];
        bool faceDone = false;
        bool inConfirm = false;
        Mat capturedFrame;

        while (!faceDone) {
            Mat frame;
            if (!inConfirm) {
                cap >> frame;
                if (frame.empty()) break;
            } else {
                frame = capturedFrame.clone();
            }

            int side = (int)(min(frame.cols, frame.rows) * 0.55);
            Rect roi((frame.cols - side) / 2,
                     (frame.rows - side) / 2, side, side);

            string instr = inConfirm
                ? "Confirm face " + to_string(step + 1) + "/6 — click any wrong sticker"
                : "Face " + to_string(step + 1) + "/6 — Show " + FACE_NAMES[step];

            Mat display = frame.clone();
            drawOverlay(display, roi, instr);

            string sl = "Step " + to_string(step + 1) + " / 6";
            putText(display, sl, {10, 32},
                    FONT_HERSHEY_SIMPLEX, 0.9, {0,0,0},     4);
            putText(display, sl, {10, 32},
                    FONT_HERSHEY_SIMPLEX, 0.9, {0,255,255}, 2);

            if (inConfirm) {
                string h2 = "SPACE = confirm    R = redo    click stickers to fix";
                int base = 0;
                Size hs = getTextSize(h2, FONT_HERSHEY_SIMPLEX, 0.55, 1, &base);
                Point hp(frame.cols / 2 - hs.width / 2, roi.y + roi.height + 55);
                putText(display, h2, hp, FONT_HERSHEY_SIMPLEX, 0.55, {0,0,0},   3);
                putText(display, h2, hp, FONT_HERSHEY_SIMPLEX, 0.55, {0,255,0}, 1);
            }

            int camW = 0;
            Mat combined = makeCombined(display, classified, facesDone, face, &camW);
            cctx.camW = camW;
            cctx.activeFace = inConfirm ? face : -1;
            cctx.enabled = inConfirm;

            imshow(WIN, combined);
            int key = waitKey(30);

            if (key == 27) { destroyAllWindows(); return false; }

            if (!inConfirm) {
                if (key == ' ') {
                    capturedFrame = frame.clone();
                    array<Vec3b, 9> captured{};
                    array<RubiksCube::COLOR, 9> guess{};
                    for (int r = 0; r < 3; r++) {
                        for (int c = 0; c < 3; c++) {
                            captured[r*3+c] = samplePatch(frame, roi, r, c);
                            guess[r*3+c]    = classifyByHue(captured[r*3+c]);
                        }
                    }
                    guess[4] = RubiksCube::COLOR(face);

                    rawBGR[face]         = captured;
                    classified[face]     = guess;
                    manuallyFixed[face].fill(false);   // fresh capture → no manual edits yet
                    facesDone[face]      = true;
                    inConfirm = true;
                }
            } else {
                if (key == 'r' || key == 'R') {
                    facesDone[face] = false;
                    manuallyFixed[face].fill(false);   // recapture wipes edits
                    inConfirm = false;
                } else if (key == ' ' || key == 13 || key == 10) {
                    faceDone = true;
                }
                // clicks are handled by onClick, which mutates classified[face][s]
            }
        }
    }

    setMouseCallback(WIN, nullptr, nullptr);
    destroyAllWindows();

    // Centres are always fixed to their own face colour
    for (int f = 0; f < 6; f++)
        classified[f][4] = RubiksCube::COLOR(f);

    // ── Final review window: click any sticker to fix ────────────────────────
    ReviewCtx rctx;
    rctx.classified = &classified;
    rctx.manuallyFixed = &manuallyFixed;

    array<bool, 6> allDone{};
    allDone.fill(true);

    const char *RWIN = "Scan Review — click stickers to fix";
    namedWindow(RWIN, WINDOW_AUTOSIZE);
    setMouseCallback(RWIN, onReviewClick, &rctx);

    cout << "\n[Scanner] Final review — click any sticker to fix.\n"
         << "  SPACE / ENTER = solve\n"
         << "  R             = rescan\n"
         << "  ESC           = quit\n";

    while (true) {
        Mat panel = drawClassifiedNet(classified, allDone,
                                       REV_CELL, REV_PAD, REV_GAP, -1, true);
        imshow(RWIN, panel);
        int k = waitKey(30);
        if (k == 27) { destroyAllWindows(); return false; }
        if (k == 'r' || k == 'R') { destroyAllWindows(); return false; }
        if (k == ' ' || k == 13 || k == 10) break;
    }
    destroyAllWindows();

    for (int f = 0; f < 6; f++)
        for (int s = 0; s < 9; s++)
            faceColors[f * 9 + s] = classified[f][s];

    return true;
}
