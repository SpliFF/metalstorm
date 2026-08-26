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

#include "Server/TerrainPages.h"
#include "System/FileSystem/DetailTexDc.h"
#include "System/FileSystem/Ktx2BytesPlane.h"
#include "System/FileSystem/Ktx2Orientation.h"
#include "System/SpringLog/SpringLog.h"

#include <ktx.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
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

/// Inverse of ReadAllBytes — write a whole buffer, truncating.
static bool WriteAllBytes(const std::string& path,
                          const std::vector<uint8_t>& bytes) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f.write(reinterpret_cast<const char*>(bytes.data()),
            static_cast<std::streamsize>(bytes.size()));
    return f.good();
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
///
/// The value is the bare per-dimension letters (`rd`), NOT libktx's
/// KTX**1** `KTX_ORIENTATION2_FMT` spelling `S=r,T=d`. KTX2 §3.11.4
/// requires `/^[rl][du]$/` for a 2D texture, so the KTX1 form makes the
/// file invalid: `ktx validate` rejects it with error-7108/7109 and
/// `ktx info`/`ktx extract` refuse to open it. Nothing renders wrong —
/// neither Babylon's KTX2 loader nor basisu reads the key at all — but
/// it costs every future investigation the standard tooling, which is
/// exactly what happened in PLAN-maps M8e (the minimap decode had to go
/// through `basisu -unpack`). Cross-check: the forge encoder writes
/// `rd` here, and its output validates clean.
///
/// The value and its grammar live in `Ktx2Orientation.h` so the
/// doctest suite (which does not link libktx) can guard the spelling.
static void StampOrientationRd(ktxTexture2* tex) {
    if (!tex) return;
    static_assert(ktx2::IsValidOrientation(ktx2::kOrientation2D, 2),
                  "KTXorientation value must match the KTX2 2D grammar");
    ktxHashList_AddKVPair(
        &tex->kvDataHead,
        KTX_ORIENTATION_KEY,
        static_cast<unsigned int>(sizeof(ktx2::kOrientation2D)),
        ktx2::kOrientation2D);
}

/// Our identity in the file's `KTXwriter` key, in place of libktx's fallback
/// `"Unidentified app"`. libktx appends its own ` / libktx v4.0` either way,
/// so the value on disk reads `springrts-web textureconverter / libktx v4.0`.
///
/// This exists because provenance is the first question every KTX2
/// investigation asks and we had no way to answer it. The tree carries files
/// from three encoders — this tool, forge's `Basis Universal`, and `toktx` —
/// and only ours was anonymous, so "which of these 2 475 files did *we* write,
/// and therefore which carry the defect we just fixed?" had to be inferred
/// from side channels (the KTXorientation spelling, mtimes) that answer a
/// different question and go stale. PLAN-maps M8j spent a fire on exactly that
/// cross-referencing; with this key it is one grep. Bare tool name, no build
/// or git stamp of our own: the output must stay byte-deterministic for the
/// hash-equality checks the map pipeline relies on.
static constexpr char kWriterId[] = "springrts-web textureconverter";

/// Zstd-supercompress `tex`, then put back the `bytesPlane` field libktx
/// 4.3.2 zeroes on the way out.
///
/// libktx implements KTX2 ≤ 2.0.3, which said a supercompressed file's
/// `bytesPlane0..7` must read *unsized*; spec 2.0.4 reversed that and
/// requires the inflated texel block size there, so every file this tool
/// wrote came out tripping the Khronos validator's `warning-6030`. See
/// Ktx2BytesPlane.h for the full history and why the header exists.
///
/// Save/restore rather than re-derive: the pre-deflate DFD already holds
/// the right answer for every branch that reaches here (16 for UASTC, 8
/// for the raw-DXT1 wrap, 4 for the RGBA8 fallback), so copying it back
/// cannot disagree with the encoder the way a lookup table would. The
/// only bytes this changes in the output file are the two DFD words.
static void DeflateZstdKeepingBytesPlanes(ktxTexture2* tex, int level) {
    uint32_t* bdb = tex->pDfd + 1;
    const uint32_t plane0 = bdb[ktx2::kBdfdWordBytesPlane0];
    const uint32_t plane4 = bdb[ktx2::kBdfdWordBytesPlane4];
    const KTX_error_code rc = ktxTexture2_DeflateZstd(tex, level);
    if (rc != KTX_SUCCESS) {
        // Not fatal here — the callers have always treated deflation as
        // best-effort and go on to write an uncompressed file — but it
        // must not be silent, and on this path libktx left the DFD alone.
        SLOG(SPRING_LOG_ERROR, "ktxTexture2_DeflateZstd failed: %s",
            ktxErrorString(rc));
        return;
    }
    // pDfd is reallocated by nothing in DeflateZstd, but re-read it rather
    // than reuse the pointer captured above so this stays correct if a
    // future libktx rebuilds the descriptor during deflation.
    bdb = tex->pDfd + 1;
    bdb[ktx2::kBdfdWordBytesPlane0] = plane0;
    bdb[ktx2::kBdfdWordBytesPlane4] = plane4;
    if (!ktx2::IsSizedForSupercompression(bdb[ktx2::kBdfdWordBytesPlane0])) {
        // There was nothing to restore: the encoder handed us an unsized
        // bytesPlane0 before deflation too, so the file still trips
        // warning-6030. Say so rather than guess a size the DFD does not
        // claim — this is the one path where a lookup table would be the
        // only option, and it is unreachable from any shipped invocation.
        SLOG(SPRING_LOG_WARNING,
            "KTX2 bytesPlane0 was already 0 before deflation - output will "
            "trip warning-6030 (see Ktx2BytesPlane.h)");
    }
}

/// libktx fills `KTXwriter` with its own fallback at write time *only* if the
/// app has not set one, so stamping before the write wins.
static void StampWriterId(ktxTexture2* tex) {
    if (!tex) return;
    ktxHashList_AddKVPair(
        &tex->kvDataHead,
        KTX_WRITER_KEY,
        static_cast<unsigned int>(sizeof(kWriterId)),
        kWriterId);
}

/// Per-channel means of the encoder's *input* pixels (level 0) and of the
/// last level it generates (the 1x1 top mip). Filled only when the caller
/// asks — see `--signed-dc-report` and DetailTexDc.h for what the numbers
/// mean and why a detail texture's DC is a permanent, distance-invariant
/// tint rather than something the mip chain fades away.
struct DcReport {
    double baseMean[3] = {0, 0, 0};
    double topMean[3] = {0, 0, 0};
    int topWidth = 0;
    int topHeight = 0;
    int levels = 0;
};

// Forward decl — DDS RGBA fallback re-uses the encoder path.
static bool EncodeRgba8AsKtx2(const uint8_t* rgba, int w, int h,
                              const std::string& dstPath,
                              Encoding enc, bool genMips, bool zstd,
                              DcReport* dcOut = nullptr);

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

/// Wrap a raw DXT1 block stream as a KTX2 with VK_FORMAT_BC1_RGB, one or
/// more mip levels. `srcBytes` holds each level's blocks concatenated in
/// level order (level 0 first): level L is `(w>>L)/4 * (h>>L)/4 * 8` bytes,
/// dimensions halving each level (both must stay multiples of 4 down to the
/// smallest level — true for the 32x32-texel Spring tile atlas, whose 4
/// levels are 32/16/8/4).
static bool WrapRawDxt1AsKtx2(const std::vector<uint8_t>& srcBytes,
                              int w, int h, int numLevels,
                              const std::string& dstPath,
                              bool zstd) {
    std::vector<size_t> levelSize(numLevels), levelOffset(numLevels);
    size_t expect = 0;
    for (int lvl = 0; lvl < numLevels; ++lvl) {
        const int lw = std::max(1, w >> lvl);
        const int lh = std::max(1, h >> lvl);
        if (lw % 4 != 0 || lh % 4 != 0) {
            SLOG(SPRING_LOG_ERROR,
                "raw-dxt1 level %d dims %dx%d not block-aligned", lvl, lw, lh);
            return false;
        }
        levelSize[lvl] = (size_t)(lw / 4) * (lh / 4) * 8;
        levelOffset[lvl] = expect;
        expect += levelSize[lvl];
    }
    if (srcBytes.size() != expect) {
        SLOG(SPRING_LOG_ERROR,
            "raw-dxt1 size mismatch: have %zu, expected %zu (%dx%d, %d levels)",
            srcBytes.size(), expect, w, h, numLevels);
        return false;
    }
    ktxTexture2* tex = nullptr;
    ktxTextureCreateInfo ci{};
    ci.vkFormat = VK_FORMAT_BC1_RGB_UNORM_BLOCK;
    ci.baseWidth = (uint32_t)w;
    ci.baseHeight = (uint32_t)h;
    ci.baseDepth = 1;
    ci.numDimensions = 2;
    ci.numLevels = (uint32_t)numLevels;
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
    for (int lvl = 0; lvl < numLevels; ++lvl) {
        rc = ktxTexture_SetImageFromMemory(
            ktxTexture(tex), lvl, 0, 0,
            srcBytes.data() + levelOffset[lvl], levelSize[lvl]);
        if (rc != KTX_SUCCESS) {
            SLOG(SPRING_LOG_ERROR, "SetImageFromMemory level %d failed: %s",
                lvl, ktxErrorString(rc));
            ktxTexture_Destroy(ktxTexture(tex));
            return false;
        }
    }
    if (zstd) {
        DeflateZstdKeepingBytesPlanes(tex, 18);
    }
    StampOrientationRd(tex);
    StampWriterId(tex);
    rc = ktxTexture_WriteToNamedFile(ktxTexture(tex), dstPath.c_str());
    ktxTexture_Destroy(ktxTexture(tex));
    if (rc != KTX_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "ktxTexture_WriteToNamedFile failed: %s",
            ktxErrorString(rc));
        return false;
    }
    SLOG(SPRING_LOG_INFO, "raw DXT1 wrap: %dx%d, %d levels (%zu bytes) -> %s",
        w, h, numLevels, srcBytes.size(), dstPath.c_str());
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
                              Encoding enc, bool genMips, bool zstd,
                              DcReport* dcOut) {
    uint32_t levels = 1;
    if (genMips) {
        uint32_t dim = std::max(w, h);
        while (dim > 1) { dim >>= 1; ++levels; }
    }

    if (dcOut) {
        double sum[3] = {0, 0, 0};
        const size_t texels = (size_t)w * h;
        for (size_t i = 0; i < texels; ++i)
            for (int c = 0; c < 3; ++c) sum[c] += rgba[i * 4 + c];
        for (int c = 0; c < 3; ++c)
            dcOut->baseMean[c] = dcOut->topMean[c] = sum[c] / (double)texels;
        dcOut->topWidth = w;
        dcOut->topHeight = h;
        dcOut->levels = (int)levels;
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
                        // Rounded, not truncated. Integer `/4` loses up to 0.75
                        // of a level per step and the bias compounds down the
                        // chain (~-3 levels over 9), which for a *signed*
                        // detail texture is a distance-growing darkening the
                        // map author never authored. See DetailTexDc.h.
                        next[(y * nw + x) * 4 + c] =
                            detailtex::MipBoxAvg4(s00, s10, s01, s11);
                    }
                }
            }
            if (dcOut) {
                double sum[3] = {0, 0, 0};
                const size_t texels = (size_t)nw * nh;
                for (size_t i = 0; i < texels; ++i)
                    for (int c = 0; c < 3; ++c) sum[c] += next[i * 4 + c];
                for (int c = 0; c < 3; ++c)
                    dcOut->topMean[c] = sum[c] / (double)texels;
                dcOut->topWidth = nw;
                dcOut->topHeight = nh;
                // Per-level trajectory: where a DC drift enters the chain is
                // the difference between a content bug and a filter bug.
                SLOG(SPRING_LOG_DEBUG, "mip %u (%dx%d) mean %.4f,%.4f,%.4f",
                    lvl, nw, nh, dcOut->topMean[0], dcOut->topMean[1],
                    dcOut->topMean[2]);
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
        DeflateZstdKeepingBytesPlanes(tex, 18);
    }
    StampOrientationRd(tex);
    StampWriterId(tex);
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
                          const std::string& tex2Path,
                          DcReport* dcOut) {
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
                                       enc, genMips, zstd, dcOut);
    stbi_image_free(pixels);
    return ok ? 0 : 1;
}

/// --terrain-pages (PLAN-maps.md §1.2.1 streaming v2): cut a map-space
/// ground albedo into the client's 520² BC1 page pyramid. Writes
/// `<output>.bin`'s pages plus the self-describing `ground_pages.json`
/// index next to it (same stem, `.json`). The address space, the on-disk
/// order and the BC1 encode all live in Server/TerrainPages.h, shared
/// with the doctest suite; only the file I/O is here.
static int BuildTerrainPages(const std::string& inputPath,
                             const std::string& outputPath,
                             int mapElmosX, int mapElmosZ) {
    int w, h, channels;
    uint8_t* pixels = stbi_load(inputPath.c_str(), &w, &h, &channels, 3);
    if (!pixels) {
        SLOG(SPRING_LOG_ERROR, "stb_image failed on %s: %s",
            inputPath.c_str(), stbi_failure_reason());
        return 1;
    }
    const TerrainPages::Plan plan =
        TerrainPages::PlanPages(mapElmosX, mapElmosZ, w, h);
    std::vector<uint8_t> pages;
    TerrainPages::BuildPages(pixels, plan, pages);
    stbi_image_free(pixels);

    if (!WriteAllBytes(outputPath, pages)) {
        SLOG(SPRING_LOG_ERROR, "failed to write %s", outputPath.c_str());
        return 1;
    }
    const std::string jsonPath =
        fs::path(outputPath).replace_extension(".json").string();
    const std::string json =
        TerrainPages::IndexJson(plan, int64_t(time(nullptr)));
    if (!WriteAllBytes(jsonPath,
            std::vector<uint8_t>(json.begin(), json.end()))) {
        SLOG(SPRING_LOG_ERROR, "failed to write %s", jsonPath.c_str());
        return 1;
    }
    SLOG(SPRING_LOG_INFO,
        "terrain pages: %dx%d elmos, source %dx%d -> levels %d..%d, "
        "%zu pages (%zu bytes) -> %s",
        mapElmosX, mapElmosZ, w, h, plan.finestLevel, plan.rootLevel,
        plan.totalPages, pages.size(), outputPath.c_str());
    return 0;
}

/// Emit the DC measurement as one machine-readable line so a calling
/// converter can apply its own policy without re-decoding the source.
/// Only the caller knows whether a texture is sampled signed (`tex*2-1`),
/// which is what makes a non-neutral mean matter — so this tool measures
/// and the caller judges. Format, one line, on stdout:
///
///   signed-dc: levels=N base=R,G,B top=WxH:R,G,B
///
/// where each R,G,B is a 0..255 channel mean, `base` is level 0 and `top`
/// is the smallest level generated (1x1 with --mipmaps, else level 0).
static void PrintDcReport(const DcReport& dc) {
    printf("signed-dc: levels=%d base=%.4f,%.4f,%.4f top=%dx%d:%.4f,%.4f,%.4f\n",
        dc.levels,
        dc.baseMean[0], dc.baseMean[1], dc.baseMean[2],
        dc.topWidth, dc.topHeight,
        dc.topMean[0], dc.topMean[1], dc.topMean[2]);
    fflush(stdout);
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
        "  %s --raw-dxt1 WxH [--mip-levels N] <input> <output.ktx2>\n"
        "  %s --smf-minimap <input.smf> <output.ktx2>\n"
        "  %s --terrain-pages WxH <ground.png> <ground_pages.bin>\n"
        "\n"
        "DDS sources (BC1/BC3/BC4/BC5) are wrapped as KTX2 without\n"
        "transcoding. RGBA sources (TGA/PNG/JPG/BMP) are encoded via\n"
        "Basis Universal — UASTC for art (default), ETC1S for the SMT\n"
        "tile atlas. The --raw-dxt1 mode wraps a bare DXT1 block stream\n"
        "(used by mapconverter for the SMT atlas); WxH is level 0's\n"
        "dimensions. With --mip-levels N > 1, <input> holds N levels'\n"
        "blocks concatenated in level order (level 0 first), each level\n"
        "halving both dimensions from the previous (must stay multiples\n"
        "of 4) — no runtime mip generation, since WebGL2 cannot\n"
        "generateMipmap() a compressed-format texture.\n"
        "\n"
        "options:\n"
        "  --encoding uastc|etc1s   Encoder for non-DDS sources (default: uastc)\n"
        "  --mipmaps                Generate mip chain for encoded sources\n"
        "  --mip-levels N           Level count for --raw-dxt1 (default: 1)\n"
        "  --signed-dc-report       Print the source's level-0 and top-mip\n"
        "                           channel means as one `signed-dc:` line.\n"
        "                           For textures the shader samples signed\n"
        "                           (`tex*2-1`, i.e. Recoil's near-field\n"
        "                           detail): the top mip's mean is a constant\n"
        "                           the mip chain never fades, so a mean off\n"
        "                           127.5 tints the map at every distance.\n"
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
        "  --log-level <level>      debug/info/notice/warning/error\n"
        "\n"
        "The --terrain-pages mode (PLAN-maps.md §1.2.1 streaming v2) cuts a\n"
        "map-space ground albedo into the client's 520^2 BC1 page pyramid;\n"
        "WxH is the MAP extent in elmos. Writes the .bin page stream plus a\n"
        "self-describing .json index at the same stem. Only levels the\n"
        "source resolution covers without upsampling are produced.\n",
        argv0, argv0, argv0, argv0);
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
    bool terrainPages = false;
    int pagesElmosX = 0, pagesElmosZ = 0;
    int rawW = 0, rawH = 0;
    int rawMipLevels = 1;
    std::string pngFallbackPath;
    ChannelOp channelOp = ChannelOp::None;
    std::string tex2Path;
    bool dcReport = false;

    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--png-fallback" && i + 1 < argc) {
            pngFallbackPath = argv[++i];
        } else if (a == "--encoding" && i + 1 < argc) {
            const std::string v = argv[++i];
            if (v == "uastc") enc = Encoding::Uastc;
            else if (v == "etc1s") enc = Encoding::Etc1s;
            else { SLOG(SPRING_LOG_ERROR, "bad --encoding: %s", v.c_str()); return 2; }
        } else if (a == "--signed-dc-report") {
            dcReport = true;
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
        } else if (a == "--mip-levels" && i + 1 < argc) {
            try {
                rawMipLevels = std::stoi(argv[++i]);
            } catch (...) { rawMipLevels = 0; }
            if (rawMipLevels < 1) {
                SLOG(SPRING_LOG_ERROR, "bad --mip-levels");
                springlog_shutdown();
                return 2;
            }
        } else if (a == "--smf-minimap") {
            smfMinimap = true;
        } else if (a == "--terrain-pages" && i + 1 < argc) {
            terrainPages = true;
            if (!ParseDims(argv[++i], pagesElmosX, pagesElmosZ)) {
                SLOG(SPRING_LOG_ERROR, "bad --terrain-pages dims");
                springlog_shutdown();
                return 2;
            }
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
    if (terrainPages) {
        rc = BuildTerrainPages(inputPath, outputPath, pagesElmosX, pagesElmosZ);
    } else if (smfMinimap) {
        rc = ExtractSmfMinimapToKtx2(inputPath, outputPath, zstd) ? 0 : 1;
    } else if (rawDxt1) {
        std::vector<uint8_t> bytes = ReadAllBytes(inputPath);
        rc = WrapRawDxt1AsKtx2(bytes, rawW, rawH, rawMipLevels, outputPath, zstd) ? 0 : 1;
    } else {
        DcReport dc;
        rc = ConvertGeneric(inputPath, outputPath, enc, genMips, zstd,
                            pngFallbackPath, channelOp, tex2Path,
                            dcReport ? &dc : nullptr);
        if (rc == 0 && dcReport && dc.levels > 0)
            PrintDcReport(dc);
    }

    springlog_shutdown();
    return rc;
}
