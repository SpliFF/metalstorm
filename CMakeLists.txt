cmake_minimum_required(VERSION 3.25)
project(SpringServer LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Build stamp for cache-busting: git short hash + configure timestamp.
# Changes on every cmake configure (rebuild), so asset URLs with ?v=<stamp>
# naturally bust browser caches on new deployments.
execute_process(
    COMMAND git rev-parse --short HEAD
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE GIT_SHORT_HASH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
)
if(NOT GIT_SHORT_HASH)
    set(GIT_SHORT_HASH "unknown")
endif()
string(TIMESTAMP BUILD_TIME "%Y%m%d%H%M%S")
set(SPRING_BUILD_STAMP "${GIT_SHORT_HASH}-${BUILD_TIME}")
message(STATUS "Build stamp: ${SPRING_BUILD_STAMP}")

# Server build defines.
# We previously inherited -DHEADLESS, -DDEDICATED, -DDEDICATED_NOSSE from
# upstream Spring's headless/dedicated build profiles. Both have been
# removed: this fork is exclusively a server build, so the distinction
# between "normal" and "headless/dedicated" code paths is meaningless.
# Removing them unblocks Spring.TimeCheck (and other Lua APIs that
# upstream stubbed out for the dedicated relay), and lets us re-enable
# SSE math on x86 hosts.
add_definitions(
    -DNO_SOUND
    -DBITMAP_NO_OPENGL
    -DNOT_USING_CREG
    -DAUTHORITATIVE_SERVER
    -DTHREADPOOL
    -DSPRING_BUILD_STAMP="${SPRING_BUILD_STAMP}"
)

# Suppress warnings from legacy code during cleanup
add_compile_options(-Wno-unused-variable -Wno-unused-function -Wno-sign-compare)

# Platform defines
if(WIN32)
    add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN)
endif()

# Include paths — the rts/ directory is the root for Spring includes
include_directories(${CMAKE_SOURCE_DIR}/rts)
include_directories(${CMAKE_SOURCE_DIR}/rts/lib/nowide/include)
include_directories(${CMAKE_SOURCE_DIR}/rts/lib/entt/src)

# === nghttp2 (HTTP/2 library) ===
include(FetchContent)

# nghttp2: build only the static library, no tools/examples/docs.
# Use manual FetchContent_Populate to scope variables without affecting
# other dependencies (doctest, brotli, etc.).
FetchContent_Declare(
    nghttp2
    GIT_REPOSITORY https://github.com/nghttp2/nghttp2.git
    GIT_TAG v1.64.0
    GIT_SHALLOW TRUE
)
FetchContent_GetProperties(nghttp2)
if(NOT nghttp2_POPULATED)
    FetchContent_Populate(nghttp2)
    # Scope nghttp2 build options (not global cache)
    set(NGHTTP2_SAVE_BUILD_SHARED ${BUILD_SHARED_LIBS})
    set(NGHTTP2_SAVE_BUILD_STATIC ${BUILD_STATIC_LIBS})
    set(NGHTTP2_SAVE_BUILD_TESTING ${BUILD_TESTING})
    set(BUILD_SHARED_LIBS OFF)
    set(BUILD_STATIC_LIBS ON)
    set(BUILD_TESTING OFF)
    set(ENABLE_LIB_ONLY ON)
    set(ENABLE_DOC OFF CACHE BOOL "" FORCE)
    add_subdirectory(${nghttp2_SOURCE_DIR} ${nghttp2_BINARY_DIR} EXCLUDE_FROM_ALL)
    set(BUILD_SHARED_LIBS ${NGHTTP2_SAVE_BUILD_SHARED})
    set(BUILD_STATIC_LIBS ${NGHTTP2_SAVE_BUILD_STATIC})
    set(BUILD_TESTING ${NGHTTP2_SAVE_BUILD_TESTING})
endif()

# WebRTC (libdatachannel) was removed in GW7 (PLAN-game-worker.md) — the game
# stream now runs on WebTransport (QUIC) only. See the QUIC block below.
# Some FetchContent deps (e.g. plog) still declare an old cmake_minimum_required;
# keep the policy floor so they configure under modern CMake.
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)

# === QUIC / HTTP-3 / WebTransport (ngtcp2 + nghttp3 + OpenSSL 3.5+) ===
# Stage 0 (PLAN-game-worker.md) moves the game stream onto WebTransport.
# The QUIC stack needs OpenSSL >= 3.5 (native QUIC TLS API), ngtcp2 with
# the ngtcp2_crypto_ossl backend, and nghttp3 for the HTTP/3 layer.
#
# Divergence from PLAN-game-worker.md GW1 (recorded deliberately): the plan
# specced FetchContent for these. We instead consume the already-installed
# Homebrew packages (libngtcp2 1.22, libnghttp3 1.15, openssl@3 3.6) via
# pkg-config. Rationale: a from-scratch OpenSSL+ngtcp2 FetchContent build is
# several minutes per clean configure and brittle on macOS; the system
# packages are the same upstream releases. This is a build-system choice, not
# an architecture change. CI / Linux can switch back to FetchContent later by
# defining SPRING_QUIC_FETCHCONTENT.
#
# WebTransport is the *only* game transport (PLAN-game-worker.md drops WebRTC
# entirely — no fallback by design). The QUIC stack is therefore a hard build
# requirement: configuration fails if it is absent.
find_package(PkgConfig REQUIRED)
# Prefer Homebrew's openssl@3 (system OpenSSL on macOS is LibreSSL, no QUIC).
foreach(_ossl_prefix /opt/homebrew/opt/openssl@3 /usr/local/opt/openssl@3)
    if(EXISTS ${_ossl_prefix}/lib/pkgconfig)
        list(APPEND CMAKE_PREFIX_PATH ${_ossl_prefix})
        set(ENV{PKG_CONFIG_PATH} "${_ossl_prefix}/lib/pkgconfig:$ENV{PKG_CONFIG_PATH}")
    endif()
endforeach()
foreach(_qpkg libngtcp2 libngtcp2_crypto_ossl libnghttp3)
    foreach(_qprefix /opt/homebrew/opt/${_qpkg} /usr/local/opt/${_qpkg})
        if(EXISTS ${_qprefix}/lib/pkgconfig)
            set(ENV{PKG_CONFIG_PATH} "${_qprefix}/lib/pkgconfig:$ENV{PKG_CONFIG_PATH}")
        endif()
    endforeach()
endforeach()
pkg_check_modules(NGTCP2        REQUIRED libngtcp2)
pkg_check_modules(NGTCP2_CRYPTO REQUIRED libngtcp2_crypto_ossl)
pkg_check_modules(NGHTTP3       REQUIRED libnghttp3)
pkg_check_modules(OPENSSL_QUIC  REQUIRED libssl libcrypto)
add_library(quic_deps INTERFACE)
target_include_directories(quic_deps INTERFACE
    ${NGTCP2_INCLUDE_DIRS} ${NGTCP2_CRYPTO_INCLUDE_DIRS}
    ${NGHTTP3_INCLUDE_DIRS} ${OPENSSL_QUIC_INCLUDE_DIRS})
target_link_libraries(quic_deps INTERFACE
    ${NGTCP2_LINK_LIBRARIES} ${NGTCP2_CRYPTO_LINK_LIBRARIES}
    ${NGHTTP3_LINK_LIBRARIES} ${OPENSSL_QUIC_LINK_LIBRARIES})
message(STATUS "QUIC stack: ngtcp2 ${NGTCP2_VERSION}, nghttp3 ${NGHTTP3_VERSION}, openssl ${OPENSSL_QUIC_VERSION}")

# Standalone GW1 de-risk harness: proves the QUIC/WebTransport toolchain
# links and the core ngtcp2/OpenSSL server objects construct. Built only
# when -DSPRING_BUILD_QUIC_DERISK=ON.
option(SPRING_BUILD_QUIC_DERISK "Build the WebTransport QUIC de-risk harness" OFF)
if(SPRING_BUILD_QUIC_DERISK)
    add_executable(spring-quic-derisk
        rts/Server/WebTransport/derisk_main.cpp
        rts/Server/WebTransport/WebTransportServer.cpp)
    target_include_directories(spring-quic-derisk PRIVATE rts)
    target_link_libraries(spring-quic-derisk PRIVATE quic_deps)
endif()

# === FlatBuffers (protocol serialisation) ===
set(FLATBUFFERS_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(FLATBUFFERS_INSTALL OFF CACHE BOOL "" FORCE)
set(FLATBUFFERS_BUILD_FLATHASH OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    flatbuffers
    GIT_REPOSITORY https://github.com/google/flatbuffers.git
    GIT_TAG v24.3.25
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(flatbuffers)

# === nlohmann/json (JSON DOM for modelimporter glTF surgery + engine
# extension reads) ===
# Header-only, MIT-licensed. Replaces hand-rolled JSON string surgery
# in tools/modelimporter (FixGlbBasisuTextures, GeometryExtractor).
# Linked into spring-server so ModelConfigLoader can extract
# SPRINGRTS_geometry from .gltf files, and into gameconverter so its
# pre-flight stale-version check can walk the same extension.
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
set(JSON_Install    OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(nlohmann_json)

# === brotli (encoder for HTTP-served compressed Lua def caches) ===
# The lobby's static handler serves data/games/<id>/cache/defs/<key>/*.lua.br
# with `Content-Encoding: br`; browsers decompress transparently. Only the
# encoder is needed server-side (browser handles decode); we disable the
# decoder + tests + CLI to keep the build small.
set(BROTLI_DISABLE_TESTS ON CACHE BOOL "" FORCE)
set(BROTLI_BUNDLED_MODE OFF CACHE BOOL "" FORCE)
set(BROTLI_EMSCRIPTEN OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    brotli
    GIT_REPOSITORY https://github.com/google/brotli.git
    GIT_TAG v1.1.0
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(brotli)

# === libktx (KTX2 + Basis Universal encoder/transcoder) ===
# Reference implementation from KhronosGroup. Linked into the texture
# preprocessing tools (textureconverter, mapconverter, gameconverter).
# We disable KTX1, the CLI tools, tests, docs, and the GL/Vulkan upload
# helpers — we only need the encoder + Basis Universal libraries.
set(KTX_FEATURE_TOOLS    OFF CACHE BOOL "" FORCE)
set(KTX_FEATURE_TESTS    OFF CACHE BOOL "" FORCE)
set(KTX_FEATURE_DOC      OFF CACHE BOOL "" FORCE)
# Keep KTX1 enabled — disabling it strips the
# `ktxTexture1_constructFromStreamAndHeader` symbol that the shared
# `texture.c` dispatcher still calls into. The encoder/decoder happily
# round-trips KTX2 either way.
set(KTX_FEATURE_KTX1     ON  CACHE BOOL "" FORCE)
set(KTX_FEATURE_KTX2     ON  CACHE BOOL "" FORCE)
set(KTX_FEATURE_VK_UPLOAD OFF CACHE BOOL "" FORCE)
set(KTX_FEATURE_GL_UPLOAD OFF CACHE BOOL "" FORCE)
set(KTX_FEATURE_STATIC_LIBRARY ON CACHE BOOL "" FORCE)
set(KTX_FEATURE_LOADTEST_APPS "OFF" CACHE STRING "" FORCE)
# Fetched as a tarball, not a git clone — KTX-Software's repo uses
# git-lfs for the test fixtures, and a clone fails on machines without
# the lfs filter installed. The tarball release excludes the LFS blobs
# and gives us everything the encoder needs.
FetchContent_Declare(
    ktx
    URL https://github.com/KhronosGroup/KTX-Software/archive/refs/tags/v4.3.2.tar.gz
    URL_HASH SHA256=74a114f465442832152e955a2094274b446c7b2427c77b1964c85c173a52ea1f
)
FetchContent_MakeAvailable(ktx)

# Generate C++ headers from .fbs schemas
set(SCHEMA_DIR ${CMAKE_SOURCE_DIR}/schemas)
set(GENERATED_DIR ${CMAKE_BINARY_DIR}/generated)
file(MAKE_DIRECTORY ${GENERATED_DIR})

add_custom_command(
    OUTPUT ${GENERATED_DIR}/protocol_generated.h
    COMMAND flatc --cpp --gen-object-api -o ${GENERATED_DIR} ${SCHEMA_DIR}/protocol.fbs
    DEPENDS ${SCHEMA_DIR}/protocol.fbs flatc
    COMMENT "Generating FlatBuffers C++ headers from protocol.fbs"
)
add_custom_target(generate_flatbuffers DEPENDS ${GENERATED_DIR}/protocol_generated.h)

# === Embed rts/lib/lua/json-lua/json.lua into a generated C header ===
# LuaParser preloads this into every Lua state so `json.encode` /
# `json.decode` are available as globals. See rts/Lua/LuaParser.cpp.
set(JSON_LUA_SOURCE_FILE ${CMAKE_SOURCE_DIR}/rts/lib/lua/json-lua/json.lua)
file(READ ${JSON_LUA_SOURCE_FILE} SPRING_JSON_LUA_SOURCE)
configure_file(
    ${CMAKE_SOURCE_DIR}/rts/Lua/LuaJsonSrc.h.in
    ${GENERATED_DIR}/LuaJsonSrc.h
    @ONLY
)

# === SpringLog (unified logging library) ===
find_package(SQLite3 REQUIRED)
add_subdirectory(rts/System/SpringLog)

# === Lua 5.4.7 (standard upstream, compiled as C++) ===
file(GLOB LUA_SOURCES rts/lib/lua/src/*.cpp)
add_library(lua STATIC ${LUA_SOURCES})
target_include_directories(lua PUBLIC rts/lib/lua/include rts/lib/lua/src)
if(UNIX)
    target_compile_definitions(lua PRIVATE LUA_USE_POSIX)
    target_link_libraries(lua m)
endif()

# === smmalloc (Recoil's small memory allocator) ===
file(GLOB SMMALLOC_SOURCES rts/lib/smmalloc/*.cpp)
add_library(smmalloc STATIC ${SMMALLOC_SOURCES})
target_include_directories(smmalloc PUBLIC rts/lib/smmalloc)

# === Collect all sim sources ===

# System utilities (platform-independent core)
file(GLOB_RECURSE SYSTEM_SOURCES
    rts/System/*.cpp
    rts/System/*.c
)
# Exclude bundled libraries and SpringLog (they have their own targets)
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "rts/lib/")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "rts/System/SpringLog/")
# Recoil files that need libraries we don't have (tracy, mimalloc)
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "MemoryOverride")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Log/TracySink")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Log/OutputDebugStringSink")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "TraceMemory")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Sync/DumpHistory")
# Legacy P2P networking (replaced by WebTransport/HTTP)
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Net/UDPListener")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Net/UDPConnection")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Net/LocalConnection")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Net/LoopbackConnection")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Net/PackPacket")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Net/RawPacket")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Net/ProtocolDef")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Net/Socket\\.cpp")
# Linux-only on macOS
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Linux/CpuTopology")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Linux/Hardware")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/ThreadAffinityGuard")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/CpuTopologyCommon")

# Platform filtering — only compile for the current OS
if(NOT WIN32)
    list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Win/")
endif()
if(NOT APPLE)
    list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Mac/")
endif()
if(NOT UNIX)
    list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Linux/")
elseif(APPLE)
    # macOS uses most Linux/ POSIX files (SoLib, Futex, ThreadSupport)
    # but not the Linux-specific ones
    list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Linux/CrashHandler")
    list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Linux/Futex")
    list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Linux/MessageBox")
    list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "Platform/Linux/WindowManagerHelper")
endif()

# Game sources
file(GLOB_RECURSE GAME_SOURCES rts/Game/*.cpp)
list(FILTER GAME_SOURCES EXCLUDE REGEX "Camera/DollyController")
list(FILTER GAME_SOURCES EXCLUDE REGEX "GameInputReceiver")
list(FILTER GAME_SOURCES EXCLUDE REGEX "IGameCommands")
list(FILTER GAME_SOURCES EXCLUDE REGEX "UI/ScanCodes")
list(FILTER GAME_SOURCES EXCLUDE REGEX "UI/IKeys")

# Simulation sources
file(GLOB_RECURSE SIM_SOURCES rts/Sim/*.cpp)
# SaveLoadUtils needs cereal (header-only serialization library)
# list(FILTER SIM_SOURCES EXCLUDE REGEX "Ecs/SaveLoadUtils")

# Map sources
file(GLOB_RECURSE MAP_SOURCES rts/Map/*.cpp)
list(FILTER MAP_SOURCES EXCLUDE REGEX "Map/Generation/")

# Lua binding sources
file(GLOB_RECURSE LUA_BINDING_SOURCES rts/Lua/*.cpp)
# Exclude rendering-only Lua bindings (GL buffers, VAO/VBO, Tracy extras)
list(FILTER LUA_BINDING_SOURCES EXCLUDE REGEX "Lua(VBO|VAO|VBOImpl|VAOImpl|TracyExtra)\\.cpp$")

# Server sources (includes rts/Server/WebTransport/WebTransportServer.cpp —
# WebTransport is the game transport, compiled in unconditionally). The
# standalone de-risk harness has its own main() and its own target, so keep it
# out of spring-server.
file(GLOB_RECURSE SERVER_SOURCES rts/Server/*.cpp)
list(FILTER SERVER_SOURCES EXCLUDE REGEX "rts/Server/WebTransport/derisk_main")

# === spring-server executable ===
add_executable(spring-server
    rts/server_main.cpp
    ${SYSTEM_SOURCES}
    ${GAME_SOURCES}
    ${SIM_SOURCES}
    ${MAP_SOURCES}
    ${LUA_BINDING_SOURCES}
    ${SERVER_SOURCES}
)

add_dependencies(spring-server generate_flatbuffers)
target_include_directories(spring-server PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${CMAKE_SOURCE_DIR}/rts/lib
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/include
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/src
    ${CMAKE_SOURCE_DIR}/rts/lib/cereal/include
    ${GENERATED_DIR}
)
find_package(ZLIB REQUIRED)
target_link_libraries(spring-server PRIVATE lua smmalloc nghttp2_static flatbuffers ZLIB::ZLIB SQLite3::SQLite3 springlog springlog-net springlog-sqlite quic_deps nlohmann_json::nlohmann_json brotlienc brotlicommon)

# Link platform libraries
if(UNIX AND NOT APPLE)
    target_link_libraries(spring-server PRIVATE pthread dl)
elseif(APPLE)
    target_link_libraries(spring-server PRIVATE pthread dl)
    find_library(COCOA_FRAMEWORK Cocoa)
    if(COCOA_FRAMEWORK)
        target_link_libraries(spring-server PRIVATE ${COCOA_FRAMEWORK})
    endif()
endif()

# === spring-lobby executable (lightweight lobby server) ===
set(LOBBY_SERVER_SOURCES
    rts/Server/Database.cpp
    rts/Server/NetworkServer.cpp
    rts/Server/PerfMetrics.cpp
    rts/Server/RatingSystem.cpp
    rts/Server/RoomManager.cpp
    rts/Server/MapMetadataDb.cpp
    rts/Server/AI/AIDiscovery.cpp
    rts/Server/GameDiscovery.cpp
    rts/Server/ConfigReader.cpp
    rts/Server/ResourcesParser.cpp
)
set(LOBBY_LOG_SOURCES
    rts/System/Log/Backend.cpp
    rts/System/Log/DefaultFilter.cpp
    rts/System/Log/DefaultFormatter.cpp
    rts/System/Log/FileSink.cpp
    rts/System/Log/FramePrefixer.cpp
    rts/System/Log/LogSinkHandler.cpp
    rts/System/Log/LogUtil.c
    rts/System/Log/OutputDebugStringSink.cpp
    rts/System/Log/StreamSink.cpp
)
add_executable(spring-lobby
    rts/lobby_main.cpp
    ${LOBBY_SERVER_SOURCES}
    ${LOBBY_LOG_SOURCES}
    rts/System/SafeCStrings.c
)
add_dependencies(spring-lobby generate_flatbuffers modelimporter)
target_include_directories(spring-lobby PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${CMAKE_SOURCE_DIR}/rts/lib
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/include
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/src
    ${GENERATED_DIR}
)
target_compile_definitions(spring-lobby PRIVATE
    # Absolute path so GameProcessor / FeatureProcessor can shell out
    # to the converter without relying on $PATH. Also lets the stale-
    # glb detector mtime-compare against the actual binary the lobby
    # would invoke, so a rebuilt importer invalidates the model cache.
    MODELIMPORTER_BINARY_PATH="$<TARGET_FILE:modelimporter>"
)
target_link_libraries(spring-lobby PRIVATE lua nghttp2_static flatbuffers ZLIB::ZLIB SQLite3::SQLite3 springlog springlog-net springlog-sqlite)
if(UNIX)
    target_link_libraries(spring-lobby PRIVATE pthread dl)
endif()
if(APPLE)
    find_library(COCOA_FRAMEWORK_LOBBY Cocoa)
    if(COCOA_FRAMEWORK_LOBBY)
        target_link_libraries(spring-lobby PRIVATE ${COCOA_FRAMEWORK_LOBBY})
    endif()
endif()

# === Tests (doctest) ===
include(FetchContent)
FetchContent_Declare(
    doctest
    GIT_REPOSITORY https://github.com/doctest/doctest.git
    GIT_TAG v2.4.12
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(doctest)

file(GLOB TEST_SOURCES tests/*.cpp)
if(TEST_SOURCES)
    add_executable(spring-tests
        ${TEST_SOURCES}
        ${SYSTEM_SOURCES}
        ${GAME_SOURCES}
        ${SIM_SOURCES}
        ${MAP_SOURCES}
        ${LUA_BINDING_SOURCES}
        ${CMAKE_SOURCE_DIR}/rts/Server/CombatEventCollector.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/DebugFlags.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/ProjectileEventCollector.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/SoundEventCollector.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/StandingOrders.cpp
    )
    target_include_directories(spring-tests PRIVATE
        ${CMAKE_SOURCE_DIR}/rts
        ${CMAKE_SOURCE_DIR}/rts/lib
        ${CMAKE_SOURCE_DIR}/rts/lib/lua/include
        ${CMAKE_SOURCE_DIR}/rts/lib/lua/src
        ${CMAKE_SOURCE_DIR}/rts/lib/cereal/include
        ${GENERATED_DIR}
    )
    target_link_libraries(spring-tests PRIVATE lua smmalloc ZLIB::ZLIB doctest::doctest springlog nlohmann_json::nlohmann_json)
    if(UNIX AND NOT APPLE)
        target_link_libraries(spring-tests PRIVATE pthread dl)
    elseif(APPLE)
        target_link_libraries(spring-tests PRIVATE pthread dl)
        if(COCOA_FRAMEWORK)
            target_link_libraries(spring-tests PRIVATE ${COCOA_FRAMEWORK})
        endif()
    endif()
endif()

# === modelimporter — content preprocessing tool ===
#
# Standalone CLI built on modern upstream Assimp (v6.0.4 via FetchContent).
# Converts any model file Assimp can read — OBJ, FBX, COLLADA, BLEND,
# 3DS, LWO, STL, PLY, glTF, plus our custom S3O importer plugin — into
# glTF 2.0 binary, and emits a sibling .meta.lua file containing the
# engine-metadata the synced sim needs (bounding radius/height, piece
# tree, attachment points, ...). The lobby map preprocessor invokes
# this binary via popen() — see rts/Server/FeatureProcessor.cpp.
add_subdirectory(tools/modelimporter)

# === textureconverter — image format conversion tool ===
#
# Standalone CLI using stb_image (header-only, bundled). Converts
# TGA/PNG/BMP/JPG/DDS(DXT1) to PNG. Special --smf-minimap mode for
# Spring map minimap extraction. Replaces the ImageMagick `magick`
# dependency that mapconverter and gameconverter previously shelled
# out to.
add_subdirectory(tools/textureconverter)

# === audioconverter — Opus-in-WebM audio conversion tool ===
#
# Standalone CLI that shells out to ffmpeg to re-encode every game
# audio asset to a single canonical `.webm` (Opus) format. The
# runtime never sees `.wav`/`.ogg`/`.mp3`/`.flac`/`.m4a` again.
# gameconverter invokes this binary for each audio file under a
# game's source tree. ffmpeg is located at configure time; a
# missing ffmpeg is a hard configure-time error unless the entire
# target is opted out via -DSPRING_SKIP_AUDIOCONVERTER=ON.
#
# Declared BEFORE gameconverter so the latter's `if(TARGET
# audioconverter)` check can pick up the target and bake
# AUDIOCONVERTER_BINARY_PATH into the compile definitions.
option(SPRING_SKIP_AUDIOCONVERTER "Skip the audioconverter target (no ffmpeg required)" OFF)
if(NOT SPRING_SKIP_AUDIOCONVERTER)
    add_subdirectory(tools/audioconverter)
else()
    message(STATUS "audioconverter: SKIPPED (SPRING_SKIP_AUDIOCONVERTER=ON)")
endif()

# === gameconverter — content preprocessing tool ===
#
# Standalone CLI that prepares a legacy Spring-archive game for use
# with spring-web. Writes `game.config.lua` (wrapper around
# modinfo.lua) and `lobby.config.lua` (wrapper around modoptions.lua),
# runs modelimporter over every model under objects3d/, and migrates
# legacy AI layouts to the `ai/<name>/main.lua + ai.config.lua`
# convention. See tools/gameconverter/README.md for details.
add_subdirectory(tools/gameconverter)

# === mapconverter — map preprocessing tool ===
#
# Standalone CLI that copies a Spring map's source tree into data/maps/
# and runs all conversion steps (SMF extraction, minimap WebP, feature
# model conversion, decal textures, widget enumeration). Writes metadata
# to SQLite. After this tool has run, the lobby just reads pre-populated
# data/ — no conversion code needed at runtime.
add_subdirectory(tools/mapconverter)

# === spring-logserver (dedicated log collection + streaming server) ===
add_executable(spring-logserver
    rts/logserver_main.cpp
    rts/Server/NetworkServer.cpp
)
add_dependencies(spring-logserver generate_flatbuffers)
target_include_directories(spring-logserver PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${GENERATED_DIR}
)
target_link_libraries(spring-logserver PRIVATE springlog springlog-sqlite nghttp2_static flatbuffers SQLite3::SQLite3 ZLIB::ZLIB)
if(UNIX)
    target_link_libraries(spring-logserver PRIVATE pthread dl)
endif()

# === libspringapi (standalone client library) ===
# WebRTC removed in GW7 — the server is WebTransport-only, so libspringapi's
# WebRTC game-connect path (connectRtc) is dead against it and is built out
# (connectRtc returns nullptr). Lobby/HTTP functionality is unaffected.
# Force OFF so a stale cache from a pre-GW7 build doesn't drag libdatachannel
# back in. TODO: port libspringapi game-connect to a C++ WebTransport client.
set(SPRINGAPI_WEBRTC OFF CACHE BOOL "WebRTC removed (GW7)" FORCE)
add_subdirectory(libspringapi)

# === springcli — CLI tool ===
add_subdirectory(tools/springcli)

# === compile_commands.json symlink for clangd ===
if(CMAKE_EXPORT_COMPILE_COMMANDS)
    file(CREATE_LINK
        ${CMAKE_BINARY_DIR}/compile_commands.json
        ${CMAKE_SOURCE_DIR}/compile_commands.json
        SYMBOLIC
    )
endif()
