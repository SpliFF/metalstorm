# SpringLog — unified logging library for Spring RTS Web.

# --- Core: zero mandatory dependencies (libc + POSIX + C++ std::mutex) ---
add_library(springlog SHARED
    SpringLog.cpp
)
target_include_directories(springlog PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
set_target_properties(springlog PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    POSITION_INDEPENDENT_CODE ON
    SOVERSION 1
)

# --- Optional: network sink (WebSocket + FlatBuffers to log server) ---
add_library(springlog-net STATIC
    SpringLogNet.cpp
)
target_include_directories(springlog-net PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(springlog-net PUBLIC springlog)

# --- Optional: SQLite sink ---
add_library(springlog-sqlite STATIC
    SpringLogSqlite.cpp
)
target_include_directories(springlog-sqlite PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(springlog-sqlite PUBLIC springlog SQLite::SQLite3)
