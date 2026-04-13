# springcli — CLI tool for interacting with Spring RTS Web servers.
# Also builds libspringapi as a static library.

cmake_minimum_required(VERSION 3.25)

# libspringapi — shared library for HTTP-based server interaction
add_library(springapi STATIC
    springapi.cpp
)
target_include_directories(springapi PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
set_target_properties(springapi PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)

# springcli — CLI executable
add_executable(springcli
    main.cpp
)
target_link_libraries(springcli PRIVATE springapi)
set_target_properties(springcli PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)
