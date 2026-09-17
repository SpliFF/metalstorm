#include <doctest/doctest.h>

#include "Server/TerrainKnowledge.h"

#include <cstdint>
#include <vector>

// terrain-knowledge-is-LOS, K0. The per-ally ever-seen terrain mask.
// Design: client/src/core/DESIGN-TERRAIN-KNOWLEDGE.md.
//
// TerrainKnowledge.h is header-only and std-lib only on purpose, so this is a
// plain doctest with no engine globals, no sim and no LOS handler — the one
// engine coupling (reading losHandler's map) is a callback the caller injects.

using namespace TerrainKnowledge;

TEST_CASE("PlanChunks mirrors the client's planTerrainChunks") {
    // Small map -> the client's single-mesh path: one chunk, no seams.
    SUBCASE("small map is one chunk") {
        const auto p = PlanChunks(513, 513);
        CHECK(p.chunksX == 1);
        CHECK(p.chunksZ == 1);
        CHECK(p.chunkQuads == 512);
        CHECK(p.Count() == 1);
        CHECK(p.PlaneBytes() == 1);
    }

    // A standard 8192-elmo map: mapx = 1024 squares -> 1025 corners.
    // 1024 quads / 128 = 8 chunks per axis exactly, at the 8-per-axis cap.
    SUBCASE("8192-elmo map lands on 8x8 chunks of 128 quads") {
        const auto p = PlanChunks(1025, 1025);
        CHECK(p.chunkQuads == 128);
        CHECK(p.chunksX == 8);
        CHECK(p.chunksZ == 8);
        CHECK(p.Count() == 64);
        // The number the whole design rests on: the mask is 8 bytes.
        CHECK(p.PlaneBytes() == 8);
    }

    // pelagic_vastness (32768 elmos, mapx = 4096 squares). The plan doubles
    // chunkQuads until the 8-per-axis cap holds: 128 -> 256 -> 512.
    SUBCASE("32k-elmo map doubles chunkQuads to stay under the axis cap") {
        const auto p = PlanChunks(4097, 4097);
        CHECK(p.chunkQuads == 512);
        CHECK(p.chunksX == 8);
        CHECK(p.chunksZ == 8);
        CHECK(p.PlaneBytes() == 8);
    }

    SUBCASE("non-square maps get independent axis counts") {
        // 1025x2049 corners = 1024x2048 quads. The Z axis needs the doubling
        // (2048/128 = 16 > 8), and BOTH axes take the bigger chunk — so X ends
        // up with FEWER chunks, not eight. The grid is not square.
        const auto p = PlanChunks(1025, 2049);
        CHECK(p.chunkQuads == 256);
        CHECK(p.chunksX == 4);
        CHECK(p.chunksZ == 8);
        CHECK(p.Count() == 32);
        CHECK(p.PlaneBytes() == 4);
    }

    SUBCASE("degenerate dimensions plan nothing rather than dividing by zero") {
        const auto p = PlanChunks(1, 1);
        CHECK(p.Count() == 0);
    }
}

TEST_CASE("Mask is monotone — bits only ever go 0 -> 1") {
    Mask m(PlanChunks(1025, 1025), 2);
    REQUIRE(m.Plan().Count() == 64);

    CHECK_FALSE(m.IsKnown(0, 3, 4));
    CHECK(m.Reveal(0, 3, 4));          // newly set
    CHECK(m.IsKnown(0, 3, 4));
    CHECK_FALSE(m.Reveal(0, 3, 4));    // already known -> not "newly" set
    CHECK(m.IsKnown(0, 3, 4));

    // Ally teams are independent: one side's exploration is not the other's.
    CHECK_FALSE(m.IsKnown(1, 3, 4));

    // There is deliberately no Clear() — losing LOS never unlearns terrain.
    CHECK(m.KnownCount(0) == 1);
    CHECK(m.KnownCount(1) == 0);
}

TEST_CASE("Mask rejects out-of-range coordinates instead of corrupting") {
    Mask m(PlanChunks(1025, 1025), 2);
    CHECK_FALSE(m.Reveal(-1, 0, 0));
    CHECK_FALSE(m.Reveal(2, 0, 0));     // only 2 ally teams: 0 and 1
    CHECK_FALSE(m.Reveal(0, 8, 0));
    CHECK_FALSE(m.Reveal(0, 0, 8));
    CHECK_FALSE(m.IsKnown(0, 8, 0));
    CHECK(m.KnownCount(0) == 0);
}

TEST_CASE("Revision advances only on a newly-set bit") {
    Mask m(PlanChunks(1025, 1025), 1);
    CHECK(m.Revision(0) == 0);
    m.Reveal(0, 1, 1);
    CHECK(m.Revision(0) == 1);
    m.Reveal(0, 1, 1);                  // repeat
    CHECK(m.Revision(0) == 1);
    m.Reveal(0, 2, 1);
    CHECK(m.Revision(0) == 2);
}

TEST_CASE("RevealAll covers the grid (GlobalLOS / spectator)") {
    Mask m(PlanChunks(1025, 1025), 1);
    CHECK(m.RevealAll(0));
    CHECK(m.KnownCount(0) == 64);
    CHECK_FALSE(m.RevealAll(0));        // idempotent
}

TEST_CASE("Pack/Unpack round-trips MSB-first, row-major") {
    const auto plan = PlanChunks(1025, 1025);
    Mask a(plan, 1);
    a.Reveal(0, 0, 0);                  // chunk index 0 -> byte 0, bit 7
    a.Reveal(0, 7, 0);                  // chunk index 7 -> byte 0, bit 0
    a.Reveal(0, 0, 1);                  // chunk index 8 -> byte 1, bit 7
    a.Reveal(0, 7, 7);                  // chunk index 63 -> byte 7, bit 0

    const auto packed = a.Pack(0);
    REQUIRE(packed.size() == 8);
    CHECK(packed[0] == 0x81);           // bits 7 and 0 of the first byte
    CHECK(packed[1] == 0x80);
    CHECK(packed[7] == 0x01);

    Mask b(plan, 1);
    b.Unpack(0, packed.data(), packed.size());
    CHECK(b.KnownCount(0) == 4);
    CHECK(b.IsKnown(0, 0, 0));
    CHECK(b.IsKnown(0, 7, 0));
    CHECK(b.IsKnown(0, 0, 1));
    CHECK(b.IsKnown(0, 7, 7));
    CHECK_FALSE(b.IsKnown(0, 1, 0));
}

TEST_CASE("Unpack ORs — a stale plane can never un-reveal") {
    const auto plan = PlanChunks(1025, 1025);
    Mask m(plan, 1);
    m.Reveal(0, 5, 5);

    // A plane from an EARLIER state, arriving late (the newest-wins entity
    // lane gives no ordering). Applying it must not lose chunk (5,5).
    Mask older(plan, 1);
    older.Reveal(0, 1, 1);
    const auto stale = older.Pack(0);

    m.Unpack(0, stale.data(), stale.size());
    CHECK(m.IsKnown(0, 5, 5));
    CHECK(m.IsKnown(0, 1, 1));
    CHECK(m.KnownCount(0) == 2);
}

TEST_CASE("Unpack refuses a short plane rather than reading past the end") {
    Mask m(PlanChunks(1025, 1025), 1);
    const std::vector<uint8_t> tooShort(3, 0xFF);
    m.Unpack(0, tooShort.data(), tooShort.size());
    CHECK(m.KnownCount(0) == 0);
    m.Unpack(0, nullptr, 8);
    CHECK(m.KnownCount(0) == 0);
}

TEST_CASE("UpdateFromLos reveals exactly the chunks LOS touches") {
    // 8x8 chunks of 128 map squares each. LOS map at mip 2 -> 4 squares per
    // LOS square -> 256x256 LOS squares, 32 per chunk axis.
    const auto plan = PlanChunks(1025, 1025);
    Mask m(plan, 1);
    const int losW = 256, losH = 256, squaresPerLos = 4;

    std::vector<uint8_t> los(static_cast<size_t>(losW) * losH, 0);
    const auto set = [&](int x, int z) { los[static_cast<size_t>(z) * losW + x] = 1; };
    const auto inLos = [&](int x, int z) {
        return los[static_cast<size_t>(z) * losW + x] != 0;
    };

    SUBCASE("a single lit square reveals its whole chunk, and only that one") {
        set(0, 0);                       // chunk (0,0)
        set(100, 40);                    // chunk (3,1): 100/32 = 3, 40/32 = 1
        CHECK(m.UpdateFromLos(0, losW, losH, squaresPerLos, inLos) == 2);
        CHECK(m.IsKnown(0, 0, 0));
        CHECK(m.IsKnown(0, 3, 1));
        CHECK(m.KnownCount(0) == 2);
    }

    SUBCASE("a second sweep over unchanged LOS reveals nothing new") {
        set(0, 0);
        CHECK(m.UpdateFromLos(0, losW, losH, squaresPerLos, inLos) == 1);
        CHECK(m.UpdateFromLos(0, losW, losH, squaresPerLos, inLos) == 0);
        CHECK(m.KnownCount(0) == 1);
    }

    SUBCASE("LOS going dark does not unlearn the chunk") {
        set(0, 0);
        m.UpdateFromLos(0, losW, losH, squaresPerLos, inLos);
        los.assign(los.size(), 0);       // the scout dies / withdraws
        CHECK(m.UpdateFromLos(0, losW, losH, squaresPerLos, inLos) == 0);
        CHECK(m.IsKnown(0, 0, 0));       // remembered terrain persists (§6)
    }

    SUBCASE("an empty LOS map reveals nothing") {
        CHECK(m.UpdateFromLos(0, losW, losH, squaresPerLos, inLos) == 0);
        CHECK(m.KnownCount(0) == 0);
    }

    SUBCASE("degenerate inputs are refused, not divided by") {
        CHECK(m.UpdateFromLos(0, 0, losH, squaresPerLos, inLos) == 0);
        CHECK(m.UpdateFromLos(0, losW, losH, 0, inLos) == 0);
        CHECK(m.UpdateFromLos(9, losW, losH, squaresPerLos, inLos) == 0);
    }
}

TEST_CASE("a fresh mask knows nothing — stock behaviour is never accidental") {
    Mask m(PlanChunks(1025, 1025), 4);
    for (int at = 0; at < 4; ++at)
        CHECK(m.KnownCount(at) == 0);
    // A default-constructed mask plans nothing at all, so a streamer that
    // forgets to Reset() sends no message rather than an empty-but-valid one.
    Mask unset;
    CHECK(unset.Plan().Count() == 0);
    CHECK_FALSE(unset.Reveal(0, 0, 0));
}
