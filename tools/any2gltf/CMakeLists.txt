# any2gltf — convert any Assimp-supported model to glTF 2.0.
#
# Pipeline:  <input> → Assimp importer (built-in + S3O plugin) → glTF2 exporter
#
# This CMakeLists fetches a clean upstream Assimp v6.0.4 (no patches, no
# streflop, no Spring fork) and builds a small standalone binary.

cmake_minimum_required(VERSION 3.25)

include(FetchContent)

# ---- Assimp build configuration ----
# Strip the build down to just what we need: glTF2 exporter on the output
# side, and a useful set of common importers (everything we might want to
# convert from). Disable tests/tools/docs to keep the build fast.
set(ASSIMP_BUILD_TESTS              OFF CACHE BOOL "" FORCE)
set(ASSIMP_INSTALL                  OFF CACHE BOOL "" FORCE)
set(ASSIMP_INSTALL_PDB              OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_ASSIMP_TOOLS       OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_ASSIMP_VIEW        OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_DOCS               OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_SAMPLES            OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_DRACO              OFF CACHE BOOL "" FORCE)
set(ASSIMP_WARNINGS_AS_ERRORS       OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS               OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_ZLIB               ON  CACHE BOOL "" FORCE)
set(ASSIMP_INJECT_DEBUG_POSTFIX     OFF CACHE BOOL "" FORCE)

# Importers — opt out of formats we don't need. Keep: glTF/glTF2, OBJ, FBX,
# COLLADA, BLEND, 3DS, LWO, STL, PLY. The S3O importer is added by us at
# runtime via RegisterLoader(), no Assimp source change required.
set(ASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_GLTF_IMPORTER      ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_OBJ_IMPORTER       ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_FBX_IMPORTER       ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_COLLADA_IMPORTER   ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_BLEND_IMPORTER     ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_3DS_IMPORTER       ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_LWO_IMPORTER       ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_STL_IMPORTER       ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_PLY_IMPORTER       ON  CACHE BOOL "" FORCE)

# Exporters — only glTF2.
set(ASSIMP_BUILD_ALL_EXPORTERS_BY_DEFAULT OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_GLTF_EXPORTER      ON  CACHE BOOL "" FORCE)
set(ASSIMP_NO_EXPORT                OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    assimp
    GIT_REPOSITORY https://github.com/assimp/assimp.git
    GIT_TAG        v6.0.4
    GIT_SHALLOW    TRUE
    GIT_SUBMODULES ""
)
FetchContent_MakeAvailable(assimp)

# Quiet a few warnings the Assimp tree raises under our compile options.
if(TARGET assimp)
    target_compile_options(assimp PRIVATE
        -Wno-deprecated-declarations
        -Wno-unused-but-set-variable
        -Wno-unused-variable
        -Wno-unused-function
        -Wno-deprecated-copy
    )
endif()

# ---- any2gltf executable ----
add_executable(any2gltf
    main.cpp
    S3OImporter.cpp
)
target_include_directories(any2gltf PRIVATE
    ${assimp_SOURCE_DIR}/include
    ${assimp_BINARY_DIR}/include
)
target_link_libraries(any2gltf PRIVATE assimp)
set_target_properties(any2gltf PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)
