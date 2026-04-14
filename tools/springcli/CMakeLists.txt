# springcli — CLI tool built on libspringapi.

cmake_minimum_required(VERSION 3.25)

add_executable(springcli
    main.cpp
)
target_link_libraries(springcli PRIVATE springapi)
set_target_properties(springcli PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)
