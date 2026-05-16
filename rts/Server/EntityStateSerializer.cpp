/**
 * EntityStateSerializer — Tier 2 binary entity state updates.
 */

#include "EntityStateSerializer.h"
#include "ClientSession.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Misc/QuadField.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/TeamHandler.h"
#include "System/float3.h"

#include <cstring>
#include <cmath>
#include <unordered_set>

namespace EntityState {

// Helper: write a value into buffer at offset, advance offset
template<typename T>
static void Write(std::vector<uint8_t>& buf, size_t& offset, T value) {
    memcpy(&buf[offset], &value, sizeof(T));
    offset += sizeof(T);
}

std::vector<uint8_t> SerializeAllUnits(uint16_t fieldMask) {
    const auto& activeUnits = unitHandler.GetActiveUnits();

    std::vector<CUnit*> units;
    units.reserve(activeUnits.size());
    for (CUnit* u : activeUnits) {
        if (u != nullptr && !u->isDead)
            units.push_back(u);
    }

    return SerializeUnits(units, fieldMask, /*viewerAllyTeam*/ -1);
}

float3 GetViewedPos(const CUnit* u, int viewerAllyTeam) {
    if (viewerAllyTeam < 0) return u->pos;
    const int unitAllyTeam = teamHandler.AllyTeam(u->team);
    if (unitAllyTeam == viewerAllyTeam) return u->pos;
    // GlobalLOS overrides the radar-error deception — debug verbs and
    // /globalLOS cheat are expected to surface the true position.
    if (losHandler != nullptr && losHandler->GetGlobalLOS(viewerAllyTeam))
        return u->pos;
    const uint8_t los = u->losStatus[viewerAllyTeam];
    // Only deceive when contact is radar-only. INLOS and PREVLOS
    // (ghost building) report the true position per Recoil semantics.
    if (los & LOS_INLOS) return u->pos;
    if ((los & LOS_PREVLOS) && u->unitDef != nullptr && u->unitDef->IsBuildingUnit()) return u->pos;
    if (!(los & LOS_INRADAR)) return u->pos;
    const float3 err = u->GetErrorVector(viewerAllyTeam);
    return float3(u->pos.x + err.x, u->pos.y, u->pos.z + err.z);
}


std::vector<uint8_t> SerializeUnits(
    const std::vector<CUnit*>& units,
    uint16_t fieldMask,
    int viewerAllyTeam)
{
    const uint16_t count = static_cast<uint16_t>(units.size());

    // Precompute per-unit "viewed" positions so X/Y/Z and the delta
    // cache see the same number. Radar-only enemy contacts get the
    // GetErrorVector deception; LOS / ghost / own-allyteam see the
    // truth. Y is preserved in either case (terrain height is public).
    std::vector<float3> viewedPos(count);
    for (uint16_t i = 0; i < count; ++i) {
        viewedPos[i] = GetViewedPos(units[i], viewerAllyTeam);
    }

    // Calculate buffer size
    size_t size = 4; // header
    if (fieldMask & FIELD_ENTITY_IDS)  size += count * sizeof(uint32_t);
    if (fieldMask & FIELD_POSITION_X)  size += count * sizeof(float);
    if (fieldMask & FIELD_POSITION_Y)  size += count * sizeof(float);
    if (fieldMask & FIELD_POSITION_Z)  size += count * sizeof(float);
    if (fieldMask & FIELD_HEADING)     size += count * sizeof(uint16_t);
    if (fieldMask & FIELD_HEALTH)      size += count * sizeof(uint16_t);
    if (fieldMask & FIELD_DEF_ID)      size += count * sizeof(uint16_t);
    if (fieldMask & FIELD_TEAM)        size += count * sizeof(uint8_t);
    if (fieldMask & FIELD_STATE_BITS)  size += count * sizeof(uint8_t);
    if (fieldMask & FIELD_LOS_STATE)   size += count * sizeof(uint8_t);
    if (fieldMask & FIELD_BUILD_PROGRESS) size += count * sizeof(uint8_t);
    if (fieldMask & FIELD_PITCH)       size += count * sizeof(int8_t);
    if (fieldMask & FIELD_ROLL)        size += count * sizeof(int8_t);

    std::vector<uint8_t> buf(size);
    size_t offset = 0;

    // Header
    Write(buf, offset, count);
    Write(buf, offset, fieldMask);

    // Entity IDs (u32)
    if (fieldMask & FIELD_ENTITY_IDS) {
        for (const CUnit* u : units)
            Write(buf, offset, static_cast<uint32_t>(u->id));
    }

    // Position X (f32) — uses viewedPos so radar-only enemy contacts
    // get GetErrorVector deception applied. See GetViewedPos above.
    if (fieldMask & FIELD_POSITION_X) {
        for (uint16_t i = 0; i < count; ++i)
            Write(buf, offset, viewedPos[i].x);
    }

    // Position Y (f32) — terrain height is public, viewedPos preserves it.
    if (fieldMask & FIELD_POSITION_Y) {
        for (uint16_t i = 0; i < count; ++i)
            Write(buf, offset, viewedPos[i].y);
    }

    // Position Z (f32) — see Position X.
    if (fieldMask & FIELD_POSITION_Z) {
        for (uint16_t i = 0; i < count; ++i)
            Write(buf, offset, viewedPos[i].z);
    }

    // Heading (u16, 0-65535 mapping to 0°-360°)
    if (fieldMask & FIELD_HEADING) {
        for (const CUnit* u : units) {
            // Spring heading is a short (-32768 to 32767), convert to unsigned
            Write(buf, offset, static_cast<uint16_t>(u->heading));
        }
    }

    // Health (u16, 0-65535 mapping to 0%-100%)
    if (fieldMask & FIELD_HEALTH) {
        for (const CUnit* u : units) {
            float ratio = (u->maxHealth > 0.0f) ? (u->health / u->maxHealth) : 0.0f;
            ratio = std::clamp(ratio, 0.0f, 1.0f);
            Write(buf, offset, static_cast<uint16_t>(ratio * 65535.0f));
        }
    }

    // Def ID (u16)
    if (fieldMask & FIELD_DEF_ID) {
        for (const CUnit* u : units)
            Write(buf, offset, static_cast<uint16_t>(u->unitDef->id));
    }

    // Team (u8)
    if (fieldMask & FIELD_TEAM) {
        for (const CUnit* u : units)
            Write(buf, offset, static_cast<uint8_t>(u->team));
    }

    // State bits (u8) — packed flags. Layout documented in the header.
    if (fieldMask & FIELD_STATE_BITS) {
        for (const CUnit* u : units) {
            // fireState/moveState are clamped to 0..3 to fit two bits
            // each; values outside that range come from custom Lua and
            // would silently overflow into adjacent bits otherwise.
            const uint8_t fire = std::clamp(u->fireState, 0, 3) & 0x03;
            const uint8_t move = std::clamp(u->moveState, 0, 3) & 0x03;
            const bool repeat  = u->commandAI != nullptr && u->commandAI->repeatOrders;
            uint8_t bits = 0;
            bits |= fire;
            bits |= (move << 2);
            if (repeat)            bits |= (1 << 4);
            if (u->IsCloaked())    bits |= (1 << 5);
            if (u->IsStunned())    bits |= (1 << 6);
            if (u->alwaysVisible)  bits |= (1 << 7);
            Write(buf, offset, bits);
        }
    }

    // LOS state (u8) — Spring's losStatus[viewerAllyTeam] low nibble.
    // Permissive sessions get 0x0F (looks fully visible to widgets).
    // Own-allyteam units always read as fully-in-LOS regardless of the
    // engine's tracking state, mirroring Spring's "you can always see
    // your own units" behaviour.
    if (fieldMask & FIELD_LOS_STATE) {
        const bool global = viewerAllyTeam >= 0
            && losHandler != nullptr
            && losHandler->GetGlobalLOS(viewerAllyTeam);
        for (const CUnit* u : units) {
            uint8_t losByte;
            if (viewerAllyTeam < 0) {
                losByte = 0x0F;
            } else if (global) {
                losByte = 0x0F;
            } else {
                const int unitAllyTeam = teamHandler.AllyTeam(u->team);
                if (unitAllyTeam == viewerAllyTeam) {
                    losByte = 0x0F;
                } else {
                    losByte = u->losStatus[viewerAllyTeam] & 0x0F;
                }
            }
            Write(buf, offset, losByte);
        }
    }

    // Build progress (u8, 0-255 mapping to 0%-100%). Finished units
    // pin to 255 so the client can treat the byte as "fully built"
    // without comparing against a magic float epsilon.
    if (fieldMask & FIELD_BUILD_PROGRESS) {
        for (const CUnit* u : units) {
            float bp = std::clamp(u->buildProgress, 0.0f, 1.0f);
            Write(buf, offset, static_cast<uint8_t>(bp * 255.0f));
        }
    }

    // Pitch (i8) — frontdir.y inverse-sined, normalized to [-π/2, π/2]
    // and quantized to 127 buckets. Clamping protects against precision
    // drift around ±1. Heading already encodes yaw, so pitch+roll fully
    // describe the orientation when combined with FIELD_HEADING.
    if (fieldMask & FIELD_PITCH) {
        constexpr float scale = 127.0f / 1.5707963267948966f; // 127 / (π/2)
        for (const CUnit* u : units) {
            const float fy = std::clamp(u->frontdir.y, -1.0f, 1.0f);
            const float p = std::asin(fy);
            int v = static_cast<int>(p * scale);
            if (v < -127) v = -127;
            if (v >  127) v =  127;
            Write(buf, offset, static_cast<int8_t>(v));
        }
    }

    // Roll (i8) — angle the unit's rightdir makes with world horizontal,
    // signed by which side dips. Same quantization as pitch.
    if (fieldMask & FIELD_ROLL) {
        constexpr float scale = 127.0f / 1.5707963267948966f;
        for (const CUnit* u : units) {
            const float ry = std::clamp(u->rightdir.y, -1.0f, 1.0f);
            const float r = std::asin(ry);
            int v = static_cast<int>(r * scale);
            if (v < -127) v = -127;
            if (v >  127) v =  127;
            Write(buf, offset, static_cast<int8_t>(v));
        }
    }

    return buf;
}

/// Per-ally-team visibility check. Own-allyteam units are always
/// visible; enemy units are visible if Spring's losStatus shows them
/// in LOS, in radar, or previously seen (PREVLOS — "ghost"). The
/// per-unit FIELD_LOS_STATE byte tells the client which kind of
/// contact each entry represents so widgets can render fog-of-war,
/// radar blips, and ghosts differently.
///
/// Cloaked enemies are dropped entirely unless they are `alwaysVisible`
/// — Recoil's contract is that cloak suppresses the LOS contact at the
/// engine level. We do the same on the wire so a hacked client cannot
/// reveal them by reading raw entity state.
///
/// `viewerAllyTeam < 0` disables the filter — the legacy permissive
/// path used by dev-smoketest sessions (no roster handoff) and
/// spectators who are expected to see the whole map.
bool IsUnitVisibleTo(const CUnit* u, int viewerAllyTeam) {
    if (viewerAllyTeam < 0) return true;
    const int unitAllyTeam = teamHandler.AllyTeam(u->team);
    if (unitAllyTeam == viewerAllyTeam) return true;
    if (u->IsCloaked() && !u->alwaysVisible) return false;
    // GlobalLOS (debug /globalLOS or `set_los on`) reveals every unit
    // to the viewer ally team, including those that have never been
    // touched by the per-team losStatus tracker.
    if (losHandler != nullptr && losHandler->GetGlobalLOS(viewerAllyTeam))
        return true;
    constexpr uint8_t VISIBLE_MASK = LOS_INLOS | LOS_INRADAR | LOS_PREVLOS | LOS_CONTRADAR;
    return (u->losStatus[viewerAllyTeam] & VISIBLE_MASK) != 0;
}

std::vector<CUnit*> CollectAllUnits(int viewerAllyTeam) {
    const auto& activeUnits = unitHandler.GetActiveUnits();
    std::vector<CUnit*> units;
    units.reserve(activeUnits.size());
    for (CUnit* u : activeUnits) {
        if (u == nullptr || u->isDead) continue;
        if (!IsUnitVisibleTo(u, viewerAllyTeam)) continue;
        units.push_back(u);
    }
    return units;
}

std::vector<CUnit*> CollectViewportUnits(
    const Viewport* viewports, int numViewports,
    int viewerAllyTeam)
{
    std::unordered_set<int> seen;
    std::vector<CUnit*> units;

    constexpr float MARGIN = 256.0f; // extra margin to prevent pop-in

    for (int v = 0; v < numViewports; v++) {
        const Viewport& vp = viewports[v];
        if (!vp.active || vp.width <= 0.0f || vp.height <= 0.0f)
            continue;

        float halfW = (vp.width  * 0.5f) + MARGIN;
        float halfH = (vp.height * 0.5f) + MARGIN;

        // TODO: apply rotation to the query rect (for now, axis-aligned)
        float3 mins(vp.centerX - halfW, -1e9f, vp.centerZ - halfH);
        float3 maxs(vp.centerX + halfW,  1e9f, vp.centerZ + halfH);

        QuadFieldQuery qfQuery;
        quadField.GetUnitsExact(qfQuery, mins, maxs);

        for (CUnit* u : *qfQuery.units) {
            if (u == nullptr || u->isDead) continue;
            if (!seen.insert(u->id).second) continue;
            if (!IsUnitVisibleTo(u, viewerAllyTeam)) continue;
            units.push_back(u);
        }
    }

    return units;
}

} // namespace EntityState
