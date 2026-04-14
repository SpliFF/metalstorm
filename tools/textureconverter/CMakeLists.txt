# textureconverter — convert textures for spring-web.
#
# Standalone CLI with no external dependencies beyond stb (header-only,
# bundled). Replaces the ImageMagick `magick` dependency that was
# previously shelled out to by mapconverter and gameconverter.
#
# Supports reading TGA, PNG, BMP, JPG (via stb_image) and DDS/DXT1
# (custom decoder). Writes PNG via stb_image_write. Special
# --smf-minimap mode for Spring map minimap extraction.

cmake_minimum_required(VERSION 3.25)

add_executable(textureconverter
    main.cpp
)
target_link_libraries(textureconverter PRIVATE springlog)
target_include_directories(textureconverter PRIVATE
    ${CMAKE_SOURCE_DIR}/rts
    ${CMAKE_CURRENT_SOURCE_DIR}
)
set_target_properties(textureconverter PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)
