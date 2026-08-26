// TerrainPages — the server half of PLAN-maps.md §1.2.1 streaming v2: cut a
// map-space ground albedo into the 520² BC1 page pyramid the client's
// TerrainPageCache consumes.
//
// The ADDRESS SPACE is the client's (client/src/core/terrain-page-grid.ts):
// level 0 is 1 texel/elmo, a page owns 512² payload texels plus a 4-texel
// border (one BC1 block) on every side — 520² physical, 135 200 bytes BC1 —
// and levels halve until one page covers the map. This header must agree with
// that file texel for texel; tests/test_terrain_pages.cpp pins the shared
// numbers and client/src/core/terrain-page-http.test.ts pins the same ones
// from the other side.
//
// What is PRODUCED is only the levels the source image actually carries.
// Since the M8 streaming-v2 resolution raise (PLAN-maps §1.2.1 lane queue
// step 4, 2026-08-27) the generator default is a 4096² source, so a
// 16 384-elmo map gets levels 2..5 — 85 pages, ~11.5 MB (the pre-raise 2048²
// shape was levels 3..5 — 21 pages, ~2.8 MB, and older packages still
// carrying it keep working: the index self-describes). Levels finer than the
// source would be upsampled blur at 135 KB a page; the client clamps its
// visible-set descent to `finestLevel` instead (terrain-page-visibility.ts
// `minLevel`). A resolution change is never a format change: a finer source
// simply yields a smaller `finestLevel` here.
//
// On-disk format (MAP_FORMAT_VERSION 19):
//   ground_pages.bin   pages back to back, PAGE_BYTES each, levels ascending
//                      (finest produced level first), rows z-major / x-minor
//                      inside a level. Offset arithmetic is `firstPage` below.
//   ground_pages.json  the self-describing index (TerrainPagesIndexJson).
//
// BC1 encoding is the same range-fit tools/mapgen/terragen/dxt1.py uses for
// the SMT tiles (principal-axis endpoints, 4-colour mode): below a production
// encoder, visually fine for terrain albedo that also receives the detail
// splat on top, and deterministic.
//
// Header-only, std-only: shared by textureconverter (the producer),
// MapProcessor (the caller) and the doctest suite.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace TerrainPages {

constexpr int PAYLOAD_TEXELS = 512;
constexpr int BORDER_TEXELS = 4;
constexpr int PHYSICAL_TEXELS = PAYLOAD_TEXELS + 2 * BORDER_TEXELS;  // 520
constexpr int BC1_BLOCK_BYTES = 8;
constexpr size_t PAGE_BYTES =
    size_t(PHYSICAL_TEXELS / 4) * (PHYSICAL_TEXELS / 4) * BC1_BLOCK_BYTES;  // 135 200
constexpr int INDEX_VERSION = 1;

struct Level {
    int level = 0;       // client pyramid level (0 = 1 texel/elmo)
    int pagesX = 0;
    int pagesZ = 0;
    size_t firstPage = 0;  // cumulative page offset inside ground_pages.bin
};

struct Plan {
    int mapElmosX = 0, mapElmosZ = 0;
    int sourceW = 0, sourceH = 0;
    /// Finest level the source resolution actually covers (no upsampling).
    int finestLevel = 0;
    int rootLevel = 0;
    /// Ascending from finestLevel to rootLevel (the 1×1 page).
    std::vector<Level> levels;
    size_t totalPages = 0;
};

inline int PagesAcross(int texels, int level) {
    const int64_t texelsPerPage = int64_t(PAYLOAD_TEXELS) << level;
    return std::max<int64_t>(1, (int64_t(texels) + texelsPerPage - 1) / texelsPerPage);
}

/// Mirror of the client's planPageGrid at 1 texel/elmo, restricted to the
/// levels `sourceW × sourceH` can fill without upsampling.
inline Plan PlanPages(int mapElmosX, int mapElmosZ, int sourceW, int sourceH) {
    Plan p;
    p.mapElmosX = std::max(1, mapElmosX);
    p.mapElmosZ = std::max(1, mapElmosZ);
    p.sourceW = std::max(1, sourceW);
    p.sourceH = std::max(1, sourceH);

    int rootLevel = 0;
    while ((PagesAcross(p.mapElmosX, rootLevel) > 1 ||
            PagesAcross(p.mapElmosZ, rootLevel) > 1) && rootLevel < 24)
        rootLevel++;
    p.rootLevel = rootLevel;

    auto texelsAt = [](int texels, int level) {
        return std::max<int64_t>(1, (int64_t(texels) + (int64_t(1) << level) - 1)
                                        >> level);
    };
    int finest = 0;
    while (finest < rootLevel &&
           (texelsAt(p.mapElmosX, finest) > p.sourceW ||
            texelsAt(p.mapElmosZ, finest) > p.sourceH))
        finest++;
    p.finestLevel = finest;

    size_t total = 0;
    for (int L = finest; L <= rootLevel; L++) {
        Level lv;
        lv.level = L;
        lv.pagesX = PagesAcross(p.mapElmosX, L);
        lv.pagesZ = PagesAcross(p.mapElmosZ, L);
        lv.firstPage = total;
        total += size_t(lv.pagesX) * lv.pagesZ;
        p.levels.push_back(lv);
    }
    p.totalPages = total;
    return p;
}

/// Byte offset of one page inside ground_pages.bin, or SIZE_MAX when the page
/// is outside the produced pyramid. This is the contract the client's
/// HttpPageSource Range arithmetic mirrors.
inline size_t PageByteOffset(const Plan& p, int level, int x, int z) {
    if (level < p.finestLevel || level > p.rootLevel) return SIZE_MAX;
    const Level& lv = p.levels[level - p.finestLevel];
    if (x < 0 || z < 0 || x >= lv.pagesX || z >= lv.pagesZ) return SIZE_MAX;
    return (lv.firstPage + size_t(z) * lv.pagesX + x) * PAGE_BYTES;
}

// ------------------------------------------------------------------
// BC1 (range-fit, port of tools/mapgen/terragen/dxt1.py encode_dxt1)
// ------------------------------------------------------------------

inline uint16_t Pack565(float r, float g, float b) {
    const int ri = std::clamp(int(std::lround(r)), 0, 255) >> 3;
    const int gi = std::clamp(int(std::lround(g)), 0, 255) >> 2;
    const int bi = std::clamp(int(std::lround(b)), 0, 255) >> 3;
    return uint16_t((ri << 11) | (gi << 5) | bi);
}

inline void Unpack565(uint16_t c, float rgb[3]) {
    rgb[0] = float((c >> 11) & 31) * (255.0f / 31.0f);
    rgb[1] = float((c >> 5) & 63) * (255.0f / 63.0f);
    rgb[2] = float(c & 31) * (255.0f / 31.0f);
}

/// Encode one 4×4 RGB block (row-major, 48 floats in 0..255) to 8 BC1 bytes.
inline void EncodeBC1Block(const float* texels, uint8_t out[8]) {
    float mn[3] = {texels[0], texels[1], texels[2]};
    float mx[3] = {texels[0], texels[1], texels[2]};
    for (int i = 1; i < 16; i++) {
        for (int c = 0; c < 3; c++) {
            mn[c] = std::min(mn[c], texels[i * 3 + c]);
            mx[c] = std::max(mx[c], texels[i * 3 + c]);
        }
    }
    float axis[3] = {mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]};
    const float len = std::sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
    if (len > 0) { axis[0] /= len; axis[1] /= len; axis[2] /= len; }

    float tmin = 1e30f, tmax = -1e30f;
    for (int i = 0; i < 16; i++) {
        const float t = (texels[i * 3 + 0] - mn[0]) * axis[0]
                      + (texels[i * 3 + 1] - mn[1]) * axis[1]
                      + (texels[i * 3 + 2] - mn[2]) * axis[2];
        tmin = std::min(tmin, t);
        tmax = std::max(tmax, t);
    }
    uint16_t c0 = Pack565(mn[0] + axis[0] * tmax, mn[1] + axis[1] * tmax,
                          mn[2] + axis[2] * tmax);
    uint16_t c1 = Pack565(mn[0] + axis[0] * tmin, mn[1] + axis[1] * tmin,
                          mn[2] + axis[2] * tmin);
    // 4-colour mode requires c0 > c1; swap where violated, nudge equals.
    if (c0 < c1) std::swap(c0, c1);
    if (c0 == c1 && c0 < 0xFFFF) c0++;

    float pal[4][3];
    Unpack565(c0, pal[0]);
    Unpack565(c1, pal[1]);
    for (int c = 0; c < 3; c++) {
        pal[2][c] = (2 * pal[0][c] + pal[1][c]) / 3.0f;
        pal[3][c] = (pal[0][c] + 2 * pal[1][c]) / 3.0f;
    }
    uint32_t bits = 0;
    for (int i = 0; i < 16; i++) {
        float best = 1e30f;
        uint32_t bestK = 0;
        for (uint32_t k = 0; k < 4; k++) {
            const float dr = texels[i * 3 + 0] - pal[k][0];
            const float dg = texels[i * 3 + 1] - pal[k][1];
            const float db = texels[i * 3 + 2] - pal[k][2];
            const float d = dr * dr + dg * dg + db * db;
            if (d < best) { best = d; bestK = k; }
        }
        bits |= bestK << (2 * i);
    }
    out[0] = uint8_t(c0 & 0xFF); out[1] = uint8_t(c0 >> 8);
    out[2] = uint8_t(c1 & 0xFF); out[3] = uint8_t(c1 >> 8);
    out[4] = uint8_t(bits & 0xFF); out[5] = uint8_t((bits >> 8) & 0xFF);
    out[6] = uint8_t((bits >> 16) & 0xFF); out[7] = uint8_t((bits >> 24) & 0xFF);
}

// ------------------------------------------------------------------
// Page extraction
// ------------------------------------------------------------------

/// One image level of the source mip chain (RGB8, row-major, row 0 = Z 0).
struct SourceMip {
    int w = 0, h = 0;
    std::vector<uint8_t> rgb;
};

/// Box-filtered mip chain of the source, mip m covering `count` entries so
/// mip index (level - finestLevel) always exists. Source row 0 is world Z 0,
/// matching how the generator's bake writes ground.png and how the client
/// samples it (terrain.ts: "raster stays top-down").
inline std::vector<SourceMip> BuildSourceMips(
    const uint8_t* rgb, int w, int h, int count) {
    std::vector<SourceMip> mips;
    mips.push_back({w, h, std::vector<uint8_t>(rgb, rgb + size_t(w) * h * 3)});
    while (int(mips.size()) < count) {
        const SourceMip& prev = mips.back();
        SourceMip next;
        next.w = std::max(1, prev.w / 2);
        next.h = std::max(1, prev.h / 2);
        next.rgb.resize(size_t(next.w) * next.h * 3);
        for (int y = 0; y < next.h; y++) {
            const int y0 = std::min(2 * y, prev.h - 1);
            const int y1 = std::min(2 * y + 1, prev.h - 1);
            for (int x = 0; x < next.w; x++) {
                const int x0 = std::min(2 * x, prev.w - 1);
                const int x1 = std::min(2 * x + 1, prev.w - 1);
                for (int c = 0; c < 3; c++) {
                    const int s = prev.rgb[(size_t(y0) * prev.w + x0) * 3 + c]
                                + prev.rgb[(size_t(y0) * prev.w + x1) * 3 + c]
                                + prev.rgb[(size_t(y1) * prev.w + x0) * 3 + c]
                                + prev.rgb[(size_t(y1) * prev.w + x1) * 3 + c];
                    next.rgb[(size_t(y) * next.w + x) * 3 + c] = uint8_t((s + 2) / 4);
                }
            }
        }
        mips.push_back(std::move(next));
    }
    return mips;
}

/// Fill one 520² physical page (RGB floats 0..255, row-major) for page
/// (level, px, pz). Texel centre mapping — the exact inverse of the client
/// shader's `pageSampleTransform`: physical texel p (0..519) is payload index
/// i = p - BORDER, world elmo = (page * PAYLOAD + i + 0.5) * 2^level. Border
/// texels continue the same grid past the payload and clamp at the map edge.
/// Bilinear against the mip whose density matches the level; when map and
/// source extents are power-of-two aligned (both shipped maps) the sample
/// lands exactly on a source texel centre and the copy is exact.
inline void ExtractPageRgb(
    const SourceMip& mip, const Plan& plan, int level, int px, int pz,
    float* outRgb /* PHYSICAL_TEXELS² * 3 */) {
    const double texelElmos = double(int64_t(1) << level);
    for (int ty = 0; ty < PHYSICAL_TEXELS; ty++) {
        const double worldZ =
            (double(pz) * PAYLOAD_TEXELS + (ty - BORDER_TEXELS) + 0.5) * texelElmos;
        const double v = worldZ / plan.mapElmosZ * mip.h - 0.5;
        const double vc = std::clamp(v, 0.0, double(mip.h - 1));
        const int y0 = int(vc);
        const int y1 = std::min(y0 + 1, mip.h - 1);
        const float fy = float(vc - y0);
        for (int tx = 0; tx < PHYSICAL_TEXELS; tx++) {
            const double worldX =
                (double(px) * PAYLOAD_TEXELS + (tx - BORDER_TEXELS) + 0.5) * texelElmos;
            const double u = worldX / plan.mapElmosX * mip.w - 0.5;
            const double uc = std::clamp(u, 0.0, double(mip.w - 1));
            const int x0 = int(uc);
            const int x1 = std::min(x0 + 1, mip.w - 1);
            const float fx = float(uc - x0);
            float* dst = outRgb + (size_t(ty) * PHYSICAL_TEXELS + tx) * 3;
            for (int c = 0; c < 3; c++) {
                const float s00 = mip.rgb[(size_t(y0) * mip.w + x0) * 3 + c];
                const float s10 = mip.rgb[(size_t(y0) * mip.w + x1) * 3 + c];
                const float s01 = mip.rgb[(size_t(y1) * mip.w + x0) * 3 + c];
                const float s11 = mip.rgb[(size_t(y1) * mip.w + x1) * 3 + c];
                dst[c] = (s00 * (1 - fx) + s10 * fx) * (1 - fy)
                       + (s01 * (1 - fx) + s11 * fx) * fy;
            }
        }
    }
}

/// Encode one extracted physical page to its PAGE_BYTES BC1 bytes.
inline void EncodePage(const float* rgb, uint8_t* out /* PAGE_BYTES */) {
    constexpr int blocks = PHYSICAL_TEXELS / 4;
    float block[16 * 3];
    for (int by = 0; by < blocks; by++) {
        for (int bx = 0; bx < blocks; bx++) {
            for (int y = 0; y < 4; y++) {
                std::memcpy(
                    block + y * 4 * 3,
                    rgb + ((size_t(by) * 4 + y) * PHYSICAL_TEXELS + size_t(bx) * 4) * 3,
                    4 * 3 * sizeof(float));
            }
            EncodeBC1Block(block, out + (size_t(by) * blocks + bx) * BC1_BLOCK_BYTES);
        }
    }
}

/// Build every produced page, appending to `out` in the on-disk order
/// (levels ascending from finestLevel, rows z-major, x-minor).
inline void BuildPages(const uint8_t* srcRgb, const Plan& plan,
                       std::vector<uint8_t>& out) {
    const auto mips = BuildSourceMips(
        srcRgb, plan.sourceW, plan.sourceH, plan.rootLevel - plan.finestLevel + 1);
    std::vector<float> rgb(size_t(PHYSICAL_TEXELS) * PHYSICAL_TEXELS * 3);
    out.reserve(out.size() + plan.totalPages * PAGE_BYTES);
    for (const Level& lv : plan.levels) {
        const SourceMip& mip = mips[lv.level - plan.finestLevel];
        for (int z = 0; z < lv.pagesZ; z++) {
            for (int x = 0; x < lv.pagesX; x++) {
                ExtractPageRgb(mip, plan, lv.level, x, z, rgb.data());
                const size_t at = out.size();
                out.resize(at + PAGE_BYTES);
                EncodePage(rgb.data(), out.data() + at);
            }
        }
    }
}

/// The self-describing index the client fetches as `ground_pages.json`.
/// `stamp` busts the client's Cache-API disk tier across reprocesses.
inline std::string IndexJson(const Plan& p, int64_t stamp) {
    std::string levels;
    for (const Level& lv : p.levels) {
        char buf[128];
        std::snprintf(buf, sizeof(buf),
            "%s{\"level\":%d,\"pagesX\":%d,\"pagesZ\":%d,\"firstPage\":%zu}",
            levels.empty() ? "" : ",", lv.level, lv.pagesX, lv.pagesZ, lv.firstPage);
        levels += buf;
    }
    char buf[512];
    std::snprintf(buf, sizeof(buf),
        "{\"version\":%d,\"pageBytes\":%zu,\"payloadTexels\":%d,"
        "\"borderTexels\":%d,\"mapElmosX\":%d,\"mapElmosZ\":%d,"
        "\"sourceW\":%d,\"sourceH\":%d,\"finestLevel\":%d,\"rootLevel\":%d,"
        "\"totalPages\":%zu,\"stamp\":%lld,\"levels\":[",
        INDEX_VERSION, PAGE_BYTES, PAYLOAD_TEXELS, BORDER_TEXELS,
        p.mapElmosX, p.mapElmosZ, p.sourceW, p.sourceH, p.finestLevel,
        p.rootLevel, p.totalPages, static_cast<long long>(stamp));
    return std::string(buf) + levels + "]}\n";
}

}  // namespace TerrainPages
