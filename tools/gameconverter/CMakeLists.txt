# gameconverter — prepare a legacy Spring-archive game for spring-web.
#
# Standalone CLI tool. Copies source tree to data/games/<id>/, writes
# game.config.lua / lobby.config.lua wrappers, shells out to
# modelimporter to pre-bake models, converts textures via
# textureconverter, and migrates the ai/ directory. No engine links,
# no sim deps — just C++17 with <filesystem>.

cmake_minimum_required(VERSION 3.25)

add_executable(gameconverter
    main.cpp
)
add_dependencies(gameconverter modelimporter textureconverter)
target_compile_definitions(gameconverter PRIVATE
    TEXTURECONVERTER_BINARY_PATH="$<TARGET_FILE:textureconverter>"
)
# audioconverter is optional at the top-level CMakeLists.txt (it
# may be skipped if ffmpeg isn't installed). When present, plumb
# the binary path through so gameconverter can shell out to it;
# when absent, gameconverter falls back to "audioconverter" on PATH
# and logs a clear warning if that doesn't resolve either.
if(TARGET audioconverter)
    add_dependencies(gameconverter audioconverter)
    target_compile_definitions(gameconverter PRIVATE
        AUDIOCONVERTER_BINARY_PATH="$<TARGET_FILE:audioconverter>"
    )
endif()
target_link_libraries(gameconverter PRIVATE springlog springlog-net)
set_target_properties(gameconverter PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)
