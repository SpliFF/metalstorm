// textureconverter — KTX2 producer for spring-web.
//
// One canonical on-disk format for every GPU texture: `.ktx2`. The
// runtime never sees `.dds`, `.dxt1`, or `.png` again. Sources we accept:
//
//   - DDS (BC1/BC3/BC4/BC5)        wrap blocks straight as KTX2.
//   - TGA, PNG, JPG, BMP (RGBA8)   stb_image -> libktx encode (UASTC/ETC1S).
//   - Raw DXT1 mip0 block stream   wrap as KTX2 (BC1_RGB), no transcode.
//
// CLI:
//   textureconverter <input> <output.ktx2>
//                    [--encoding uastc|etc1s]
//                    [--mipmaps]
//                    [--raw-dxt1 WxH]   # input is a raw DXT1 block stream
//                    [--smf-minimap WxH] # input is an SMF; extract its DXT1
//                                         minimap (1024x1024 unless overridden)
//                    [--channel-op diffuse|team|emissive|orm]
//                                         # remap channels from a Spring S3O
//                                         # source texture before encoding;
//                                         # see PLAN-pbr-mapping.md
//
// Outputs always end in `.ktx2`. The tool no longer produces PNGs,
// no DDS-as-is copy, no minimap thumbnails — those responsibilities
// either moved upstream (into the converters that decide formats)
// or away entirely (KTX2 supersedes them).

#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#include "stb_image.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

#include "System/SpringLog/SpringLog.h"

#include <ktx.h>

#include <algorithm>
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
// Source readers
// ============================================================

/// Slurp an entire file into memory. Used for DDS / raw-DXT1 paths
/// where we hand the bytes straight to libktx without decoding.
static std::vector<uint8_t> ReadAllBytes(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return {};
    f.seekg(0, std::ios::end);
    const auto sz = static_cast<size_t>(f.tellg());
    f.seekg(0);
    std::vector<uint8_t> out(sz);
    if (sz > 0) f.read(reinterpret_cast<char*>(out.data()),
                       static_cast<std::streamsize>(sz));
    return out;
}

/// Parse a "WxH" string. Returns false on any malformed input.
static bool ParseDims(const std::string& s, int& w, int& h) {
    const auto x = s.find('x');
    if (x == std::string::npos) return false;
    try {
        w = std::stoi(s.substr(0, x));
        h = std::stoi(s.substr(x + 1));
    } catch (...) { return false; }
    return w > 0 && h > 0;
}

// Encoding types for the encoder path; declared up here so the DDS
// RGBA-fallback branch can route through EncodeRgba8AsKtx2.
enum class Encoding { Uastc, Etc1s };

// Channel-remapping operations applied to an RGBA8 buffer between the
// decode and encode stages. Used to split a Spring S3O source texture
// into the four spec-compliant glTF PBR slots (see PLAN-pbr-mapping.md):
//
//   None      — pass-through; encode the source RGBA verbatim.
//   Diffuse   — RGB pass-through, A binarised at 0.5 threshold so the
//               glTF MASK alphaMode renders correctly. Source: S3O tex1.
//   Team      — R = source.A (raw team-color blend amount). G,B,A = 0.
//               Source: S3O tex1; consumed via SPRINGRTS_team_color.
//   Emissive  — RGB = source.R replicated (grayscale glow). A = 255.
//               Source: S3O tex2 (R = self-illumination).
//   ORM       — R = 255 (no AO baked in), G = 255 - source.G (specular
//               inverted to roughness), B = source.B (reflectivity →
//               metallic), A = 255. Source: S3O tex2.
enum class ChannelOp { None, Diffuse, Team, Emissive, Orm };

/// Stamp the standard KTX2 `KTXorientation=rd` key/value on a freshly
/// created `ktxTexture2` so loaders that respect the metadata know our
/// pixel data is laid out top-down (V increases downwards = glTF 2.0
/// convention). Every output path in this tool — stb_image PNG/TGA/JPG
/// decode, custom DXT decoder, raw DXT1 wrap, SMF minimap extract —
/// produces pixel rows in that order, so the same value is correct
/// across all branches.
///
/// Without this metadata loaders default to the KTX2 spec fallback
/// (assume `rd` if absent) which happens to be the right answer for us
/// today; the explicit stamp pins the assumption so a future loader
/// that flips the default can't silently mirror every model texture.
static void StampOrientationRd(ktxTexture2* tex) {
    if (!tex) return;
    static constexpr char kOrientationValue[] = "S=r,T=d";
    ktxHashList_AddKVPair(
        &tex->kvDataHead,
        KTX_ORIENTATION_KEY,
        static_cast<unsigned int>(sizeof(kOrientationValue)),
        kOrientationValue);
}

// Forward decl — DDS RGBA fallback re-uses the encoder path.
static bool EncodeRgba8AsKtx2(const uint8_t* rgba, int w, int h,
                              const std::string& dstPath,
                              Encoding enc, bool genMips, bool zstd);

// Forward decls — used by WrapDdsAsKtx2 for the dual-source `--tex2`
// alpha overlay path. Definitions live below near the dispatch code so
// they sit next to IsDdsMagic, which they share decode logic with.
static bool DecodeImageToRgba8(const std::string& path,
                               std::vector<uint8_t>& rgba,
                               int& w, int& h);
static void OverlayAlphaFrom(uint8_t* dst, int dw, int dh,
                             const uint8_t* src, int sw, int sh);

/// Apply one of the S3O channel-split operations to an RGBA8 buffer in
/// place. Pixel count = w*h. No-op for ChannelOp::None.
static void ApplyChannelOp(uint8_t* rgba, int w, int h, ChannelOp op) {
    if (op == ChannelOp::None) return;
    const size_t n = static_cast<size_t>(w) * static_cast<size_t>(h);
    for (size_t i = 0; i < n; ++i) {
        uint8_t* p = rgba + i * 4;
        const uint8_t r = p[0], g = p[1], b = p[2], a = p[3];
        switch (op) {
            case ChannelOp::Diffuse:
                // RGB pass-through; A is forced opaque here because
                // Spring's tex1.A is the team-color blend amount (a
                // separate Team channel-op output captures it), NOT a
                // cutout. The actual cutout — when present — lives in
                // tex2.A per upstream Spring's ModelFragProg.glsl
                // (`alpha = teamColor.a * extraColor.a`). If a tex2
                // source path is passed to ConvertGeneric/WrapDdsAsKtx2
                // alongside this op, its A channel is overlayed onto
                // this 255-baseline AFTER ApplyChannelOp returns. Net
                // effect: assets with no tex2 stay OPAQUE (cutoff never
                // fires); assets with a tex2 get spec-compliant
                // baseColorTexture.a for glTF MASK alphaMode.
                p[0] = r; p[1] = g; p[2] = b; p[3] = 255;
                break;
            case ChannelOp::Team:
                p[0] = a; p[1] = 0; p[2] = 0; p[3] = 0;
                break;
            case ChannelOp::Emissive:
                p[0] = r; p[1] = r; p[2] = r; p[3] = 255;
                break;
            case ChannelOp::Orm:
                p[0] = 255;                         // AO = full bright
                p[1] = static_cast<uint8_t>(255 - g);  // roughness
                p[2] = b;                           // metallic
                p[3] = 255;
                break;
            case ChannelOp::None: break;
        }
    }
}

/// Emit a PNG sidecar of an RGBA8 buffer alongside the canonical
/// KTX2 output. Used as the universal fallback image for glTF readers
/// that don't understand KHR_texture_basisu (Blender, gltf-viewer,
/// the various web-based viewers). KTX2 is still the runtime-loaded
/// asset; the PNG is the spec-required source on the texture entry.
static bool WritePngFallback(const uint8_t* rgba, int w, int h,
                             const std::string& dstPath) {
    if (dstPath.empty()) return true;  // disabled
    if (w <= 0 || h <= 0) return false;

    std::error_code ec;
    fs::path outDir = fs::path(dstPath).parent_path();
    if (!outDir.empty()) fs::create_directories(outDir, ec);

    if (!stbi_write_png(dstPath.c_str(), w, h, 4, rgba, w * 4)) {
        SLOG(SPRING_LOG_WARNING,
            "PNG fallback write failed for %s", dstPath.c_str());
        return false;
    }
    SLOG(SPRING_LOG_INFO, "PNG fallback: %dx%d -> %s", w, h, dstPath.c_str());
    return true;
}

// ============================================================
// DDS wrap path — passthrough to libktx for a BC-format file
// ============================================================

// Just enough of the DDS header to recognise the few formats Spring
// archives ship. We do not do a general DDS decode — for anything we
// can't wrap directly we'd fall through to the encoder path, but in
// practice DDS sources here are always one of these block formats.
struct DdsHeader {
    uint32_t magic;          // "DDS "
    uint32_t size;           // 124
    uint32_t flags;
    uint32_t height;
    uint32_t width;
    uint32_t pitchOrLinearSize;
    uint32_t depth;
    uint32_t mipMapCount;
    uint32_t reserved1[11];
    struct {
        uint32_t size;
        uint32_t flags;
        uint32_t fourCC;     // 'DXT1', 'DXT3', 'DXT5', 'BC4U', 'BC5U', etc.
        uint32_t rgbBitCount;
        uint32_t rMask, gMask, bMask, aMask;
    } pixelFormat;
    uint32_t caps[4];
    uint32_t reserved2;
};
static_assert(sizeof(DdsHeader) == 128, "DDS header layout mismatch");

static constexpr uint32_t Fourcc(const char s[4]) {
    return static_cast<uint32_t>(s[0])
         | (static_cast<uint32_t>(s[1]) << 8)
         | (static_cast<uint32_t>(s[2]) << 16)
         | (static_cast<uint32_t>(s[3]) << 24);
}

// VkFormat values we need (libktx wants Vulkan format codes).
enum : uint32_t {
    VK_FORMAT_BC1_RGB_UNORM_BLOCK   = 131,
    VK_FORMAT_BC2_UNORM_BLOCK       = 135,
    VK_FORMAT_BC3_UNORM_BLOCK       = 137,
    VK_FORMAT_BC4_UNORM_BLOCK       = 139,
    VK_FORMAT_BC5_UNORM_BLOCK       = 141,
    VK_FORMAT_R8G8B8A8_UNORM        = 37,
};

// ---- DXT block decoders ----
// We *decode* DDS to RGBA8 and then encode as UASTC instead of wrapping
// the BC blocks directly. Babylon's KTX2 transcoder routes everything
// through the BasisLZ ETC1S path on load, even for files with a
// non-zero vkFormat — so a `WrapDdsAsKtx2` that produced a clean
// vkFormat=137 (BC3) KTX2 still failed at runtime with
// "Cannot convert 'undefined' to unsigned int" inside
// BasisLzEtc1sImageTranscoder.decodePalettes. Re-encoding to UASTC
// gives the transcoder a payload it actually knows how to handle.

/// Decode one DXT1 block (8 bytes) → 4×4 RGBA pixels at `dst[stride*y+x*4]`.
static void DecodeDxt1Block(const uint8_t* src, uint8_t* dst,
                            int stride, bool dxt1Alpha) {
    const uint16_t c0 = (uint16_t)(src[0] | (src[1] << 8));
    const uint16_t c1 = (uint16_t)(src[2] | (src[3] << 8));
    uint8_t pal[4][4];
    auto unpack565 = [](uint16_t c, uint8_t* out) {
        out[0] = (uint8_t)(((c >> 11) & 0x1f) * 255 / 31);
        out[1] = (uint8_t)(((c >>  5) & 0x3f) * 255 / 63);
        out[2] = (uint8_t)(( c        & 0x1f) * 255 / 31);
        out[3] = 255;
    };
    unpack565(c0, pal[0]);
    unpack565(c1, pal[1]);
    if (c0 > c1 || !dxt1Alpha) {
        for (int i = 0; i < 3; ++i) {
            pal[2][i] = (uint8_t)((2 * pal[0][i] + pal[1][i]) / 3);
            pal[3][i] = (uint8_t)((pal[0][i] + 2 * pal[1][i]) / 3);
        }
        pal[2][3] = pal[3][3] = 255;
    } else {
        for (int i = 0; i < 3; ++i)
            pal[2][i] = (uint8_t)((pal[0][i] + pal[1][i]) / 2);
        pal[2][3] = 255;
        pal[3][0] = pal[3][1] = pal[3][2] = pal[3][3] = 0;
    }
    const uint32_t bits = (uint32_t)(src[4] | (src[5] << 8) |
                                     (src[6] << 16) | (src[7] << 24));
    for (int y = 0; y < 4; ++y) {
        for (int x = 0; x < 4; ++x) {
            const int idx = (bits >> (2 * (y * 4 + x))) & 3;
            uint8_t* p = dst + y * stride + x * 4;
            p[0] = pal[idx][0]; p[1] = pal[idx][1];
            p[2] = pal[idx][2]; p[3] = pal[idx][3];
        }
    }
}

/// Decode one DXT5 alpha block (8 bytes) → alpha values into `dst[..+3]`.
static void DecodeDxt5AlphaBlock(const uint8_t* src, uint8_t* dst, int stride) {
    const uint8_t a0 = src[0], a1 = src[1];
    uint8_t pal[8] = {a0, a1};
    if (a0 > a1) {
        for (int i = 1; i < 7; ++i)
            pal[1 + i] = (uint8_t)(((7 - i) * a0 + i * a1) / 7);
    } else {
        for (int i = 1; i < 5; ++i)
            pal[1 + i] = (uint8_t)(((5 - i) * a0 + i * a1) / 5);
        pal[6] = 0;
        pal[7] = 255;
    }
    uint64_t bits = 0;
    for (int i = 0; i < 6; ++i) bits |= (uint64_t)src[2 + i] << (8 * i);
    for (int y = 0; y < 4; ++y) {
        for (int x = 0; x < 4; ++x) {
            const int idx = (bits >> (3 * (y * 4 + x))) & 7;
            dst[y * stride + x * 4 + 3] = pal[idx];
        }
    }
}

/// Decode an entire DXT1/3/5 block stream of dimensions w×h to RGBA8.
static bool DecodeDxtToRgba(const uint8_t* src, size_t srcLen,
                            int w, int h, int blockBytes, bool dxt1Alpha,
                            bool isDxt5, std::vector<uint8_t>& outRgba) {
    if (w <= 0 || h <= 0) return false;
    const int blockRow = (w + 3) / 4;
    const int blockCol = (h + 3) / 4;
    const size_t expect = (size_t)blockRow * blockCol * blockBytes;
    if (srcLen < expect) return false;
    outRgba.assign((size_t)w * h * 4, 0);
    const int stride = w * 4;
    for (int by = 0; by < blockCol; ++by) {
        for (int bx = 0; bx < blockRow; ++bx) {
            const uint8_t* blk = src + (by * blockRow + bx) * blockBytes;
            uint8_t* dstBase = outRgba.data() + by * 4 * stride + bx * 4 * 4;
            if (blockBytes == 8) {
                DecodeDxt1Block(blk, dstBase, stride, dxt1Alpha);
            } else {
                // 16-byte block: alpha (8 bytes) followed by color (8).
                // Decode color first so the placeholder alpha=255 it writes
                // is then overwritten by the real alpha block. Reversing the
                // two calls — as we previously did — clobbered the decoded
                // alpha and produced an all-opaque RGBA8 buffer, which in
                // turn caused basisu to drop the alpha slice entirely. With
                // tex1.alpha as the team-colour mask, that meant every unit
                // sampled mask=1 and rendered fully team-coloured.
                DecodeDxt1Block(blk + 8, dstBase, stride, /*dxt1Alpha*/ false);
                if (isDxt5) {
                    DecodeDxt5AlphaBlock(blk, dstBase, stride);
                } else {
                    // DXT3 alpha: 4-bit per pixel explicit alpha
                    for (int y = 0; y < 4; ++y) {
                        const uint16_t row = (uint16_t)(blk[y * 2] | (blk[y * 2 + 1] << 8));
                        for (int x = 0; x < 4; ++x) {
                            const int a4 = (row >> (4 * x)) & 0xf;
                            dstBase[y * stride + x * 4 + 3] = (uint8_t)(a4 * 255 / 15);
                        }
                    }
                }
            }
        }
    }
    return true;
}

/// Convert a DDS file to KTX2 by decoding to RGBA8 and re-encoding via
/// the Basis Universal UASTC encoder. The wrap-as-VkFormat path was
/// removed because Babylon's KTX2 transcoder rejects non-Basis files
/// (it always routes through BasisLzEtc1sImageTranscoder.decodePalettes
/// which throws on unexpected payload metadata).
///
/// `pngFallbackPath` (optional): when non-empty, also writes a
/// downscaled PNG to that path from the same RGBA buffer so glTF
/// loaders without KHR_texture_basisu have a usable image to fall
/// back to. See WritePngFallback.
static bool WrapDdsAsKtx2(const std::string& srcPath,
                          const std::string& dstPath,
                          bool zstd,
                          const std::string& pngFallbackPath = {},
                          ChannelOp channelOp = ChannelOp::None,
                          const std::string& tex2Path = {}) {
    std::vector<uint8_t> dds = ReadAllBytes(srcPath);
    if (dds.size() < sizeof(DdsHeader)) {
        SLOG(SPRING_LOG_ERROR, "DDS too small: %s", srcPath.c_str());
        return false;
    }
    DdsHeader h;
    std::memcpy(&h, dds.data(), sizeof(h));
    if (h.magic != Fourcc("DDS ")) {
        SLOG(SPRING_LOG_ERROR, "not a DDS file: %s", srcPath.c_str());
        return false;
    }

    const uint8_t* body = dds.data() + sizeof(DdsHeader);
    const size_t bodyLen = dds.size() - sizeof(DdsHeader);
    std::vector<uint8_t> rgba;

    if (h.pixelFormat.fourCC == Fourcc("DXT1")) {
        if (!DecodeDxtToRgba(body, bodyLen, h.width, h.height, 8,
                             /*dxt1Alpha*/ true, false, rgba)) {
            SLOG(SPRING_LOG_ERROR, "DXT1 decode failed: %s", srcPath.c_str());
            return false;
        }
    } else if (h.pixelFormat.fourCC == Fourcc("DXT3")) {
        if (!DecodeDxtToRgba(body, bodyLen, h.width, h.height, 16,
                             false, /*isDxt5*/ false, rgba)) {
            SLOG(SPRING_LOG_ERROR, "DXT3 decode failed: %s", srcPath.c_str());
            return false;
        }
    } else if (h.pixelFormat.fourCC == Fourcc("DXT5")) {
        if (!DecodeDxtToRgba(body, bodyLen, h.width, h.height, 16,
                             false, /*isDxt5*/ true, rgba)) {
            SLOG(SPRING_LOG_ERROR, "DXT5 decode failed: %s", srcPath.c_str());
            return false;
        }
    } else if (h.pixelFormat.fourCC == 0 && h.pixelFormat.rgbBitCount == 32) {
        // Uncompressed 32-bit DDS (Photoshop "no compression" mode).
        const size_t expect = (size_t)h.width * h.height * 4;
        if (bodyLen < expect) {
            SLOG(SPRING_LOG_ERROR,
                "DDS short read on RGBA payload: %s (%zu bytes wanted)",
                srcPath.c_str(), expect);
            return false;
        }
        rgba.assign(expect, 0);
        const uint32_t rMask = h.pixelFormat.rMask;
        const uint32_t gMask = h.pixelFormat.gMask;
        const uint32_t bMask = h.pixelFormat.bMask;
        const uint32_t aMask = h.pixelFormat.aMask;
        auto shiftFor = [](uint32_t mask) {
            if (mask == 0) return -1;
            int s = 0;
            while (((mask >> s) & 1) == 0) s++;
            return s;
        };
        const int rShift = shiftFor(rMask);
        const int gShift = shiftFor(gMask);
        const int bShift = shiftFor(bMask);
        const int aShift = shiftFor(aMask);
        for (size_t i = 0; i < (size_t)h.width * h.height; ++i) {
            uint32_t px;
            std::memcpy(&px, body + i * 4, 4);
            rgba[i * 4 + 0] = rShift >= 0 ? (uint8_t)((px & rMask) >> rShift) : 0;
            rgba[i * 4 + 1] = gShift >= 0 ? (uint8_t)((px & gMask) >> gShift) : 0;
            rgba[i * 4 + 2] = bShift >= 0 ? (uint8_t)((px & bMask) >> bShift) : 0;
            rgba[i * 4 + 3] = aShift >= 0 ? (uint8_t)((px & aMask) >> aShift) : 255;
        }
    } else {
        SLOG(SPRING_LOG_ERROR, "unsupported DDS fourCC for %s (0x%08x)",
            srcPath.c_str(), h.pixelFormat.fourCC);
        return false;
    }

    SLOG(SPRING_LOG_INFO, "DDS decode: %s (%ux%u) -> UASTC %s",
        srcPath.c_str(), h.width, h.height, dstPath.c_str());
    // PNG fallback is written from the decoded source before any channel
    // remap — the fallback exists for tools that can't read KTX2 and
    // should reflect the source image, not the engine-internal channel
    // packing. The channel op only applies to the KTX2 output.
    WritePngFallback(rgba.data(), (int)h.width, (int)h.height,
                     pngFallbackPath);
    ApplyChannelOp(rgba.data(), (int)h.width, (int)h.height, channelOp);
    // Dual-source overlay: for the Diffuse op, pull spec-compliant
    // glTF MASK alpha from tex2.A (Spring's canonical cutout channel).
    if (channelOp == ChannelOp::Diffuse && !tex2Path.empty()) {
        std::vector<uint8_t> tex2Rgba;
        int tw = 0, th = 0;
        if (DecodeImageToRgba8(tex2Path, tex2Rgba, tw, th)) {
            OverlayAlphaFrom(rgba.data(), (int)h.width, (int)h.height,
                             tex2Rgba.data(), tw, th);
        } else {
            SLOG(SPRING_LOG_WARNING,
                "tex2 alpha overlay skipped — could not decode %s",
                tex2Path.c_str());
        }
    }
    return EncodeRgba8AsKtx2(rgba.data(), (int)h.width, (int)h.height,
                             dstPath, Encoding::Uastc, /*genMips*/ true, zstd);
}

// ============================================================
// Raw DXT1 wrap path — for the SMT tile atlas
// ============================================================

/// Wrap a raw DXT1 mip0 block stream as a KTX2 with VK_FORMAT_BC1_RGB.
/// `srcBytes` must be exactly (w/4)*(h/4)*8 bytes long.
static bool WrapRawDxt1AsKtx2(const std::vector<uint8_t>& srcBytes,
                              int w, int h, const std::string& dstPath,
                              bool zstd) {
    const size_t expect = (size_t)(w / 4) * (h / 4) * 8;
    if (srcBytes.size() != expect) {
        SLOG(SPRING_LOG_ERROR,
            "raw-dxt1 size mismatch: have %zu, expected %zu (%dx%d)",
            srcBytes.size(), expect, w, h);
        return false;
    }
    ktxTexture2* tex = nullptr;
    ktxTextureCreateInfo ci{};
    ci.vkFormat = VK_FORMAT_BC1_RGB_UNORM_BLOCK;
    ci.baseWidth = (uint32_t)w;
    ci.baseHeight = (uint32_t)h;
    ci.baseDepth = 1;
    ci.numDimensions = 2;
    ci.numLevels = 1;
    ci.numLayers = 1;
    ci.numFaces = 1;
    ci.isArray = KTX_FALSE;
    ci.generateMipmaps = KTX_FALSE;

    KTX_error_code rc = ktxTexture2_Create(
        &ci, KTX_TEXTURE_CREATE_ALLOC_STORAGE, &tex);
    if (rc != KTX_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "ktxTexture2_Create failed: %s",
            ktxErrorString(rc));
        return false;
    }
    rc = ktxTexture_SetImageFromMemory(
        ktxTexture(tex), 0, 0, 0, srcBytes.data(), srcBytes.size());
    if (rc != KTX_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "SetImageFromMemory failed: %s",
            ktxErrorString(rc));
        ktxTexture_Destroy(ktxTexture(tex));
        return false;
    }
    if (zstd) {
        ktxTexture2_DeflateZstd(tex, 18);
    }
    StampOrientationRd(tex);
    rc = ktxTexture_WriteToNamedFile(ktxTexture(tex), dstPath.c_str());
    ktxTexture_Destroy(ktxTexture(tex));
    if (rc != KTX_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "ktxTexture_WriteToNamedFile failed: %s",
            ktxErrorString(rc));
        return false;
    }
    SLOG(SPRING_LOG_INFO, "raw DXT1 wrap: %dx%d (%zu bytes) -> %s",
        w, h, srcBytes.size(), dstPath.c_str());
    return true;
}

// ============================================================
// Encoder path — RGBA8 source -> UASTC or ETC1S
// ============================================================
// (Encoding enum is declared at the top of the file so the DDS
// RGBA-fallback branch in WrapDdsAsKtx2 can route through here.)

/// Encode RGBA8 pixel data as a KTX2 with Basis Universal compression.
/// Babylon's KTX2 transcoder only recognises two source formats — UASTC
/// (colorModel=166) and ETC1S (colorModel=163, with SGD codebooks). Any
/// other colorModel (RGBSDA, BC*) gets routed to the ETC1S path where
/// it throws on the missing codebooks. So we MUST go through Basis.
/// UASTC is high-quality and the encoder default.
static bool EncodeRgba8AsKtx2(const uint8_t* rgba, int w, int h,
                              const std::string& dstPath,
                              Encoding enc, bool genMips, bool zstd) {
    uint32_t levels = 1;
    if (genMips) {
        uint32_t dim = std::max(w, h);
        while (dim > 1) { dim >>= 1; ++levels; }
    }

    ktxTexture2* tex = nullptr;
    ktxTextureCreateInfo ci{};
    ci.vkFormat = VK_FORMAT_R8G8B8A8_UNORM;
    ci.baseWidth = (uint32_t)w;
    ci.baseHeight = (uint32_t)h;
    ci.baseDepth = 1;
    ci.numDimensions = 2;
    ci.numLevels = levels;
    ci.numLayers = 1;
    ci.numFaces = 1;
    ci.isArray = KTX_FALSE;
    ci.generateMipmaps = KTX_FALSE;

    KTX_error_code rc = ktxTexture2_Create(
        &ci, KTX_TEXTURE_CREATE_ALLOC_STORAGE, &tex);
    if (rc != KTX_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "ktxTexture2_Create failed: %s",
            ktxErrorString(rc));
        return false;
    }

    rc = ktxTexture_SetImageFromMemory(
        ktxTexture(tex), 0, 0, 0, rgba, (size_t)w * h * 4);
    if (rc != KTX_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "SetImageFromMemory mip0 failed: %s",
            ktxErrorString(rc));
        ktxTexture_Destroy(ktxTexture(tex));
        return false;
    }

    if (levels > 1) {
        std::vector<uint8_t> prev(rgba, rgba + (size_t)w * h * 4);
        int cw = w, chgt = h;
        for (uint32_t lvl = 1; lvl < levels; ++lvl) {
            const int nw = std::max(1, cw / 2);
            const int nh = std::max(1, chgt / 2);
            std::vector<uint8_t> next((size_t)nw * nh * 4);
            for (int y = 0; y < nh; ++y) {
                for (int x = 0; x < nw; ++x) {
                    const int x0 = x * 2, y0 = y * 2;
                    const int x1 = std::min(x0 + 1, cw - 1);
                    const int y1 = std::min(y0 + 1, chgt - 1);
                    for (int c = 0; c < 4; ++c) {
                        const int s00 = prev[(y0 * cw + x0) * 4 + c];
                        const int s10 = prev[(y0 * cw + x1) * 4 + c];
                        const int s01 = prev[(y1 * cw + x0) * 4 + c];
                        const int s11 = prev[(y1 * cw + x1) * 4 + c];
                        next[(y * nw + x) * 4 + c] = (uint8_t)((s00 + s10 + s01 + s11) / 4);
                    }
                }
            }
            rc = ktxTexture_SetImageFromMemory(
                ktxTexture(tex), lvl, 0, 0, next.data(), next.size());
            if (rc != KTX_SUCCESS) {
                SLOG(SPRING_LOG_ERROR, "SetImageFromMemory mip %u failed: %s",
                    lvl, ktxErrorString(rc));
                ktxTexture_Destroy(ktxTexture(tex));
                return false;
            }
            prev = std::move(next);
            cw = nw; chgt = nh;
        }
    }

    ktxBasisParams params{};
    params.structSize = sizeof(params);
    params.uastc = (enc == Encoding::Uastc);
    params.threadCount = 1;
    params.compressionLevel = (enc == Encoding::Uastc) ? 2 : 1;
    params.qualityLevel = (enc == Encoding::Uastc) ? 0 : 128;

    rc = ktxTexture2_CompressBasisEx(tex, &params);
    if (rc != KTX_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "Basis encode failed: %s",
            ktxErrorString(rc));
        ktxTexture_Destroy(ktxTexture(tex));
        return false;
    }
    if (zstd) {
        ktxTexture2_DeflateZstd(tex, 18);
    }
    StampOrientationRd(tex);
    rc = ktxTexture_WriteToNamedFile(ktxTexture(tex), dstPath.c_str());
    ktxTexture_Destroy(ktxTexture(tex));
    if (rc != KTX_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "ktxTexture_WriteToNamedFile failed: %s",
            ktxErrorString(rc));
        return false;
    }
    SLOG(SPRING_LOG_INFO, "%s encode: %dx%d (%u mips) -> %s",
        enc == Encoding::Uastc ? "UASTC" : "ETC1S", w, h, levels, dstPath.c_str());
    return true;
}

// ============================================================
// SMF minimap extraction
// ============================================================

/// Pull the 1024x1024 DXT1 minimap out of a Spring SMF file, decode
/// it to RGBA8, and re-encode as a Basis Universal UASTC KTX2 so
/// Babylon's KTX2 loader can transcode it (the wrap-as-BC1 path
/// produces a vkFormat=131 KTX2 which Babylon's transcoder routes
/// to BasisLzEtc1sImageTranscoder.decodePalettes and throws on the
/// missing codebooks).
static bool ExtractSmfMinimapToKtx2(const std::string& smfPath,
                                    const std::string& outputPath,
                                    bool zstd) {
    std::ifstream smf(smfPath, std::ios::binary);
    if (!smf.is_open()) {
        SLOG(SPRING_LOG_ERROR, "cannot open SMF: %s", smfPath.c_str());
        return false;
    }
    smf.seekg(64);
    int minimapPtr = 0;
    smf.read(reinterpret_cast<char*>(&minimapPtr), 4);
    if (minimapPtr <= 0) {
        SLOG(SPRING_LOG_ERROR, "invalid minimap pointer in SMF");
        return false;
    }
    constexpr int W = 1024, H = 1024;
    smf.seekg(minimapPtr);
    const size_t dxtSize = (size_t)(W / 4) * (H / 4) * 8;  // 524288
    std::vector<uint8_t> dxt(dxtSize);
    smf.read(reinterpret_cast<char*>(dxt.data()),
             (std::streamsize)dxtSize);
    if (!smf.good()) {
        SLOG(SPRING_LOG_ERROR, "short read on SMF minimap");
        return false;
    }
    smf.close();

    std::vector<uint8_t> rgba;
    if (!DecodeDxtToRgba(dxt.data(), dxt.size(), W, H, 8,
                         /*dxt1Alpha*/ true, false, rgba)) {
        SLOG(SPRING_LOG_ERROR, "DXT1 decode failed for SMF minimap");
        return false;
    }
    return EncodeRgba8AsKtx2(rgba.data(), W, H, outputPath,
                             Encoding::Uastc, /*genMips*/ true, zstd);
}

// ============================================================
// Detection + dispatch
// ============================================================

static bool IsDdsMagic(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    char magic[4];
    f.read(magic, 4);
    return f.gcount() == 4 && std::memcmp(magic, "DDS ", 4) == 0;
}

/// Decode any supported source format (DDS DXT1/3/5, DDS uncompressed
/// 32-bit, or anything stb_image reads — PNG/TGA/JPG/BMP/PSD) to a
/// tightly-packed RGBA8 buffer. Used by the dual-source `--tex2` path
/// to pull the cutout alpha from Spring's tex2 alongside the tex1
/// diffuse decode. Returns false (and logs) on any decode failure.
static bool DecodeImageToRgba8(const std::string& path,
                               std::vector<uint8_t>& rgba,
                               int& w, int& h) {
    if (IsDdsMagic(path)) {
        std::vector<uint8_t> dds = ReadAllBytes(path);
        if (dds.size() < sizeof(DdsHeader)) {
            SLOG(SPRING_LOG_ERROR, "DDS too small: %s", path.c_str());
            return false;
        }
        DdsHeader hdr;
        std::memcpy(&hdr, dds.data(), sizeof(hdr));
        if (hdr.magic != Fourcc("DDS ")) {
            SLOG(SPRING_LOG_ERROR, "not a DDS file: %s", path.c_str());
            return false;
        }
        const uint8_t* body = dds.data() + sizeof(DdsHeader);
        const size_t bodyLen = dds.size() - sizeof(DdsHeader);
        w = (int)hdr.width;
        h = (int)hdr.height;
        if (hdr.pixelFormat.fourCC == Fourcc("DXT1")) {
            return DecodeDxtToRgba(body, bodyLen, hdr.width, hdr.height,
                                   8, /*dxt1Alpha*/ true, false, rgba);
        }
        if (hdr.pixelFormat.fourCC == Fourcc("DXT3")) {
            return DecodeDxtToRgba(body, bodyLen, hdr.width, hdr.height,
                                   16, false, false, rgba);
        }
        if (hdr.pixelFormat.fourCC == Fourcc("DXT5")) {
            return DecodeDxtToRgba(body, bodyLen, hdr.width, hdr.height,
                                   16, false, /*isDxt5*/ true, rgba);
        }
        if (hdr.pixelFormat.fourCC == 0 && hdr.pixelFormat.rgbBitCount == 32) {
            const size_t expect = (size_t)hdr.width * hdr.height * 4;
            if (bodyLen < expect) {
                SLOG(SPRING_LOG_ERROR, "DDS short read: %s", path.c_str());
                return false;
            }
            rgba.assign(expect, 0);
            const uint32_t rMask = hdr.pixelFormat.rMask;
            const uint32_t gMask = hdr.pixelFormat.gMask;
            const uint32_t bMask = hdr.pixelFormat.bMask;
            const uint32_t aMask = hdr.pixelFormat.aMask;
            auto shiftFor = [](uint32_t mask) {
                if (mask == 0) return -1;
                int s = 0;
                while (((mask >> s) & 1) == 0) s++;
                return s;
            };
            const int rShift = shiftFor(rMask);
            const int gShift = shiftFor(gMask);
            const int bShift = shiftFor(bMask);
            const int aShift = shiftFor(aMask);
            for (size_t i = 0; i < (size_t)hdr.width * hdr.height; ++i) {
                uint32_t px;
                std::memcpy(&px, body + i * 4, 4);
                rgba[i*4+0] = rShift >= 0 ? (uint8_t)((px & rMask) >> rShift) : 0;
                rgba[i*4+1] = gShift >= 0 ? (uint8_t)((px & gMask) >> gShift) : 0;
                rgba[i*4+2] = bShift >= 0 ? (uint8_t)((px & bMask) >> bShift) : 0;
                rgba[i*4+3] = aShift >= 0 ? (uint8_t)((px & aMask) >> aShift) : 255;
            }
            return true;
        }
        SLOG(SPRING_LOG_ERROR, "unsupported DDS fourCC 0x%08x in %s",
            hdr.pixelFormat.fourCC, path.c_str());
        return false;
    }
    int channels = 0;
    uint8_t* px = stbi_load(path.c_str(), &w, &h, &channels, 4);
    if (!px) {
        SLOG(SPRING_LOG_ERROR, "stb_image failed on %s: %s",
            path.c_str(), stbi_failure_reason());
        return false;
    }
    rgba.assign(px, px + (size_t)w * h * 4);
    stbi_image_free(px);
    return true;
}

/// Overlay the alpha channel of `src` onto `dst`. Used by the dual-
/// source `--tex2` path so the diffuse output carries spec-compliant
/// glTF MASK alpha sourced from Spring's tex2.A (the canonical Spring
/// cutout channel; see PLAN-pbr-mapping.md). Nearest-neighbour
/// resampling handles dim mismatches — typical content authors tex1
/// and tex2 at the same resolution; the fallback exists for tolerance
/// rather than quality.
static void OverlayAlphaFrom(uint8_t* dst, int dw, int dh,
                             const uint8_t* src, int sw, int sh) {
    if (sw == dw && sh == dh) {
        for (size_t i = 0; i < (size_t)dw * dh; ++i) {
            dst[i*4 + 3] = src[i*4 + 3];
        }
        return;
    }
    // Nearest-neighbour resample of src's A onto dst's A.
    for (int y = 0; y < dh; ++y) {
        const int sy = (int)((int64_t)y * sh / dh);
        for (int x = 0; x < dw; ++x) {
            const int sx = (int)((int64_t)x * sw / dw);
            dst[(y*dw + x)*4 + 3] = src[(sy*sw + sx)*4 + 3];
        }
    }
}

static int ConvertGeneric(const std::string& inputPath,
                          const std::string& outputPath,
                          Encoding enc, bool genMips, bool zstd,
                          const std::string& pngFallbackPath,
                          ChannelOp channelOp,
                          const std::string& tex2Path) {
    if (IsDdsMagic(inputPath)) {
        return WrapDdsAsKtx2(inputPath, outputPath, zstd,
                             pngFallbackPath, channelOp, tex2Path) ? 0 : 1;
    }
    int w, h, channels;
    uint8_t* pixels = stbi_load(inputPath.c_str(), &w, &h, &channels, 4);
    if (!pixels) {
        SLOG(SPRING_LOG_ERROR, "stb_image failed on %s: %s",
            inputPath.c_str(), stbi_failure_reason());
        return 1;
    }
    // Fallback PNG mirrors the source image (pre-remap); see
    // WrapDdsAsKtx2 for the matching comment.
    WritePngFallback(pixels, w, h, pngFallbackPath);
    ApplyChannelOp(pixels, w, h, channelOp);
    // Dual-source overlay: see matching block in WrapDdsAsKtx2.
    if (channelOp == ChannelOp::Diffuse && !tex2Path.empty()) {
        std::vector<uint8_t> tex2Rgba;
        int tw = 0, th = 0;
        if (DecodeImageToRgba8(tex2Path, tex2Rgba, tw, th)) {
            OverlayAlphaFrom(pixels, w, h, tex2Rgba.data(), tw, th);
        } else {
            SLOG(SPRING_LOG_WARNING,
                "tex2 alpha overlay skipped — could not decode %s",
                tex2Path.c_str());
        }
    }
    const bool ok = EncodeRgba8AsKtx2(pixels, w, h, outputPath,
                                       enc, genMips, zstd);
    stbi_image_free(pixels);
    return ok ? 0 : 1;
}

// ============================================================
// CLI
// ============================================================

static void PrintUsage(const char* argv0) {
    SLOG(SPRING_LOG_NOTICE,
        "produce KTX2 textures for spring-web.\n"
        "\n"
        "usage:\n"
        "  %s [options] <input> <output.ktx2>\n"
        "  %s --raw-dxt1 WxH <input> <output.ktx2>\n"
        "  %s --smf-minimap <input.smf> <output.ktx2>\n"
        "\n"
        "DDS sources (BC1/BC3/BC4/BC5) are wrapped as KTX2 without\n"
        "transcoding. RGBA sources (TGA/PNG/JPG/BMP) are encoded via\n"
        "Basis Universal — UASTC for art (default), ETC1S for the SMT\n"
        "tile atlas. The --raw-dxt1 mode wraps a bare DXT1 block stream\n"
        "(used by mapconverter for the SMT atlas).\n"
        "\n"
        "options:\n"
        "  --encoding uastc|etc1s   Encoder for non-DDS sources (default: uastc)\n"
        "  --mipmaps                Generate mip chain for encoded sources\n"
        "  --no-zstd                Disable Zstd supercompression\n"
        "  --png-fallback <path>    Also write a downscaled PNG sidecar at <path>\n"
        "                           (for glTF readers without KHR_texture_basisu)\n"
        "  --channel-op <op>        Remap channels from a Spring S3O source\n"
        "                           texture before encoding. Modes:\n"
        "                             diffuse  — RGB pass-through, A=255 by\n"
        "                                        default (overlay --tex2.A\n"
        "                                        for glTF MASK cutout)\n"
        "                             team     — A → R; G,B,A = 0 (team mask)\n"
        "                             emissive — R replicated to RGB; A=255\n"
        "                             orm      — R=255 (no AO), G=255-G\n"
        "                                        (specular → roughness),\n"
        "                                        B=B (reflectivity → metallic)\n"
        "                           See PLAN-pbr-mapping.md for the channel\n"
        "                           contract.\n"
        "  --tex2 <path>            Secondary source for `--channel-op diffuse`.\n"
        "                           Its A channel overlays the output's A so\n"
        "                           the diffuse texture carries Spring's\n"
        "                           canonical cutout alpha (tex2.A), exposed\n"
        "                           to glTF readers via alphaMode: MASK.\n"
        "  --log-level <level>      debug/info/notice/warning/error\n",
        argv0, argv0, argv0);
}

int main(int argc, char* argv[]) {
    springlog_init("textureconverter", SPRING_LOG_OUTPUT_CONSOLE);

    std::string inputPath, outputPath;
    Encoding enc = Encoding::Uastc;
    bool genMips = false;
    // Zstd supercompression is on by default — combined with UASTC it
    // gives ~3× shrink versus uncompressed UASTC. The browser-side
    // decoder needs an explicit URL for `zstddec.wasm`; we set that
    // up via KhronosTextureContainer2.URLConfig in main.ts so the
    // module loads reliably from the Babylon CDN.
    bool zstd = true;
    bool rawDxt1 = false;
    bool smfMinimap = false;
    int rawW = 0, rawH = 0;
    std::string pngFallbackPath;
    ChannelOp channelOp = ChannelOp::None;
    std::string tex2Path;

    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--png-fallback" && i + 1 < argc) {
            pngFallbackPath = argv[++i];
        } else if (a == "--encoding" && i + 1 < argc) {
            const std::string v = argv[++i];
            if (v == "uastc") enc = Encoding::Uastc;
            else if (v == "etc1s") enc = Encoding::Etc1s;
            else { SLOG(SPRING_LOG_ERROR, "bad --encoding: %s", v.c_str()); return 2; }
        } else if (a == "--mipmaps") {
            genMips = true;
        } else if (a == "--no-zstd") {
            zstd = false;
        } else if (a == "--zstd") {
            zstd = true;
        } else if (a == "--raw-dxt1" && i + 1 < argc) {
            rawDxt1 = true;
            if (!ParseDims(argv[++i], rawW, rawH)) {
                SLOG(SPRING_LOG_ERROR, "bad --raw-dxt1 dims");
                springlog_shutdown();
                return 2;
            }
        } else if (a == "--smf-minimap") {
            smfMinimap = true;
        } else if (a == "--channel-op" && i + 1 < argc) {
            const std::string v = argv[++i];
            if      (v == "diffuse")  channelOp = ChannelOp::Diffuse;
            else if (v == "team")     channelOp = ChannelOp::Team;
            else if (v == "emissive") channelOp = ChannelOp::Emissive;
            else if (v == "orm")      channelOp = ChannelOp::Orm;
            else if (v == "none")     channelOp = ChannelOp::None;
            else {
                SLOG(SPRING_LOG_ERROR, "bad --channel-op: %s "
                    "(expected diffuse|team|emissive|orm|none)", v.c_str());
                springlog_shutdown();
                return 2;
            }
        } else if (a == "--tex2" && i + 1 < argc) {
            // Secondary source for --channel-op diffuse: tex2.A is
            // overlayed onto the output's A channel so the diffuse
            // texture carries spec-compliant glTF MASK cutout alpha
            // (Spring's canonical cutout channel is tex2.A; tex1.A is
            // the separate team-color mask). Ignored for other ops.
            tex2Path = argv[++i];
        } else if (a == "--log-level" && i + 1 < argc) {
            const std::string lvl = argv[++i];
            if (lvl == "debug")        springlog_set_min_level(SPRING_LOG_DEBUG);
            else if (lvl == "info")    springlog_set_min_level(SPRING_LOG_INFO);
            else if (lvl == "notice")  springlog_set_min_level(SPRING_LOG_NOTICE);
            else if (lvl == "warning") springlog_set_min_level(SPRING_LOG_WARNING);
            else if (lvl == "error")   springlog_set_min_level(SPRING_LOG_ERROR);
        } else if (a == "-h" || a == "--help") {
            PrintUsage(argv[0]);
            springlog_shutdown();
            return 0;
        } else if (!a.empty() && a[0] == '-') {
            SLOG(SPRING_LOG_ERROR, "unknown option: %s", a.c_str());
            springlog_shutdown();
            return 2;
        } else if (inputPath.empty()) {
            inputPath = a;
        } else if (outputPath.empty()) {
            outputPath = a;
        }
    }

    if (inputPath.empty() || outputPath.empty()) {
        PrintUsage(argv[0]);
        springlog_shutdown();
        return 2;
    }

    std::error_code ec;
    fs::path outDir = fs::path(outputPath).parent_path();
    if (!outDir.empty()) fs::create_directories(outDir, ec);

    int rc;
    if (smfMinimap) {
        rc = ExtractSmfMinimapToKtx2(inputPath, outputPath, zstd) ? 0 : 1;
    } else if (rawDxt1) {
        std::vector<uint8_t> bytes = ReadAllBytes(inputPath);
        rc = WrapRawDxt1AsKtx2(bytes, rawW, rawH, outputPath, zstd) ? 0 : 1;
    } else {
        rc = ConvertGeneric(inputPath, outputPath, enc, genMips, zstd,
                            pngFallbackPath, channelOp, tex2Path);
    }

    springlog_shutdown();
    return rc;
}
