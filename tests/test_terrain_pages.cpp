/**
 * Terrain page pyramid producer — PLAN-maps.md §1.2.1 streaming v2, the
 * server half (format v19).
 *
 * The numbers pinned here are a SHARED CONTRACT with the client:
 * client/src/core/terrain-page-grid.ts defines the same address space
 * (512² payload + 4-texel border = 520² physical, 135 200 bytes BC1) and
 * client/src/core/terrain-page-http.test.ts pins the same byte offsets from
 * the consuming side. A change that breaks one of these suites but not the
 * other is exactly the defect the pair exists to catch.
 */
#include <doctest/doctest.h>

#include "Server/TerrainPages.h"

#include <cstring>
#include <vector>

using namespace TerrainPages;

namespace {

/// Decode one BC1 block's palette + indices back to 16 RGB texels — just
/// enough of a decoder to check the encoder round-trips (4-colour mode only,
/// which the encoder guarantees by construction).
void DecodeBC1Block(const uint8_t in[8], float out[16 * 3]) {
    const uint16_t c0 = uint16_t(in[0] | (in[1] << 8));
    const uint16_t c1 = uint16_t(in[2] | (in[3] << 8));
    float pal[4][3];
    Unpack565(c0, pal[0]);
    Unpack565(c1, pal[1]);
    for (int c = 0; c < 3; c++) {
        pal[2][c] = (2 * pal[0][c] + pal[1][c]) / 3.0f;
        pal[3][c] = (pal[0][c] + 2 * pal[1][c]) / 3.0f;
    }
    const uint32_t bits = uint32_t(in[4]) | (uint32_t(in[5]) << 8)
                        | (uint32_t(in[6]) << 16) | (uint32_t(in[7]) << 24);
    for (int i = 0; i < 16; i++) {
        const uint32_t k = (bits >> (2 * i)) & 3;
        for (int c = 0; c < 3; c++) out[i * 3 + c] = pal[k][c];
    }
}

}  // namespace

TEST_CASE("page format constants match the client's terrain-page-grid.ts") {
    CHECK(PAYLOAD_TEXELS == 512);
    CHECK(BORDER_TEXELS == 4);
    CHECK(PHYSICAL_TEXELS == 520);
    // 520/4 = 130 blocks per axis — block-aligned, which is what lets the
    // client use compressedTexSubImage3D on the whole physical page.
    CHECK(PHYSICAL_TEXELS % 4 == 0);
    CHECK(PAGE_BYTES == 135200);
}

TEST_CASE("16k map with a 2048^2 source: levels 3..5, 21 pages — the pre-raise shape") {
    const Plan p = PlanPages(16384, 16384, 2048, 2048);
    CHECK(p.rootLevel == 5);          // 32/16/8/4/2/1 pages across
    CHECK(p.finestLevel == 3);        // 2048 texels across = level 3 native
    REQUIRE(p.levels.size() == 3);
    CHECK(p.levels[0].level == 3);
    CHECK(p.levels[0].pagesX == 4);
    CHECK(p.levels[0].pagesZ == 4);
    CHECK(p.levels[0].firstPage == 0);
    CHECK(p.levels[1].pagesX == 2);
    CHECK(p.levels[1].firstPage == 16);
    CHECK(p.levels[2].pagesX == 1);
    CHECK(p.levels[2].firstPage == 20);
    CHECK(p.totalPages == 21);
    // The on-disk offsets the client's Range arithmetic must reproduce.
    CHECK(PageByteOffset(p, 3, 0, 0) == 0);
    CHECK(PageByteOffset(p, 3, 1, 2) == (2 * 4 + 1) * PAGE_BYTES);
    CHECK(PageByteOffset(p, 4, 1, 1) == (16 + 3) * PAGE_BYTES);
    CHECK(PageByteOffset(p, 5, 0, 0) == 20 * PAGE_BYTES);
    // Outside the produced pyramid: finer than the source, or off-grid.
    CHECK(PageByteOffset(p, 2, 0, 0) == SIZE_MAX);
    CHECK(PageByteOffset(p, 3, 4, 0) == SIZE_MAX);
    CHECK(PageByteOffset(p, 6, 0, 0) == SIZE_MAX);
}

TEST_CASE("16k map with a 4096^2 source: levels 2..5, 85 pages — the shipped "
          "shape since the M8 streaming-v2 resolution raise") {
    // PLAN-maps §1.2.1 lane queue step 4: the generator default rose
    // 2048 -> 4096 (tools/mapgen/terragen/bake.py GROUND_TEXTURE_SIZE_DEFAULT),
    // so the finest produced page is 4 elmos/texel instead of 8. The format
    // is untouched — the index self-describes, this only moves finestLevel.
    const Plan p = PlanPages(16384, 16384, 4096, 4096);
    CHECK(p.rootLevel == 5);
    CHECK(p.finestLevel == 2);        // 4096 texels across = level 2 native
    REQUIRE(p.levels.size() == 4);
    CHECK(p.levels[0].level == 2);
    CHECK(p.levels[0].pagesX == 8);
    CHECK(p.levels[0].pagesZ == 8);
    CHECK(p.levels[0].firstPage == 0);
    CHECK(p.levels[1].pagesX == 4);
    CHECK(p.levels[1].firstPage == 64);
    CHECK(p.levels[2].pagesX == 2);
    CHECK(p.levels[2].firstPage == 80);
    CHECK(p.levels[3].pagesX == 1);
    CHECK(p.levels[3].firstPage == 84);
    CHECK(p.totalPages == 85);        // 85 * PAGE_BYTES = 11 492 000 on disk
    CHECK(PageByteOffset(p, 2, 0, 0) == 0);
    CHECK(PageByteOffset(p, 2, 3, 5) == (5 * 8 + 3) * PAGE_BYTES);
    CHECK(PageByteOffset(p, 3, 1, 2) == (64 + 2 * 4 + 1) * PAGE_BYTES);
    CHECK(PageByteOffset(p, 5, 0, 0) == 84 * PAGE_BYTES);
    // Finer than the source is still refused, exactly as at 2048.
    CHECK(PageByteOffset(p, 1, 0, 0) == SIZE_MAX);
    CHECK(PageByteOffset(p, 2, 8, 0) == SIZE_MAX);
}

TEST_CASE("a source at full 1 texel/elmo residency reaches level 0") {
    const Plan p = PlanPages(16384, 16384, 16384, 16384);
    CHECK(p.finestLevel == 0);
    CHECK(p.levels.size() == 6);
    CHECK(p.levels[0].pagesX == 32);
    CHECK(p.totalPages == 32 * 32 + 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1);
}

TEST_CASE("BC1 range-fit: a solid block round-trips to its own colour") {
    float block[16 * 3];
    for (int i = 0; i < 16; i++) {
        block[i * 3 + 0] = 96;
        block[i * 3 + 1] = 160;
        block[i * 3 + 2] = 64;
    }
    uint8_t enc[8];
    EncodeBC1Block(block, enc);
    float dec[16 * 3];
    DecodeBC1Block(enc, dec);
    for (int i = 0; i < 16; i++) {
        // 565 quantisation: within half a quantisation step per channel.
        CHECK(dec[i * 3 + 0] == doctest::Approx(96).epsilon(0.05));
        CHECK(dec[i * 3 + 1] == doctest::Approx(160).epsilon(0.03));
        CHECK(dec[i * 3 + 2] == doctest::Approx(64).epsilon(0.07));
    }
}

TEST_CASE("BC1 range-fit: a two-colour block keeps both endpoints apart") {
    float block[16 * 3];
    for (int i = 0; i < 16; i++) {
        const bool dark = i < 8;
        block[i * 3 + 0] = dark ? 32 : 224;
        block[i * 3 + 1] = dark ? 32 : 224;
        block[i * 3 + 2] = dark ? 32 : 224;
    }
    uint8_t enc[8];
    EncodeBC1Block(block, enc);
    float dec[16 * 3];
    DecodeBC1Block(enc, dec);
    for (int i = 0; i < 16; i++) {
        const float want = i < 8 ? 32.0f : 224.0f;
        CHECK(std::abs(dec[i * 3 + 0] - want) < 8.0f);
    }
    // 4-colour mode: c0 > c1 always (the encoder swaps/nudges).
    const uint16_t c0 = uint16_t(enc[0] | (enc[1] << 8));
    const uint16_t c1 = uint16_t(enc[2] | (enc[3] << 8));
    CHECK(c0 > c1);
}

TEST_CASE("native-level extraction is an exact 1:1 copy, border clamps at the map edge") {
    // A map whose single produced level is native: 2048-elmo map, 512² source
    // → finest = root = level 2? No: 2048 elmos = 4 L0 pages… source 512
    // covers level 2 (2048>>2 = 512). Root: level 2 is 1 page. So one page,
    // level 2 == root, native.
    const Plan p = PlanPages(2048, 2048, 512, 512);
    REQUIRE(p.finestLevel == 2);
    REQUIRE(p.rootLevel == 2);
    REQUIRE(p.totalPages == 1);

    // Deterministic source: R encodes x, G encodes y, B constant.
    std::vector<uint8_t> src(512 * 512 * 3);
    for (int y = 0; y < 512; y++)
        for (int x = 0; x < 512; x++) {
            src[(size_t(y) * 512 + x) * 3 + 0] = uint8_t(x % 251);
            src[(size_t(y) * 512 + x) * 3 + 1] = uint8_t(y % 241);
            src[(size_t(y) * 512 + x) * 3 + 2] = 77;
        }
    const auto mips = BuildSourceMips(src.data(), 512, 512, 1);
    std::vector<float> rgb(size_t(PHYSICAL_TEXELS) * PHYSICAL_TEXELS * 3);
    ExtractPageRgb(mips[0], p, 2, 0, 0, rgb.data());

    // Payload texel (i, j) == source texel (i, j), bit exact.
    for (int j : {0, 1, 200, 511}) {
        for (int i : {0, 3, 137, 511}) {
            const float* t =
                &rgb[(size_t(j + BORDER_TEXELS) * PHYSICAL_TEXELS
                      + (i + BORDER_TEXELS)) * 3];
            CHECK(t[0] == doctest::Approx(src[(size_t(j) * 512 + i) * 3 + 0]));
            CHECK(t[1] == doctest::Approx(src[(size_t(j) * 512 + i) * 3 + 1]));
            CHECK(t[2] == doctest::Approx(77));
        }
    }
    // Border texels beyond the map edge clamp to the edge row/column.
    const float* corner = &rgb[0];  // physical (0,0) = payload (-4,-4)
    CHECK(corner[0] == doctest::Approx(src[0]));
    CHECK(corner[1] == doctest::Approx(src[1]));
    const float* right =
        &rgb[(size_t(BORDER_TEXELS) * PHYSICAL_TEXELS + PHYSICAL_TEXELS - 1) * 3];
    CHECK(right[0] == doctest::Approx(src[(size_t(0) * 512 + 511) * 3 + 0]));
}

TEST_CASE("BuildPages writes the exact on-disk byte count in level order") {
    // Tiny synthetic: 1024-elmo map, 256² source → levels 2 (256 texels,
    // 1 page)… 1024 elmos: L0 = 2 pages across, root = 1 → rootLevel 1.
    // Source 256: texels at L2 = 256 → but root is 1... texelsAt(1024, 1) =
    // 512 > 256, so finest = 2 > rootLevel → clamped to root by PlanPages'
    // loop bound (finest stops at rootLevel).
    const Plan p = PlanPages(1024, 1024, 256, 256);
    CHECK(p.rootLevel == 1);
    CHECK(p.finestLevel == 1);  // clamped: even the root upsamples a little
    CHECK(p.totalPages == 1);

    std::vector<uint8_t> src(256 * 256 * 3, 128);
    std::vector<uint8_t> out;
    BuildPages(src.data(), p, out);
    CHECK(out.size() == p.totalPages * PAGE_BYTES);
}

TEST_CASE("index JSON carries the fields the client validates") {
    const Plan p = PlanPages(16384, 16384, 2048, 2048);
    const std::string j = IndexJson(p, 1234567);
    CHECK(j.find("\"version\":1") != std::string::npos);
    CHECK(j.find("\"pageBytes\":135200") != std::string::npos);
    CHECK(j.find("\"payloadTexels\":512") != std::string::npos);
    CHECK(j.find("\"borderTexels\":4") != std::string::npos);
    CHECK(j.find("\"finestLevel\":3") != std::string::npos);
    CHECK(j.find("\"totalPages\":21") != std::string::npos);
    CHECK(j.find("\"stamp\":1234567") != std::string::npos);
    CHECK(j.find("{\"level\":3,\"pagesX\":4,\"pagesZ\":4,\"firstPage\":0}")
          != std::string::npos);
    CHECK(j.find("{\"level\":5,\"pagesX\":1,\"pagesZ\":1,\"firstPage\":20}")
          != std::string::npos);
}
