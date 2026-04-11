# modelimporter — convert any 3D model file we support to glTF 2.0
# and emit engine metadata alongside it.
#
# Pipeline:  <input> → Assimp importer (built-in + S3O plugin) → glTF2 exporter
#                                                          → <model>.meta.lua
#
# Supported input formats are whatever Assimp ships upstream (OBJ, FBX,
# COLLADA, BLEND, 3DS, LWO, STL, PLY, DAE, MD2/3/5, X, glTF, etc) plus
# Spring RTS .s3o via our own BaseImporter plugin. Output is always
# glTF 2.0 binary (.glb), optionally with a sibling .meta.lua metadata
# file for the synced sim to read without needing Assimp itself.
#
# The tool fetches a clean upstream Assimp v6.0.4 (no patches, no
# streflop, no Spring fork) via FetchContent and builds a small
# standalone binary that runs at content-preprocess time only.

cmake_minimum_required(VERSION 3.25)

include(FetchContent)

# ---- Assimp build configuration ----

# Keep builds fast: tests, viewer, docs, samples off.
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

# Importers: default to ALL ON. This gives us every format Assimp
# currently supports (~48 in v6.0.4: OBJ, FBX, COLLADA/DAE, BLEND,
# 3DS, LWO/LWS, STL, PLY, glTF/glTF2, MD2/MD3/MD5, X, X3D, DXF,
# AC, ASE, AMF, BVH, COB, Q3BSP, MDL, OGRE, IFC, USD, and more).
# Individual games rarely need more than one or two input formats,
# but there's no reason to make this tool the bottleneck when a
# game author wants to try something different. Binary size at
# -O0 is ~15MB which is fine for a preprocess-time tool.
#
# Explicit OFFs for formats we don't want:
#   - C4D (non-free, proprietary Cinema4D SDK)
#   - M3D (off by default upstream for licence reasons)
set(ASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT ON  CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_NONFREE_C4D_IMPORTER     OFF CACHE BOOL "" FORCE)
set(ASSIMP_BUILD_M3D_IMPORTER             OFF CACHE BOOL "" FORCE)

# Exporters: we only need glTF2 (and its companion `gltf` for
# JSON-flavoured glTF 1.0 output if a caller explicitly requests it).
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

# ---- modelimporter executable ----
add_executable(modelimporter
    main.cpp
    S3OImporter.cpp
    MetaLuaWriter.cpp
)
target_include_directories(modelimporter PRIVATE
    ${assimp_SOURCE_DIR}/include
    ${assimp_BINARY_DIR}/include
)
target_link_libraries(modelimporter PRIVATE assimp)
set_target_properties(modelimporter PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)
