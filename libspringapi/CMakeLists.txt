# libspringapi — standalone client library for Spring RTS Web servers.
#
# Build:
#   cmake -B build
#   cmake --build build
#
# Options:
#   -DSPRINGAPI_WEBRTC=ON    Enable WebRTC support (requires libdatachannel)
#   -DSPRINGAPI_PYTHON=ON    Build Python bindings (requires pybind11)

cmake_minimum_required(VERSION 3.25)
project(springapi LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(SPRINGAPI_WEBRTC "Enable WebRTC data channel support" OFF)
option(SPRINGAPI_PYTHON "Build Python bindings" OFF)

# --- Core library (HTTP only, zero dependencies) ---
add_library(springapi STATIC
    src/http.cpp
    src/rtc.cpp
)
target_include_directories(springapi PUBLIC include)

# --- WebRTC support ---
if(SPRINGAPI_WEBRTC)
    # If building as part of the engine tree, libdatachannel is already available
    if(TARGET LibDataChannel::LibDataChannelStatic)
        target_link_libraries(springapi PRIVATE LibDataChannel::LibDataChannelStatic)
    else()
        # Standalone build: fetch libdatachannel
        include(FetchContent)
        set(NO_MEDIA ON CACHE BOOL "" FORCE)
        set(NO_WEBSOCKET ON CACHE BOOL "" FORCE)
        set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
        set(NO_TESTS ON CACHE BOOL "" FORCE)
        set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)
        FetchContent_Declare(
            libdatachannel
            GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
            GIT_TAG v0.22.5
            GIT_SHALLOW TRUE
        )
        FetchContent_MakeAvailable(libdatachannel)
        target_link_libraries(springapi PRIVATE LibDataChannel::LibDataChannelStatic)
    endif()
    target_compile_definitions(springapi PRIVATE SPRINGAPI_HAS_WEBRTC)
endif()

# --- Python bindings ---
if(SPRINGAPI_PYTHON)
    find_package(pybind11 QUIET)
    if(NOT pybind11_FOUND)
        include(FetchContent)
        FetchContent_Declare(
            pybind11
            GIT_REPOSITORY https://github.com/pybind/pybind11.git
            GIT_TAG v2.13.6
            GIT_SHALLOW TRUE
        )
        FetchContent_MakeAvailable(pybind11)
    endif()

    pybind11_add_module(pyspringapi src/python.cpp)
    target_link_libraries(pyspringapi PRIVATE springapi)
endif()
