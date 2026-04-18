cmake_minimum_required(VERSION 3.25)
project(SpringServer LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Headless server defines
add_definitions(
    -DHEADLESS
    -DNO_SOUND
    -DBITMAP_NO_OPENGL
    -DNOT_USING_CREG
    -DAUTHORITATIVE_SERVER
    -DDEDICATED_NOSSE
)

# Suppress warnings from legacy code during cleanup
add_compile_options(-Wno-unused-variable -Wno-unused-function -Wno-sign-compare)

# Platform defines
if(WIN32)
    add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN)
endif()

# Include paths — the rts/ directory is the root for Spring includes
include_directories(${CMAKE_SOURCE_DIR}/rts)

# === Bundled Lua 5.1 (Spring's C++ build of Lua) ===
file(GLOB LUA_SOURCES rts/lib/lua/src/*.cpp)
list(FILTER LUA_SOURCES EXCLUDE REGEX "lua\\.cpp$|luac\\.cpp$")
list(APPEND LUA_SOURCES rts/lib/lua/include/LuaUser.cpp)
add_library(lua STATIC ${LUA_SOURCES})
target_include_directories(lua PUBLIC rts/lib/lua/include rts/lib/lua/src)
target_compile_definitions(lua PRIVATE LUA_USE_POSIX LUA_USE_DLOPEN)

# === Collect all sim sources ===

# System utilities (platform-independent core)
file(GLOB_RECURSE SYSTEM_SOURCES
    rts/System/*.cpp
    rts/System/*.c
)
# Exclude bundled libraries (they have their own targets)
list(FILTER SYSTEM_SOURCES EXCLUDE REGEX "rts/lib/")

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

# === spring-server executable ===
add_executable(spring-server
    rts/server_main.cpp
    ${SYSTEM_SOURCES}
    ${GAME_SOURCES}
    ${SIM_SOURCES}
    ${MAP_SOURCES}
    ${LUA_BINDING_SOURCES}
)

target_include_directories(spring-server PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${CMAKE_SOURCE_DIR}/rts/lib
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/include
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/src
)
find_package(ZLIB REQUIRED)
target_link_libraries(spring-server PRIVATE lua ZLIB::ZLIB)

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

# === compile_commands.json symlink for clangd ===
if(CMAKE_EXPORT_COMPILE_COMMANDS)
    file(CREATE_LINK
        ${CMAKE_BINARY_DIR}/compile_commands.json
        ${CMAKE_SOURCE_DIR}/compile_commands.json
        SYMBOLIC
    )
endif()
