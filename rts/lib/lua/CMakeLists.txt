# Lua 5.4.7 — standard upstream, compiled as C++

INCLUDE_DIRECTORIES(BEFORE include)

file(GLOB luaSources "src/*.cpp")

ADD_LIBRARY(lua STATIC EXCLUDE_FROM_ALL ${luaSources})
target_include_directories(lua PUBLIC include src)

# Lua 5.4 needs math library on Unix
if (UNIX)
    target_link_libraries(lua m)
    target_compile_definitions(lua PRIVATE LUA_USE_POSIX)
endif()
