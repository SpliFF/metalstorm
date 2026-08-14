cmake_minimum_required(VERSION 3.25)
project(SpringServer LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Build stamp for cache-busting: git short hash + build timestamp. Regenerated
# at BUILD time (not configure time) by the generate_build_stamp target below
# — see that target for why: a plain configure-time stamp goes stale on every
# ordinary incremental `cmake --build`, naming the last configure instead of
# the code actually in the binary.

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
)

# PLAN-security-hardening task 2: production-hardened builds. Compiles OUT
# (not just runtime-403s) the exec/SQL-proxy/test-harness/logserver-write
# surfaces — see `#ifndef SPRING_PROD` blocks at each call site — so a CI
# symbol/string grep against the prod binaries can assert the gated surface
# is genuinely absent, not just unreachable. Dev builds (default, OFF) are
# unchanged: every debugging surface this project lives on stays intact.
option(SPRING_PROD "Build a production-hardened binary (compiles out dev/exec/debug surfaces)" OFF)
if(SPRING_PROD)
    add_definitions(-DSPRING_PROD=1)
    message(STATUS "SPRING_PROD: ON — dev/exec/debug surfaces compiled out")
endif()

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

# OpenSSL crypto for password hashing (scrypt) + secure random session tokens
# (rts/Server/Crypto.cpp — S1/S3). Reuses the same OpenSSL the QUIC stack
# located. spring-server gets libcrypto transitively via quic_deps; spring-lobby
# (no QUIC link) and spring-tests link this leaner interface instead.
add_library(openssl_crypto INTERFACE)
target_include_directories(openssl_crypto INTERFACE ${OPENSSL_QUIC_INCLUDE_DIRS})
target_link_libraries(openssl_crypto INTERFACE ${OPENSSL_QUIC_LINK_LIBRARIES})

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

set(SCHEMA_DIR ${CMAKE_SOURCE_DIR}/schemas)
set(GENERATED_DIR ${CMAKE_BINARY_DIR}/generated)
file(MAKE_DIRECTORY ${GENERATED_DIR})

# === Wire schema: the committed bindings are authoritative, and a build-time
# === guard proves they match schemas/protocol.fbs (PLAN-protocol-guard task 2).
#
# There used to be a second producer here: an add_custom_command writing
# protocol_generated.h into ${GENERATED_DIR}, with four targets depending on it.
# It was dead. Every target lists ${CMAKE_SOURCE_DIR}/rts AHEAD of
# ${GENERATED_DIR}, so `#include "protocol_generated.h"` always resolved to the
# committed copy (confirmed from `ninja -t deps`) and the generated one was
# written and ignored — which is how the committed header sat five days stale
# behind an fbs edit while every build "regenerated" it. Include order had
# already elected the committed copy, so that is now the single source; the
# generator is gone rather than the include order reshuffled, which would have
# made the committed bindings dead files that git still diffs.
#
# scripts/regen-protocol.sh writes all four derived artefacts (C++ bindings, TS
# bindings, and the two schema-hash files); this guard fails the build if the
# schema moved without it. flatc is still built — the guard depends on it, and
# the regen script finds it in any configured build dir.
file(REMOVE ${GENERATED_DIR}/protocol_generated.h)  # sweep the dead copy out of existing build dirs
add_custom_command(
    OUTPUT ${GENERATED_DIR}/protocol-schema-hash.stamp
    COMMAND ${CMAKE_COMMAND}
        -DFLATC=$<TARGET_FILE:flatc>
        -DSCHEMA=${SCHEMA_DIR}/protocol.fbs
        -DCPP_HEADER=${CMAKE_SOURCE_DIR}/rts/Server/ProtocolSchemaHash.h
        -DTS_FILE=${CMAKE_SOURCE_DIR}/client/src/protocol/schema-hash.ts
        -DWORK_DIR=${GENERATED_DIR}
        -DSTAMP=${GENERATED_DIR}/protocol-schema-hash.stamp
        -P ${CMAKE_SOURCE_DIR}/cmake/CheckProtocolSchemaHash.cmake
    BYPRODUCTS ${GENERATED_DIR}/protocol.bfbs
    DEPENDS
        ${SCHEMA_DIR}/protocol.fbs
        ${CMAKE_SOURCE_DIR}/rts/Server/ProtocolSchemaHash.h
        ${CMAKE_SOURCE_DIR}/client/src/protocol/schema-hash.ts
        ${CMAKE_SOURCE_DIR}/cmake/CheckProtocolSchemaHash.cmake
        flatc
    COMMENT "Checking protocol.fbs against the committed schema hash"
    VERBATIM
)
add_custom_target(check_protocol_schema DEPENDS ${GENERATED_DIR}/protocol-schema-hash.stamp)

# === Build stamp header (git short hash + build timestamp) ===
# Runs the git rev-parse + header write at BUILD time via a custom target
# with no OUTPUT-based dependency tracking, so it re-runs on every
# `cmake --build` invocation (not just once per configure) and always names
# the commit actually being linked. GenerateBuildStamp.cmake only rewrites
# the header when its content changed, so a rebuild within the same second
# doesn't force a needless recompile of the handful of TUs that include it.
add_custom_target(generate_build_stamp ALL
    COMMAND ${CMAKE_COMMAND}
        -DOUTPUT_HEADER=${GENERATED_DIR}/BuildStamp.h
        -DSPRING_SOURCE_DIR=${CMAKE_SOURCE_DIR}
        -P ${CMAKE_SOURCE_DIR}/cmake/GenerateBuildStamp.cmake
    BYPRODUCTS ${GENERATED_DIR}/BuildStamp.h
    COMMENT "Regenerating build stamp"
    VERBATIM
)

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

add_dependencies(spring-server check_protocol_schema generate_build_stamp)
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
    rts/Server/Crypto.cpp
    rts/Server/NetworkServer.cpp
    rts/Server/PerfMetrics.cpp
    rts/Server/RatingSystem.cpp
    rts/Server/RoomManager.cpp
    # PLAN-metalstorm-lobby.md task 4: the lobby reads the account↔war seat
    # table (and the faction override deletes from it); the game server writes
    # it. Pure sqlite, no sim — same shape as GameServersDb below.
    rts/Server/WarPlayerBindings.cpp
    # PLAN-metalstorm-lobby.md task 8a: rotating refresh tokens + per-war
    # reconnect tokens. The LOBBY mints both and the GAME server validates the
    # war half, so it belongs to the shared server sources, not to either one.
    rts/Server/AuthTokens.cpp
    # PLAN-metalstorm-lobby.md task 8d: optional TOTP. Linked into the lobby
    # for the enrolment routes, and into the game server (via the rts/Server
    # glob) because HttpAuth::ValidateAuth consults the enrolment table on
    # every Basic-auth request there too.
    rts/Server/Totp.cpp
    # PLAN-metalstorm-lobby.md task 8c: guest/provisional accounts. Shared for
    # the same reason as AuthTokens — the lobby mints and upgrades them, and
    # the game server reaches `users.is_provisional` through Database on every
    # AuthRequest.
    rts/Server/GuestAccounts.cpp
    rts/Server/MapMetadataDb.cpp
    rts/Server/GameServersDb.cpp
    # PLAN-persistence task 4b: the war's strategic history. Written by the
    # game server's heartbeat, read by the lobby as the rejoin digest — shared
    # for the same reason WarPlayerBindings is. WarLog.cpp is the pure drain
    # arithmetic beside it and has no sim in it either.
    rts/Server/GameEventsDb.cpp
    rts/Server/WarLog.cpp
    # PLAN-metalstorm-ai task 4(b): the AI seats a war takes on while RUNNING.
    # The game server writes and restores them; the lobby is in this list only
    # because RoomManager's delete chokepoint drops them with the room (room
    # ids are reused).
    rts/Server/RuntimeAIRoster.cpp
    # PLAN-persistence task 3b: resume-on-join. Pure policy plus one read-only
    # SELECT against `game_snapshots` — the lobby decides whether a war comes
    # back on its stored world, and needs no part of the sim to do it.
    rts/Server/WarResume.cpp
    # PLAN-persistence task 4d: the transition beside that state. Pure (no
    # sqlite, no room registry) — it only remembers what the broadcast last
    # said and decides whether the change is worth telling a player about.
    rts/Server/WarStateEvents.cpp
    # PLAN-persistence task 3c: the deploy drain. Pure policy plus one popen to
    # ask the game-server binary for its own E1 engine hash — the lobby cannot
    # compute it (separate link target, and it may spawn a binary from another
    # build tree). No sim, no sqlite of its own.
    rts/Server/DeployDrain.cpp
    rts/Server/AI/AIDiscovery.cpp
    rts/Server/GameDiscovery.cpp
    rts/Server/ScenarioDiscovery.cpp
    rts/Server/ScenarioDb.cpp
    rts/Server/ConfigReader.cpp
    rts/Server/ResourcesParser.cpp
    # PLAN-long-uptime task 3: the growth alarms are evaluated game-side and
    # ride game_metrics.extra_json; the lobby links the same module purely to
    # parse them back out for the fleet view, so the JSON shape has exactly
    # one definition. Pure — nlohmann and <cstdlib>, no sim, no sqlite.
    rts/Server/GrowthCounters.cpp
    # PLAN-replay task 4c: the lobby reads .msr headers to list replays and to
    # refuse an unreadable one before forking a server for it. ReplayFile is
    # deliberately free of the sim and the wire schema, so this pulls in only
    # SyncedInputJournal's record type and zlib (already linked).
    rts/Server/ReplayFile.cpp
    rts/Server/SyncedInputJournal.cpp
    rts/Server/FactionData.cpp
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
add_dependencies(spring-lobby check_protocol_schema generate_build_stamp modelimporter mapconverter)
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
    # Absolute path so RunMapConverterPreflight (lobby_main.cpp) can shell
    # out to the map-processing pipeline at startup without relying on
    # $PATH (PLAN-metalstorm-impostors.md M10).
    MAPCONVERTER_BINARY_PATH="$<TARGET_FILE:mapconverter>"
    # Absolute path to the scenario generator, so POST /api/admin/scenarios/
    # generate can shell out to it without depending on the lobby's cwd. Not a
    # target: scenariogen.py is a source file, not a build product, so this is
    # CMAKE_SOURCE_DIR rather than a generator expression.
    SCENARIOGEN_SCRIPT_PATH="${CMAKE_SOURCE_DIR}/tools/mapgen/scenariogen.py"
)
target_link_libraries(spring-lobby PRIVATE lua nghttp2_static flatbuffers ZLIB::ZLIB SQLite3::SQLite3 springlog springlog-net springlog-sqlite nlohmann_json::nlohmann_json openssl_crypto)
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
        ${CMAKE_SOURCE_DIR}/rts/Server/Crypto.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/DebugFlags.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/PlayerTeamEventCollector.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/ProjectileEventCollector.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/RoomManager.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/WarPlayerBindings.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/AuthTokens.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/Totp.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/GuestAccounts.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/ScenarioDiscovery.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/ScenarioDb.cpp
        # GameDiscovery + its ConfigReader backend: test_game_discovery.cpp
        # drives the real `archived` parse out of a real game.config.lua
        # rather than hand-building GameInfo structs (PLAN-endtoend.md D26).
        ${CMAKE_SOURCE_DIR}/rts/Server/GameDiscovery.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/ConfigReader.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/SoundEventCollector.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/StandingOrders.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/RulesParamKeyDict.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/OrgGroups.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/SyncedInputJournal.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/ReplayFile.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/ReplayPlayer.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/NetworkServer.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/Database.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/FactionData.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/GameOverState.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/GameMetrics.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/GrowthCounters.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/GmRollback.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/GameStateStore.cpp
        # PLAN-long-uptime S5 task 6: the entity-state header is where the
        # id-recycle flag rides, so the serializer has to be linked for the
        # test that checks a flagged mask reaches the header without changing
        # the payload. Only needs LosHandler + the unit types, already here.
        ${CMAKE_SOURCE_DIR}/rts/Server/EntityStateSerializer.cpp
        # PLAN-persistence task 1b: the ISimSerializer walk. Needs the sim
        # globals (gs/gsRNG) and the two order managers, all of which
        # spring-tests already links, so its round-trip is a plain doctest.
        ${CMAKE_SOURCE_DIR}/rts/Server/SimSnapshot.cpp
        # PLAN-persistence §8: the round-trip driver. Pure (std-lib only) in the
        # HeadlessRun shape — the engine-coupled half is one block in
        # server_main.cpp, so the state machine and the verdict test off-engine.
        ${CMAKE_SOURCE_DIR}/rts/Server/SnapshotRoundTrip.cpp
        # PLAN-persistence task 3a: the hibernate/resume decisions. Pure
        # (std-lib only) — the engine-coupled half is the wiring in
        # server_main.cpp, so both policies test off-engine.
        ${CMAKE_SOURCE_DIR}/rts/Server/Hibernation.cpp
        # PLAN-persistence task 3b: the LOBBY's half of the same lifecycle.
        # Policy is pure; the one DB read is a plain SELECT (sqlite3 only, no
        # sim), so the whole file tests here against an in-memory database.
        ${CMAKE_SOURCE_DIR}/rts/Server/WarResume.cpp
        # PLAN-persistence task 4d: the transition detector (test_war_state_events.cpp).
        ${CMAKE_SOURCE_DIR}/rts/Server/WarStateEvents.cpp
        # PLAN-persistence task 3c: the deploy drain's policy half. Pure —
        # the only impure function (the popen probe) has its parser tested
        # here and its fork exercised live.
        ${CMAKE_SOURCE_DIR}/rts/Server/DeployDrain.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/GameServersDb.cpp
        # PLAN-persistence task 4b: the rejoin digest's store and the pure
        # ring-drain arithmetic that decides whether it is complete
        # (test_war_log.cpp).
        ${CMAKE_SOURCE_DIR}/rts/Server/GameEventsDb.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/WarLog.cpp
        # PLAN-metalstorm-ai task 4(b)'s durability half: the table plus the
        # pure restore policy (test_runtime_ai_roster.cpp). The two halves that
        # need a sim live in AISpawnService.cpp, which does not link here.
        ${CMAKE_SOURCE_DIR}/rts/Server/RuntimeAIRoster.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/HeadlessRun.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/StatsDump.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/AI/AIScriptContext.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/AI/AICommandQueue.cpp
        # I1/SG1: the AI-command journal codec, split out of StateStreamer.cpp
        # so its round-trip (kind byte + text payload) is a plain doctest —
        # StateStreamer.cpp itself is not linkable here.
        ${CMAKE_SOURCE_DIR}/rts/Server/AI/AICommandCodec.cpp
        # task 4(b): the mid-game AI spawn hook's decidable half — the relay,
        # the spawn policy and the plugin resolver (test_ai_spawn.cpp). The
        # half that needs playerHandler/teamHandler lives in AISpawnService.cpp
        # and is deliberately NOT here; it is verified on the running stack.
        ${CMAKE_SOURCE_DIR}/rts/Server/AI/AISpawn.cpp
        ${CMAKE_SOURCE_DIR}/rts/Server/AI/AIDiscovery.cpp
    )
    target_include_directories(spring-tests PRIVATE
        ${CMAKE_SOURCE_DIR}/rts
        ${CMAKE_SOURCE_DIR}/rts/lib
        ${CMAKE_SOURCE_DIR}/rts/lib/lua/include
        ${CMAKE_SOURCE_DIR}/rts/lib/lua/src
        ${CMAKE_SOURCE_DIR}/rts/lib/cereal/include
        ${GENERATED_DIR}
    )
    # flatbuffers is header-only for our use here: test_synced_input_journal.cpp
    # includes protocol_generated.h to walk EnumValuesClientPayload(), which is
    # how the synced-input classifier is proved exhaustive against the real wire
    # schema instead of against a copy of it (PLAN-replay task 1).
    add_dependencies(spring-tests check_protocol_schema generate_build_stamp)
    target_link_libraries(spring-tests PRIVATE lua smmalloc ZLIB::ZLIB doctest::doctest springlog nlohmann_json::nlohmann_json openssl_crypto nghttp2_static SQLite3::SQLite3 flatbuffers)
    # Absolute path to the source tree so tests can open checked-in fixtures
    # (e.g. the strategos AI plugin) regardless of the ctest working dir.
    target_compile_definitions(spring-tests PRIVATE SPRING_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
    if(UNIX AND NOT APPLE)
        target_link_libraries(spring-tests PRIVATE pthread dl)
    elseif(APPLE)
        target_link_libraries(spring-tests PRIVATE pthread dl)
        if(COCOA_FRAMEWORK)
            target_link_libraries(spring-tests PRIVATE ${COCOA_FRAMEWORK})
        endif()
    endif()

    # CTest wiring (B2). `enable_testing()` + add_test() so `ctest` and the
    # testPresets in CMakePresets.json actually run the doctest binary. The
    # Makefile's `make test-cpp` runs this target too (was wrongly pointed at
    # spring-server before).
    enable_testing()
    add_test(NAME spring-tests COMMAND spring-tests)
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
add_dependencies(spring-logserver check_protocol_schema generate_build_stamp)
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
# WebRTC game-connect path was deleted (WP5.4): connectRtc is now an inert stub
# returning nullptr, and the SPRINGAPI_WEBRTC option / libdatachannel dep are
# gone. Lobby/HTTP functionality is unaffected.
# TODO: port libspringapi game-connect to a C++ WebTransport client.
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
