# gameconverter — prepare a legacy Spring-archive game for spring-web.
#
# Standalone CLI tool. Writes a tiny `game.config.lua` wrapper that
# defers to the legacy modinfo.lua / modoptions.lua at runtime,
# shells out to modelimporter to pre-bake the game's models, and
# migrates the `ai/` directory into the new `<name>/main.lua`
# + `ai.config.lua` layout. No engine links, no sim deps — just
# C++17 with <filesystem>.

cmake_minimum_required(VERSION 3.25)

add_executable(gameconverter
    main.cpp
)
set_target_properties(gameconverter PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)
