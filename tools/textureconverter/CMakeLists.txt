# textureconverter — KTX2 producer for spring-web.
#
# Reads DDS, TGA, PNG, JPG, BMP, or raw DXT1 block streams; writes
# KTX2 (UASTC or ETC1S, optionally Zstd-supercompressed). Linked
# against libktx (KhronosGroup/KTX-Software) for the encoder and
# Basis Universal pipeline.
#
# Source readers stay header-only (stb_image), so we do not pull
# any image libraries beyond libktx itself. The previous role of
# this tool — producing PNG copies of game textures and decoding
# the SMF minimap to PNG — is gone; everything funnels through
# KTX2 now.

cmake_minimum_required(VERSION 3.25)

add_executable(textureconverter
    main.cpp
)
target_link_libraries(textureconverter PRIVATE springlog ktx)
target_include_directories(textureconverter PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${CMAKE_CURRENT_SOURCE_DIR}
)
set_target_properties(textureconverter PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)
