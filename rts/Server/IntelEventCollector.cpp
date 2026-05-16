// IntelEventCollector — see header.

#include "IntelEventCollector.h"

#include "Map/ReadMap.h"
#include "Sim/Misc/LosHandler.h"
#include "System/EventHandler.h"

#include <algorithm>
#include <cstring>

IntelEventCollector* intelEvents = nullptr;

IntelEventCollector::IntelEventCollector()
    : CEventClient("IntelEventCollector", 0, /*synced=*/true)
{
}

void IntelEventCollector::Register() {
    eventHandler.AddClient(this);
}

void IntelEventCollector::UnitSeismicPing(
    const CUnit* /*unit*/, int allyTeam,
    const float3& pos, float strength)
{
    std::lock_guard<std::mutex> lock(mutex);
    seismicPings.push_back({pos, strength, static_cast<int16_t>(allyTeam)});
}

std::vector<SeismicPingData> IntelEventCollector::DrainSeismicPings() {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<SeismicPingData> drained;
    drained.swap(seismicPings);
    return drained;
}

namespace {

/// Cap on the bitmap dimension along each axis. Matches Spring's
/// minimap fog resolution: coarse enough to be cheap, fine enough that
/// `Spring.IsPosInLos` is useful for mex spots and target locations.
constexpr int LOS_BITMAP_MAX_DIM = 64;

/// Bit-pack a (w × h) bool plane MSB-first into `out`, starting at
/// `outOffset`. Returns the number of bytes written.
size_t PackBitPlane(uint8_t* out, size_t outOffset,
                    const std::vector<uint8_t>& plane, int w, int h)
{
    const size_t bits = static_cast<size_t>(w) * static_cast<size_t>(h);
    const size_t bytes = (bits + 7) / 8;
    std::memset(out + outOffset, 0, bytes);
    for (size_t i = 0; i < bits; ++i) {
        if (plane[i]) {
            const size_t byte = i >> 3;
            const size_t bit  = 7 - (i & 7);
            out[outOffset + byte] |= static_cast<uint8_t>(1u << bit);
        }
    }
    return bytes;
}

} // anonymous namespace

std::vector<uint8_t> IntelEventCollector::BuildLosBitmap(
    int allyTeam, uint32_t frameNo)
{
    if (losHandler == nullptr)
        return {};
    if (allyTeam < 0 || allyTeam >= static_cast<int>(exploredMaps.size()))
        return {};

    // LOS / radar maps are stored at the LOS / radar mip resolution.
    // Use the LOS map's native resolution as the *source* size, then
    // downsample to <= LOS_BITMAP_MAX_DIM on each axis.
    const auto& losType   = losHandler->los;
    const auto& radarType = losHandler->radar;
    const auto& airType   = losHandler->airLos;

    const int srcLosW   = losType.size.x;
    const int srcLosH   = losType.size.y;
    const int srcRadW   = radarType.size.x;
    const int srcRadH   = radarType.size.y;
    const int srcAirW   = airType.size.x;
    const int srcAirH   = airType.size.y;

    if (srcLosW <= 0 || srcLosH <= 0)
        return {};

    // The wire bitmap follows the LOS-map shape. Radar and air-LOS
    // get sampled into the same target grid via their own ratios.
    const int dstW = std::min(srcLosW, LOS_BITMAP_MAX_DIM);
    const int dstH = std::min(srcLosH, LOS_BITMAP_MAX_DIM);
    if (dstW <= 0 || dstH <= 0)
        return {};

    if (allyTeam >= static_cast<int>(losType.losMaps.size()))
        return {};

    const auto& losMap = losType.losMaps[allyTeam].GetLosMap();
    const bool hasRadar = (allyTeam < static_cast<int>(radarType.losMaps.size()));
    const bool hasAir   = (allyTeam < static_cast<int>(airType.losMaps.size()));
    const auto* radarMap = hasRadar ? &radarType.losMaps[allyTeam].GetLosMap() : nullptr;
    const auto* airMap   = hasAir   ? &airType.losMaps[allyTeam].GetLosMap()   : nullptr;

    // Build the three planes as byte arrays first (one byte per
    // square; bit-packed at serialisation time).
    std::vector<uint8_t> inLosPlane(static_cast<size_t>(dstW) * dstH, 0);
    std::vector<uint8_t> inRadarPlane(static_cast<size_t>(dstW) * dstH, 0);

    // Lazy-init / resize the explored cache for this ally team.
    auto& exp = exploredMaps[allyTeam];
    auto& expDims = exploredDims[allyTeam];
    if (expDims.first != dstW || expDims.second != dstH) {
        exp.assign(static_cast<size_t>(dstW) * dstH, 0);
        expDims = {dstW, dstH};
    }

    // GlobalLOS (debug /globalLOS or `set_los on`) bypasses the per-
    // square sample: every square reads as in-LOS, in-radar, and
    // explored. The client's fog/minimap fades to fully visible.
    const bool global = losHandler->GetGlobalLOS(allyTeam);
    if (global) {
        std::fill(inLosPlane.begin(), inLosPlane.end(), uint8_t{1});
        std::fill(inRadarPlane.begin(), inRadarPlane.end(), uint8_t{1});
        std::fill(exp.begin(), exp.end(), uint8_t{1});
    }

    const float losXRatio = static_cast<float>(srcLosW) / static_cast<float>(dstW);
    const float losYRatio = static_cast<float>(srcLosH) / static_cast<float>(dstH);
    const float radXRatio = hasRadar ? (static_cast<float>(srcRadW) / static_cast<float>(dstW)) : 1.0f;
    const float radYRatio = hasRadar ? (static_cast<float>(srcRadH) / static_cast<float>(dstH)) : 1.0f;
    const float airXRatio = hasAir   ? (static_cast<float>(srcAirW) / static_cast<float>(dstW)) : 1.0f;
    const float airYRatio = hasAir   ? (static_cast<float>(srcAirH) / static_cast<float>(dstH)) : 1.0f;

    // Downsample with OR: a target square is "set" if *any* source
    // square in its block is set. Optimistic for the player; matches
    // Recoil's minimap fog behaviour at the edges. Skipped entirely
    // when globalLOS forces every plane to all-ones above.
    for (int dy = 0; dy < dstH && !global; ++dy) {
        const int losY0 = static_cast<int>(dy * losYRatio);
        const int losY1 = std::min(srcLosH, static_cast<int>((dy + 1) * losYRatio + 0.5f));
        const int radY0 = hasRadar ? static_cast<int>(dy * radYRatio) : 0;
        const int radY1 = hasRadar ? std::min(srcRadH, static_cast<int>((dy + 1) * radYRatio + 0.5f)) : 0;
        const int airY0 = hasAir   ? static_cast<int>(dy * airYRatio) : 0;
        const int airY1 = hasAir   ? std::min(srcAirH, static_cast<int>((dy + 1) * airYRatio + 0.5f)) : 0;

        for (int dx = 0; dx < dstW; ++dx) {
            const int losX0 = static_cast<int>(dx * losXRatio);
            const int losX1 = std::min(srcLosW, static_cast<int>((dx + 1) * losXRatio + 0.5f));
            bool inLos = false;
            for (int sy = losY0; !inLos && sy < std::max(losY0 + 1, losY1); ++sy) {
                for (int sx = losX0; !inLos && sx < std::max(losX0 + 1, losX1); ++sx) {
                    if (losMap[sy * srcLosW + sx] != 0)
                        inLos = true;
                }
            }

            bool inRadar = false;
            if (radarMap != nullptr) {
                const int rx0 = static_cast<int>(dx * radXRatio);
                const int rx1 = std::min(srcRadW, static_cast<int>((dx + 1) * radXRatio + 0.5f));
                for (int sy = radY0; !inRadar && sy < std::max(radY0 + 1, radY1); ++sy) {
                    for (int sx = rx0; !inRadar && sx < std::max(rx0 + 1, rx1); ++sx) {
                        if ((*radarMap)[sy * srcRadW + sx] != 0)
                            inRadar = true;
                    }
                }
            }
            // Air-LOS folds into the radar plane: air-spotted squares
            // count as "visible" for fog-of-war purposes even when the
            // ground LOS / radar mast both miss them.
            if (!inRadar && airMap != nullptr) {
                const int ax0 = static_cast<int>(dx * airXRatio);
                const int ax1 = std::min(srcAirW, static_cast<int>((dx + 1) * airXRatio + 0.5f));
                for (int sy = airY0; !inRadar && sy < std::max(airY0 + 1, airY1); ++sy) {
                    for (int sx = ax0; !inRadar && sx < std::max(ax0 + 1, ax1); ++sx) {
                        if ((*airMap)[sy * srcAirW + sx] != 0)
                            inRadar = true;
                    }
                }
            }

            const size_t idx = static_cast<size_t>(dy) * dstW + dx;
            if (inLos)   inLosPlane[idx] = 1;
            if (inRadar) inRadarPlane[idx] = 1;
            if (inLos)   exp[idx] = 1;
        }
    }

    // Pack envelope: 8-byte header + 3 packed planes.
    const size_t planeBytes = (static_cast<size_t>(dstW) * dstH + 7) / 8;
    std::vector<uint8_t> out;
    out.resize(8 + planeBytes * 3);

    out[0] = 0x07;                                  // ENVELOPE_LOS_BITMAP
    out[1] = static_cast<uint8_t>(allyTeam);
    out[2] = static_cast<uint8_t>(dstW);
    out[3] = static_cast<uint8_t>(dstH);
    // frame, little-endian u32
    out[4] = static_cast<uint8_t>( frameNo        & 0xff);
    out[5] = static_cast<uint8_t>((frameNo >>  8) & 0xff);
    out[6] = static_cast<uint8_t>((frameNo >> 16) & 0xff);
    out[7] = static_cast<uint8_t>((frameNo >> 24) & 0xff);

    size_t off = 8;
    off += PackBitPlane(out.data(), off, inLosPlane,   dstW, dstH);
    off += PackBitPlane(out.data(), off, inRadarPlane, dstW, dstH);
    off += PackBitPlane(out.data(), off, exp,          dstW, dstH);

    return out;
}
