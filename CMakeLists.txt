cmake_minimum_required(VERSION 3.31)
project(rubiks_cube_solver)

set(CMAKE_CXX_STANDARD 14)

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
)
