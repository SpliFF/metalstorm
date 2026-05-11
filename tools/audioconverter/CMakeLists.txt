# audioconverter — Opus-in-WebM producer for spring-web.
#
# Re-encodes source audio assets (.wav/.ogg/.mp3/.flac/.m4a, any case)
# to a single canonical `.webm` (Opus) output. Backend is the
# `ffmpeg` binary, located at configure time — audio conversion is
# not optional once the migration is on, so a missing ffmpeg is a
# hard configure-time failure rather than a runtime surprise.
#
# Like textureconverter and modelimporter, this tool does not link
# against the engine. It is `springlog` + `<filesystem>` + a popen
# wrapper around ffmpeg.

cmake_minimum_required(VERSION 3.25)

# ffmpeg is the only backend audioconverter understands. The plan
# specifies "fail at CMake-configure time if not found" so a missing
# ffmpeg is surfaced loudly rather than discovered the first time
# gameconverter tries to run.
find_program(FFMPEG_EXECUTABLE ffmpeg
    HINTS /opt/homebrew/bin /usr/local/bin)
if(NOT FFMPEG_EXECUTABLE)
    message(FATAL_ERROR
        "ffmpeg not found in PATH — audioconverter requires it to "
        "re-encode source audio to Opus-in-WebM. Install ffmpeg "
        "(brew install ffmpeg / apt-get install ffmpeg) and re-run "
        "cmake. To skip the audioconverter target entirely (e.g. on "
        "a CI host that doesn't need content prep), pass "
        "-DSPRING_SKIP_AUDIOCONVERTER=ON to cmake.")
endif()
message(STATUS "audioconverter: ffmpeg at ${FFMPEG_EXECUTABLE}")

add_executable(audioconverter
    main.cpp
)
target_compile_definitions(audioconverter PRIVATE
    FFMPEG_BINARY_PATH="${FFMPEG_EXECUTABLE}"
)
target_link_libraries(audioconverter PRIVATE springlog)
target_include_directories(audioconverter PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${CMAKE_CURRENT_SOURCE_DIR}
)
set_target_properties(audioconverter PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)
