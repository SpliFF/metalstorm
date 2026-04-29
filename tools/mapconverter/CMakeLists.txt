# mapconverter — preprocess Spring maps for spring-web.
#
# Standalone CLI tool. Copies a map's source tree into data/maps/<id>/,
# runs SMF extraction, minimap/texture/feature conversion, and writes
# metadata to SQLite. After this tool has run, the lobby just reads
# pre-populated data/ + SQLite — no conversion code needed at runtime.
#
# Reuses MapProcessor and FeatureProcessor source files from the server
# so the processing logic has a single source of truth.

cmake_minimum_required(VERSION 3.25)

add_executable(mapconverter
    main.cpp
    # Reuse the server's processing + metadata code directly
    ${CMAKE_SOURCE_DIR}/rts/Server/MapProcessor.cpp
    ${CMAKE_SOURCE_DIR}/rts/Server/MapMetadataDb.cpp
    ${CMAKE_SOURCE_DIR}/rts/Server/FeatureProcessor.cpp
    ${CMAKE_SOURCE_DIR}/rts/System/FileSystem/LuaVFSSimple.cpp
    ${CMAKE_SOURCE_DIR}/rts/System/FileSystem/FileHandler.cpp
    ${CMAKE_SOURCE_DIR}/rts/System/SafeCStrings.c
)
add_dependencies(mapconverter modelimporter textureconverter)
target_compile_definitions(mapconverter PRIVATE
    MODELIMPORTER_BINARY_PATH="$<TARGET_FILE:modelimporter>"
    TEXTURECONVERTER_BINARY_PATH="$<TARGET_FILE:textureconverter>"
)
target_include_directories(mapconverter PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${CMAKE_SOURCE_DIR}/rts/lib
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/include
    ${CMAKE_SOURCE_DIR}/rts/lib/lua/src
    ${GENERATED_DIR}
)
target_link_libraries(mapconverter PRIVATE lua SQLite::SQLite3 springlog springlog-net)
set_target_properties(mapconverter PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)
