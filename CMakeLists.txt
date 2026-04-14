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

# Headless server defines
add_definitions(
    -DHEADLESS
    -DNO_SOUND
    -DBITMAP_NO_OPENGL
    -DNOT_USING_CREG
    -DAUTHORITATIVE_SERVER
    -DDEDICATED_NOSSE
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

# === nghttp2 (HTTP/2 library) ===
include(FetchContent)

# nghttp2: build only the static library, no tools/examples/docs.
# Use manual FetchContent_Populate to scope variables without affecting
# other dependencies (doctest, libdatachannel, etc.).
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

# === libdatachannel (WebRTC data channels) ===
# Workaround: libdatachannel's plog dep uses old cmake_minimum_required
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)
set(NO_MEDIA ON CACHE BOOL "" FORCE)          # data channels only, no audio/video
set(NO_WEBSOCKET ON CACHE BOOL "" FORCE)      # we have our own HTTP, don't need WS
set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
set(NO_TESTS ON CACHE BOOL "" FORCE)
FetchContent_Declare(
    libdatachannel
    GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
    GIT_TAG v0.22.5
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(libdatachannel)

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

# === Collect all sim sources ===

# System utilities (platform-independent core)
file(GLOB_RECURSE SYSTEM_SOURCES
    rts/System/*.cpp
    rts/System/*.c
)
# Exclude bundled libraries and SpringLog (they have their own targets)
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "rts/lib/")
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "rts/System/SpringLog/")

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

# Simulation sources
file(GLOB_RECURSE SIM_SOURCES rts/Sim/*.cpp)

# Map sources
file(GLOB_RECURSE MAP_SOURCES rts/Map/*.cpp)

# Lua binding sources
file(GLOB_RECURSE LUA_BINDING_SOURCES rts/Lua/*.cpp)

# Server sources
file(GLOB_RECURSE SERVER_SOURCES rts/Server/*.cpp)

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
    ${GENERATED_DIR}
)
find_package(ZLIB REQUIRED)
target_link_libraries(spring-server PRIVATE lua nghttp2_static flatbuffers ZLIB::ZLIB SQLite::SQLite3 springlog springlog-net springlog-sqlite LibDataChannel::LibDataChannelStatic)

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
add_dependencies(spring-lobby generate_flatbuffers)
target_include_directories(spring-lobby PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${CMAKE_SOURCE_DIR}/rts/lib
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/include
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/src
    ${GENERATED_DIR}
)
target_link_libraries(spring-lobby PRIVATE lua nghttp2_static flatbuffers ZLIB::ZLIB SQLite::SQLite3 springlog springlog-net springlog-sqlite)
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
    )
    target_include_directories(spring-tests PRIVATE
        ${CMAKE_SOURCE_DIR}/rts
        ${CMAKE_SOURCE_DIR}/rts/lib
        ${CMAKE_SOURCE_DIR}/rts/lib/lua/include
        ${CMAKE_SOURCE_DIR}/rts/lib/lua/src
        ${GENERATED_DIR}
    )
    target_link_libraries(spring-tests PRIVATE lua ZLIB::ZLIB doctest::doctest springlog)
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

# === textureconverter — image format conversion tool ===
#
# Standalone CLI using stb_image (header-only, bundled). Converts
# TGA/PNG/BMP/JPG/DDS(DXT1) to PNG. Special --smf-minimap mode for
# Spring map minimap extraction. Replaces the ImageMagick `magick`
# dependency that mapconverter and gameconverter previously shelled
# out to.
add_subdirectory(tools/textureconverter)

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
target_link_libraries(spring-logserver PRIVATE springlog springlog-sqlite nghttp2_static flatbuffers SQLite::SQLite3 ZLIB::ZLIB)
if(UNIX)
    target_link_libraries(spring-logserver PRIVATE pthread dl)
endif()

# === libspringapi (standalone client library) ===
set(SPRINGAPI_WEBRTC ON CACHE BOOL "Enable WebRTC in libspringapi" FORCE)
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
