/**
 * EntityStateSerializer — Tier 2 binary entity state updates.
 */

#include "EntityStateSerializer.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitDef.h"
#include "System/float3.h"

#include <cstring>
#include <cmath>

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

    return buf;
}

} // namespace EntityState
