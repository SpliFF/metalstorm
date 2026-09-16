// TerrainKnowledge — the per-ally-team ever-seen terrain mask.
//
// See client/src/core/DESIGN-TERRAIN-KNOWLEDGE.md (the arc's binding design).
// Short version: a player's knowledge of the terrain is limited to what their
// side has seen. The server always keeps full terrain — the sim, pathing and
// ballistics never consult this mask. This is a *knowledge* structure.
//
// Granularity is the client's terrain CHUNK (terrain.ts `planTerrainChunks`),
// so the whole mask is at most 8x8 = 64 bits per ally team. That single number
// is what lets every decision here be the simple one: the wire message carries
// the ENTIRE mask every time (idempotent, reorder- and replay-tolerant — the
// entity lane is newest-wins and cannot carry a one-shot signal), the snapshot
// form is 131 bytes for a 16-team game, and a late joiner needs no special
// case because it just gets the next full mask.
//
// The mask is MONOTONE: bits only ever go 0 -> 1. Losing LOS does not unlearn
// terrain; remembered ground persists and, under deformation, is allowed to be
// WRONG (design doc §6 — that is the intel gameplay, not a defect).
//
// Header-only and std-lib only ON PURPOSE: it links into spring-tests with no
// CMake edit and doctests with no engine globals. The one engine-coupled part
// (reading losHandler) is injected as a callback by the caller.
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace TerrainKnowledge {

/// Mirror of the client's `planTerrainChunks` (client/src/core/terrain.ts).
/// Both sides MUST agree on the grid or "known" and "meshed" disagree, so the
/// rule is restated here rather than inferred: start at `chunkQuads`, double
/// until neither axis needs more than `maxPerAxis` chunks.
///
/// Small maps (<= 513 corners on both axes) take the client's single-mesh
/// path: one chunk covering everything.
struct ChunkPlan {
    int chunkQuads = 0;
    int chunksX = 0;
    int chunksZ = 0;

    int Count() const { return chunksX * chunksZ; }
    /// Packed-plane size in bytes (MSB-first bit packing).
    size_t PlaneBytes() const {
        return (static_cast<size_t>(Count()) + 7) / 8;
    }
};

/// `hmW`/`hmH` are CORNER counts (map squares + 1), matching the client's
/// `dims.mapx + 1`.
inline ChunkPlan PlanChunks(int hmW, int hmH,
                            int chunkQuads = 128, int maxPerAxis = 8)
{
    ChunkPlan plan;
    const int quadsX = hmW - 1;
    const int quadsZ = hmH - 1;
    if (quadsX <= 0 || quadsZ <= 0) return plan;

    // The single-mesh small-map path: one chunk, no LOD, no seams.
    if (hmW <= 513 && hmH <= 513) {
        plan.chunkQuads = (quadsX > quadsZ) ? quadsX : quadsZ;
        plan.chunksX = 1;
        plan.chunksZ = 1;
        return plan;
    }

    int q = (chunkQuads < 1) ? 1 : chunkQuads;
    const int cap = (maxPerAxis < 1) ? 1 : maxPerAxis;
    const auto ceilDiv = [](int a, int b) { return (a + b - 1) / b; };
    while (ceilDiv(quadsX, q) > cap || ceilDiv(quadsZ, q) > cap)
        q *= 2;

    plan.chunkQuads = q;
    plan.chunksX = ceilDiv(quadsX, q);
    plan.chunksZ = ceilDiv(quadsZ, q);
    return plan;
}

/// The per-ally-team mask itself. One byte per chunk in memory (bit-packing is
/// a wire/snapshot concern, not a storage one — 64 bytes per ally team is not
/// worth the shift arithmetic on every read).
class Mask {
public:
    Mask() = default;
    Mask(const ChunkPlan& plan, int allyTeamCount) { Reset(plan, allyTeamCount); }

    void Reset(const ChunkPlan& plan, int allyTeamCount) {
        this->plan = plan;
        allyCount = (allyTeamCount < 0) ? 0 : allyTeamCount;
        const size_t n = static_cast<size_t>(allyCount) * plan.Count();
        bits.assign(n, uint8_t{0});
        revisions.assign(static_cast<size_t>(allyCount), uint32_t{0});
    }

    const ChunkPlan& Plan() const { return plan; }
    int AllyTeamCount() const { return allyCount; }

    bool Valid(int ally, int cx, int cz) const {
        return ally >= 0 && ally < allyCount
            && cx >= 0 && cx < plan.chunksX
            && cz >= 0 && cz < plan.chunksZ;
    }

    bool IsKnown(int ally, int cx, int cz) const {
        if (!Valid(ally, cx, cz)) return false;
        return bits[Index(ally, cx, cz)] != 0;
    }

    /// Set the bit. Returns true only when it was NEWLY set — the caller uses
    /// that to decide whether anything has to go on the wire. Monotone: there
    /// is deliberately no Clear().
    bool Reveal(int ally, int cx, int cz) {
        if (!Valid(ally, cx, cz)) return false;
        uint8_t& b = bits[Index(ally, cx, cz)];
        if (b != 0) return false;
        b = 1;
        revisions[static_cast<size_t>(ally)]++;
        return true;
    }

    /// Reveal every chunk for one ally team (GlobalLOS / the `/globalLOS`
    /// debug verb, and the "knowledge is off" stock path). Returns true if
    /// anything changed.
    bool RevealAll(int ally) {
        if (ally < 0 || ally >= allyCount) return false;
        bool changed = false;
        for (int cz = 0; cz < plan.chunksZ; ++cz)
            for (int cx = 0; cx < plan.chunksX; ++cx)
                changed |= Reveal(ally, cx, cz);
        return changed;
    }

    /// Bumped on every newly-set bit. A streamer compares it against what it
    /// last sent to skip an unchanged mask — but note the wire message is
    /// idempotent anyway (design §4.2), so a missed comparison costs bandwidth,
    /// never correctness.
    uint32_t Revision(int ally) const {
        if (ally < 0 || ally >= allyCount) return 0;
        return revisions[static_cast<size_t>(ally)];
    }

    int KnownCount(int ally) const {
        if (ally < 0 || ally >= allyCount) return 0;
        int n = 0;
        for (int i = 0; i < plan.Count(); ++i)
            if (bits[static_cast<size_t>(ally) * plan.Count() + i] != 0) ++n;
        return n;
    }

    /// Bit-pack one ally team's plane MSB-first, row-major (z outer, x inner)
    /// — the same convention as the LOS bitmap's planes (IntelEventCollector).
    std::vector<uint8_t> Pack(int ally) const {
        std::vector<uint8_t> out(plan.PlaneBytes(), uint8_t{0});
        if (ally < 0 || ally >= allyCount) return out;
        const int n = plan.Count();
        for (int i = 0; i < n; ++i) {
            if (bits[static_cast<size_t>(ally) * n + i] == 0) continue;
            out[static_cast<size_t>(i) >> 3] |=
                static_cast<uint8_t>(1u << (7 - (i & 7)));
        }
        return out;
    }

    /// Restore a packed plane (snapshot resume). ORs rather than assigns, so a
    /// restore can never un-reveal — the same monotone rule the client applies.
    void Unpack(int ally, const uint8_t* packed, size_t len) {
        if (ally < 0 || ally >= allyCount || packed == nullptr) return;
        if (len < plan.PlaneBytes()) return;
        const int n = plan.Count();
        for (int i = 0; i < n; ++i) {
            const bool set = (packed[static_cast<size_t>(i) >> 3]
                              & (1u << (7 - (i & 7)))) != 0;
            if (set) Reveal(ally, i % plan.chunksX, i / plan.chunksX);
        }
    }

    /// Sweep one ally team's LOS map and reveal every chunk it touches.
    ///
    /// `inLos(losX, losZ)` is the engine coupling, injected so this header
    /// stays testable: it answers "is this square of the LOS map lit for this
    /// ally". `losW`/`losH` are the LOS map's own dimensions and `squaresPerLos`
    /// is its mip ratio against map squares (losHandler->los.mipLevel).
    ///
    /// LOS ONLY — not radar, not air-LOS. Radar tells you something is there;
    /// it does not tell you what the ground looks like (design §2.4).
    ///
    /// Returns the number of chunks newly revealed. Early-outs per chunk on the
    /// first lit square, and skips chunks already known, so a settled game pays
    /// almost nothing.
    template <typename InLosFn>
    int UpdateFromLos(int ally, int losW, int losH, int squaresPerLos,
                      InLosFn&& inLos)
    {
        if (ally < 0 || ally >= allyCount) return 0;
        if (losW <= 0 || losH <= 0 || squaresPerLos <= 0) return 0;
        if (plan.chunkQuads <= 0) return 0;

        // Map-square extent of one chunk -> LOS-map extent.
        const int losPerChunk = (plan.chunkQuads + squaresPerLos - 1)
                              / squaresPerLos;
        if (losPerChunk <= 0) return 0;

        int revealed = 0;
        for (int cz = 0; cz < plan.chunksZ; ++cz) {
            for (int cx = 0; cx < plan.chunksX; ++cx) {
                if (IsKnown(ally, cx, cz)) continue;
                const int lx0 = cx * losPerChunk;
                const int lz0 = cz * losPerChunk;
                const int lx1 = (lx0 + losPerChunk < losW) ? lx0 + losPerChunk : losW;
                const int lz1 = (lz0 + losPerChunk < losH) ? lz0 + losPerChunk : losH;
                bool lit = false;
                for (int lz = lz0; !lit && lz < lz1; ++lz)
                    for (int lx = lx0; !lit && lx < lx1; ++lx)
                        if (inLos(lx, lz)) lit = true;
                if (lit && Reveal(ally, cx, cz)) ++revealed;
            }
        }
        return revealed;
    }

private:
    size_t Index(int ally, int cx, int cz) const {
        return static_cast<size_t>(ally) * plan.Count()
             + static_cast<size_t>(cz) * plan.chunksX + cx;
    }

    ChunkPlan plan;
    int allyCount = 0;
    std::vector<uint8_t> bits;
    std::vector<uint32_t> revisions;
};

} // namespace TerrainKnowledge
