// textureconverter — convert textures between formats for spring-web.
//
// Standalone CLI with no external dependencies (uses stb_image for
// reading, stb_image_write for writing). Replaces the ImageMagick
// `magick` dependency used by mapconverter and gameconverter.
//
// Modes:
//   textureconverter <input> <output>
//     Convert TGA, BMP, JPG, or PNG to PNG. DDS files are left alone
//     — they're GPU-compressed formats served directly to the client
//     and loaded via WEBGL_compressed_texture_s3tc.
//
//   textureconverter --smf-minimap <input.smf> <output.png>
//     Extract the 1024×1024 DXT1 minimap from an SMF file, decode it,
//     aspect-correct it, and write both a full-size PNG and a 256px
//     thumbnail. This is the one case where DXT1 decoding is needed
//     — the minimap is displayed as a regular image in the lobby UI.

#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#include "stb_image.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include "stb_image_resize2.h"

#include "System/SpringLog/SpringLog.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#define LOG_SECTION "tex-convert"

namespace fs = std::filesystem;

// ============================================================
// DXT1 decoding (only used for SMF minimap extraction)
// ============================================================

/// Decode a DXT1 block stream into RGB pixels.
static std::vector<uint8_t> DecodeDxt1(const uint8_t* dxt, int w, int h) {
    std::vector<uint8_t> rgb(w * h * 3);
    for (int by = 0; by < h / 4; ++by) {
        for (int bx = 0; bx < w / 4; ++bx) {
            const uint8_t* src = &dxt[(by * (w / 4) + bx) * 8];
            const uint16_t c0 = static_cast<uint16_t>(src[0] | (src[1] << 8));
            const uint16_t c1 = static_cast<uint16_t>(src[2] | (src[3] << 8));
            const uint32_t bits =
                static_cast<uint32_t>(src[4])         |
                (static_cast<uint32_t>(src[5]) << 8)  |
                (static_cast<uint32_t>(src[6]) << 16) |
                (static_cast<uint32_t>(src[7]) << 24);

            uint8_t colors[4][3];
            colors[0][0] = static_cast<uint8_t>(((c0 >> 11) & 0x1f) * 255 / 31);
            colors[0][1] = static_cast<uint8_t>(((c0 >>  5) & 0x3f) * 255 / 63);
            colors[0][2] = static_cast<uint8_t>(( c0        & 0x1f) * 255 / 31);
            colors[1][0] = static_cast<uint8_t>(((c1 >> 11) & 0x1f) * 255 / 31);
            colors[1][1] = static_cast<uint8_t>(((c1 >>  5) & 0x3f) * 255 / 63);
            colors[1][2] = static_cast<uint8_t>(( c1        & 0x1f) * 255 / 31);
            if (c0 > c1) {
                for (int i = 0; i < 3; ++i) {
                    colors[2][i] = static_cast<uint8_t>((2 * colors[0][i] + colors[1][i]) / 3);
                    colors[3][i] = static_cast<uint8_t>((colors[0][i] + 2 * colors[1][i]) / 3);
                }
            } else {
                for (int i = 0; i < 3; ++i) {
                    colors[2][i] = static_cast<uint8_t>((colors[0][i] + colors[1][i]) / 2);
                }
                colors[3][0] = colors[3][1] = colors[3][2] = 0;
            }

            for (int py = 0; py < 4; ++py) {
                for (int px = 0; px < 4; ++px) {
                    const int idx = (bits >> (2 * (py * 4 + px))) & 3;
                    const int x = bx * 4 + px;
                    const int y = by * 4 + py;
                    const int o = (y * w + x) * 3;
                    rgb[o + 0] = colors[idx][0];
                    rgb[o + 1] = colors[idx][1];
                    rgb[o + 2] = colors[idx][2];
                }
            }
        }
    }
    return rgb;
}

// ============================================================
// SMF minimap extraction
// ============================================================

/// Extract the SMF minimap and write two files:
///   - <outputPath>  — raw DXT1 block data (1024×1024, no header).
///                      The client knows the dimensions from map metadata
///                      and uploads straight to a GL compressed texture.
///   - thumbnail.png — small PNG for the lobby preview card (the one
///                      place where a DOM <img> is genuinely simpler).
static int ExtractSmfMinimap(const std::string& smfPath,
                             const std::string& outputPath) {
    std::ifstream smf(smfPath, std::ios::binary);
    if (!smf.is_open()) {
        SLOG(SPRING_LOG_ERROR, "cannot open SMF: %s", smfPath.c_str());
        return 1;
    }

    smf.seekg(24);
    int mapx = 0, mapy = 0;
    smf.read(reinterpret_cast<char*>(&mapx), 4);
    smf.read(reinterpret_cast<char*>(&mapy), 4);

    smf.seekg(64);
    int minimapPtr = 0;
    smf.read(reinterpret_cast<char*>(&minimapPtr), 4);
    if (minimapPtr <= 0) {
        SLOG(SPRING_LOG_ERROR, "invalid minimap pointer in SMF");
        return 1;
    }

    constexpr int W = 1024, H = 1024;
    smf.seekg(minimapPtr);
    const size_t dxtSize = W * H / 2; // 524288 bytes = DXT1 mip0 at 1024²
    std::vector<uint8_t> dxt(dxtSize);
    smf.read(reinterpret_cast<char*>(dxt.data()),
             static_cast<std::streamsize>(dxtSize));
    if (!smf.good()) {
        SLOG(SPRING_LOG_ERROR, "short read on SMF minimap");
        return 1;
    }
    smf.close();

    // Write raw DXT1 block data — no header, extension tells the client
    // the format. Client knows it's 1024×1024 from map metadata.
    {
        std::ofstream out(outputPath, std::ios::binary);
        if (!out.is_open()) {
            SLOG(SPRING_LOG_ERROR, "failed to open %s", outputPath.c_str());
            return 1;
        }
        out.write(reinterpret_cast<const char*>(dxt.data()),
                  static_cast<std::streamsize>(dxtSize));
        if (!out.good()) {
            SLOG(SPRING_LOG_ERROR, "failed to write %s", outputPath.c_str());
            return 1;
        }
    }
    SLOG(SPRING_LOG_INFO, "wrote minimap %dx%d DXT1 (%zu bytes): %s",
        W, H, dxtSize, outputPath.c_str());

    // Thumbnail: decode DXT1, aspect-correct, resize to 256px, write PNG.
    // This is the one image that needs a browser-native format — it's
    // shown as a preview card in the lobby map list.
    std::vector<uint8_t> rgb = DecodeDxt1(dxt.data(), W, H);

    int thumbW, thumbH;
    if (mapx >= mapy) {
        thumbW = 256;  thumbH = (256 * mapy) / mapx;
    } else {
        thumbH = 256;  thumbW = (256 * mapx) / mapy;
    }
    if (thumbW < 1) thumbW = 1;
    if (thumbH < 1) thumbH = 1;

    std::vector<uint8_t> thumbRgb(thumbW * thumbH * 3);
    stbir_resize_uint8_linear(
        rgb.data(), W, H, 0,
        thumbRgb.data(), thumbW, thumbH, 0,
        STBIR_RGB);

    fs::path thumbPath = fs::path(outputPath).parent_path() / "thumbnail.png";
    if (!stbi_write_png(thumbPath.string().c_str(), thumbW, thumbH, 3,
                        thumbRgb.data(), thumbW * 3)) {
        SLOG(SPRING_LOG_ERROR, "failed to write %s", thumbPath.string().c_str());
        return 1;
    }
    SLOG(SPRING_LOG_INFO, "wrote thumbnail %dx%d: %s", thumbW, thumbH,
        thumbPath.string().c_str());

    return 0;
}

// ============================================================
// General texture conversion
// ============================================================

/// Check if a file starts with "DDS " magic.
static bool IsDds(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return false;
    char magic[4];
    f.read(magic, 4);
    return f.gcount() == 4 && memcmp(magic, "DDS ", 4) == 0;
}

/// Convert a texture to a web-ready format.
///   - DDS files are already GPU-ready — just copy them as-is.
///   - TGA/BMP/JPG are decoded via stb_image and written as PNG.
static int ConvertTexture(const std::string& inputPath,
                          const std::string& outputPath) {
    if (IsDds(inputPath)) {
        // DDS is already a valid GPU-compressed file with its own header.
        // Copy it to the output path (which may just be a stable rename).
        std::error_code ec;
        fs::copy_file(inputPath, outputPath,
                      fs::copy_options::overwrite_existing, ec);
        if (ec) {
            SLOG(SPRING_LOG_ERROR, "copy failed: %s -> %s: %s",
                inputPath.c_str(), outputPath.c_str(), ec.message().c_str());
            return 1;
        }
        SLOG(SPRING_LOG_INFO, "DDS (copied): %s -> %s",
            inputPath.c_str(), outputPath.c_str());
        return 0;
    }

    // Non-DDS: decode via stb_image, write PNG
    int w, h, channels;
    uint8_t* pixels = stbi_load(inputPath.c_str(), &w, &h, &channels, 0);
    if (!pixels) {
        SLOG(SPRING_LOG_ERROR, "failed to load %s: %s",
            inputPath.c_str(), stbi_failure_reason());
        return 1;
    }

    if (!stbi_write_png(outputPath.c_str(), w, h, channels,
                        pixels, w * channels)) {
        SLOG(SPRING_LOG_ERROR, "failed to write %s", outputPath.c_str());
        stbi_image_free(pixels);
        return 1;
    }

    SLOG(SPRING_LOG_INFO, "%dx%dx%d -> %s", w, h, channels,
        outputPath.c_str());
    stbi_image_free(pixels);
    return 0;
}

// ============================================================
// CLI
// ============================================================

static void PrintUsage(const char* argv0) {
    SLOG(SPRING_LOG_NOTICE,
        "convert textures for spring-web.\n"
        "\n"
        "usage:\n"
        "  %s [options] <input> <output>\n"
        "  %s --smf-minimap <input.smf> <output.dxt1>\n"
        "\n"
        "general mode:\n"
        "  TGA/BMP/JPG -> PNG (decoded via stb_image).\n"
        "  DDS -> copied as-is (already GPU-ready, client loads via\n"
        "         WEBGL_compressed_texture_s3tc).\n"
        "\n"
        "minimap mode (--smf-minimap):\n"
        "  Extracts the 1024x1024 DXT1 minimap from a Spring SMF file.\n"
        "  Writes <output> as raw DXT1 block data and a sibling\n"
        "  thumbnail.png (256px, aspect-correct) for lobby preview.\n"
        "\n"
        "options:\n"
        "  --log-level <level>   debug/info/notice/warning/error\n",
        argv0, argv0);
}

int main(int argc, char* argv[]) {
    springlog_init("textureconverter", SPRING_LOG_OUTPUT_CONSOLE);

    std::string inputPath;
    std::string outputPath;
    bool smfMinimap = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--smf-minimap") {
            smfMinimap = true;
        } else if (arg == "--log-level" && i + 1 < argc) {
            const std::string lvl = argv[++i];
            if (lvl == "debug")        springlog_set_min_level(SPRING_LOG_DEBUG);
            else if (lvl == "info")    springlog_set_min_level(SPRING_LOG_INFO);
            else if (lvl == "notice")  springlog_set_min_level(SPRING_LOG_NOTICE);
            else if (lvl == "warning") springlog_set_min_level(SPRING_LOG_WARNING);
            else if (lvl == "error")   springlog_set_min_level(SPRING_LOG_ERROR);
        } else if (arg == "-h" || arg == "--help") {
            PrintUsage(argv[0]);
            springlog_shutdown();
            return 0;
        } else if (!arg.empty() && arg[0] == '-') {
            SLOG(SPRING_LOG_ERROR, "unknown option: %s", arg.c_str());
            springlog_shutdown();
            return 2;
        } else if (inputPath.empty()) {
            inputPath = arg;
        } else if (outputPath.empty()) {
            outputPath = arg;
        }
    }

    if (inputPath.empty() || outputPath.empty()) {
        PrintUsage(argv[0]);
        springlog_shutdown();
        return 2;
    }

    std::error_code ec;
    fs::path outDir = fs::path(outputPath).parent_path();
    if (!outDir.empty())
        fs::create_directories(outDir, ec);

    int rc;
    if (smfMinimap) {
        rc = ExtractSmfMinimap(inputPath, outputPath);
    } else {
        rc = ConvertTexture(inputPath, outputPath);
    }

    springlog_shutdown();
    return rc;
}
