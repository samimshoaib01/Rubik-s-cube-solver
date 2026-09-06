cmake_minimum_required(VERSION 3.31)
project(rubiks_cube_solver)

set(CMAKE_CXX_STANDARD 14)

# Apple Clang / libc++ doesn't ship <bits/stdc++.h>; provide a local shim.
include_directories(${CMAKE_SOURCE_DIR}/compat)

# OpenCV (installed via Homebrew; works on Linux/Windows with standard find too)
find_package(OpenCV REQUIRED
    PATHS /opt/homebrew/lib/cmake/opencv5   # Homebrew arm64 Mac
          /usr/local/lib/cmake/opencv5       # Homebrew x86 Mac
          /usr/lib/cmake/opencv5             # Linux
    NO_DEFAULT_PATH
)
if(NOT OpenCV_FOUND)
    # Fallback: let cmake search its default paths
    find_package(OpenCV REQUIRED)
endif()

message(STATUS "OpenCV version: ${OpenCV_VERSION}")
message(STATUS "OpenCV include: ${OpenCV_INCLUDE_DIRS}")

add_executable(rubiks_cube_solver main.cpp
        Model/RubiksCube1dArray.cpp
        Model/RubiksCube.cpp
        Model/RubiksCube.h
        Model/RubiksCube3dArray.cpp
        Model/RubiksCubeBitboard.cpp
        Model/PatternDatabase/PatternDatabase.h
        Solver/BFSSolver.h
        Solver/DFSSolver.h
        Solver/IDAstarSolver.h
        Solver/IDDFSSolver.h
        PatternDatabases/CornerDBMaker.cpp
        PatternDatabases/CornerDBMaker.h
        PatternDatabases/CornerPatternDatabase.cpp
        PatternDatabases/CornerPatternDatabase.h
        PatternDatabases/NibbleArray.cpp
        PatternDatabases/NibbleArray.h
        PatternDatabases/PatternDatabase.cpp
        PatternDatabases/PatternDatabase.h
        PatternDatabases/PermutationIndexer.h
        PatternDatabases/math.cpp
        PatternDatabases/math.h
        Scanner/CubeScanner.h
        Scanner/CubeScanner.cpp
)

target_include_directories(rubiks_cube_solver PRIVATE ${OpenCV_INCLUDE_DIRS})
target_link_libraries(rubiks_cube_solver ${OpenCV_LIBS})
