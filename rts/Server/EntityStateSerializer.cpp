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

    return SerializeUnits(units, fieldMask);
}


std::vector<uint8_t> SerializeUnits(
    const std::vector<CUnit*>& units,
    uint16_t fieldMask)
{
    const uint16_t count = static_cast<uint16_t>(units.size());

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

    // Position X (f32)
    if (fieldMask & FIELD_POSITION_X) {
        for (const CUnit* u : units)
            Write(buf, offset, u->pos.x);
    }

    // Position Y (f32)
    if (fieldMask & FIELD_POSITION_Y) {
        for (const CUnit* u : units)
            Write(buf, offset, u->pos.y);
    }

    // Position Z (f32)
    if (fieldMask & FIELD_POSITION_Z) {
        for (const CUnit* u : units)
            Write(buf, offset, u->pos.z);
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
            // bit 7 reserved
            Write(buf, offset, bits);
        }
    }

    return buf;
}

/// Per-ally-team visibility check. Own-allyteam units are always
/// visible; enemy units require LOS from `viewerAllyTeam`. `viewerAllyTeam
/// < 0` disables the filter — the legacy permissive path used by
/// dev-smoketest sessions (no roster handoff) and spectators who are
/// expected to see the whole map.
static bool IsUnitVisibleTo(const CUnit* u, int viewerAllyTeam) {
    if (viewerAllyTeam < 0) return true;
    const int unitAllyTeam = teamHandler.AllyTeam(u->team);
    if (unitAllyTeam == viewerAllyTeam) return true;
    // LosHandler::InLos takes the *viewer* ally team. Units outside
    // any LOS tile are hidden from the wire entirely; this is fog
    // of war in its simplest form. Radar-only visibility (ghost
    // markers, reduced-fidelity updates) is a future pass — for
    // now, either the viewer can see you or you don't exist to
    // them.
    return losHandler->InLos(u, viewerAllyTeam);
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

std::vector<uint8_t> SerializeViewportUnits(
    const Viewport* viewports, int numViewports,
    uint16_t fieldMask)
{
    return SerializeUnits(
        CollectViewportUnits(viewports, numViewports, /*viewerAllyTeam*/ -1),
        fieldMask);
}

} // namespace EntityState
