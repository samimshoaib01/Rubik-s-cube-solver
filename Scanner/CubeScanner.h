#pragma once

#include <opencv2/opencv.hpp>
#include <array>
#include <string>
#include <vector>
#include "../Model/RubiksCube.h"

// Scans all 6 faces of a physical Rubik's cube via webcam.
// User holds each face up to the camera and presses SPACE to capture.
// Returns a flat array of 54 colors in face-major order:
//   faces[0..8]  = UP,  faces[9..17]  = LEFT, faces[18..26] = FRONT,
//   faces[27..35] = RIGHT, faces[36..44] = BACK, faces[45..53] = DOWN
// Each entry is a RubiksCube::COLOR value.
class CubeScanner {
public:
    // Scan all 6 faces interactively. Returns false if user quits (ESC).
    bool scan(std::array<RubiksCube::COLOR, 54> &faceColors);

    // BGR values for each RubiksCube::COLOR (used by drawCubeNet too)
    static cv::Scalar colorToBGR(RubiksCube::COLOR c);

private:
    // Order we ask the user to show faces
    static constexpr int FACE_ORDER[6] = {0, 2, 3, 1, 4, 5}; // U F R L B D
    static const char *FACE_NAMES[6];

    // Classify a single BGR pixel to the nearest cube color
    RubiksCube::COLOR classifyColor(const cv::Vec3b &bgr) const;

    // Sample the 9 sticker colors from a captured frame
    std::array<RubiksCube::COLOR, 9> extractFaceColors(const cv::Mat &frame,
                                                         const cv::Rect &roi) const;

    // Draw guide overlay on the live feed
    void drawOverlay(cv::Mat &frame, const cv::Rect &roi,
                     const std::string &instruction,
                     const std::array<RubiksCube::COLOR, 9> *preview = nullptr) const;

};
