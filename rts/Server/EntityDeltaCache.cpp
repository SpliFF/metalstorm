/**
 * EntityDeltaCache — per-client delta change detection.
 */

#include "EntityDeltaCache.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "System/float3.h"

#include <algorithm>
#include <cmath>
#include <unordered_set>

static uint16_t UnitHealthU16(const CUnit* u) {
    float ratio = (u->maxHealth > 0.0f) ? (u->health / u->maxHealth) : 0.0f;
    ratio = std::clamp(ratio, 0.0f, 1.0f);
    return static_cast<uint16_t>(ratio * 65535.0f);
}

static uint8_t UnitBuildProgressU8(const CUnit* u) {
    float bp = std::clamp(u->buildProgress, 0.0f, 1.0f);
    return static_cast<uint8_t>(bp * 255.0f);
}

bool EntityDeltaCache::HasChanged(const CUnit* unit, int viewerAllyTeam) const {
    auto it = cache.find(static_cast<uint32_t>(unit->id));
    if (it == cache.end())
        return true; // New entity, always send

    const auto& c = it->second;

    // Position
    float dx = unit->pos.x - c.posX;
    float dy = unit->pos.y - c.posY;
    float dz = unit->pos.z - c.posZ;
    if (dx * dx + dy * dy + dz * dz > POS_THRESHOLD * POS_THRESHOLD)
        return true;

    // Heading
    if (static_cast<uint16_t>(unit->heading) != c.heading)
        return true;

    // Health
    if (UnitHealthU16(unit) != c.health)
        return true;

    // Build progress (drives nanoframe shader; tick rate is ~1% per
    // build-power second, so the delta path fires once per visible
    // change rather than every frame).
    if (UnitBuildProgressU8(unit) != c.buildProgress)
        return true;

    // LOS-state transition (radar↔los or first-sighting). Without this
    // the client could be stuck rendering a unit as a radar contact
    // long after the player has gained LOS on it.
    if (viewerAllyTeam >= 0) {
        const uint8_t losState = unit->losStatus[viewerAllyTeam] & 0x0F;
        if (losState != c.losState)
            return true;
    }

    return false;
}

void EntityDeltaCache::Update(const CUnit* unit, int viewerAllyTeam) {
    auto& c = cache[static_cast<uint32_t>(unit->id)];
    c.posX = unit->pos.x;
    c.posY = unit->pos.y;
    c.posZ = unit->pos.z;
    c.heading = static_cast<uint16_t>(unit->heading);
    c.health = UnitHealthU16(unit);
    c.buildProgress = UnitBuildProgressU8(unit);
    c.defId = static_cast<uint16_t>(unit->unitDef->id);
    c.team = static_cast<uint8_t>(unit->team);
    c.losState = (viewerAllyTeam >= 0)
        ? (unit->losStatus[viewerAllyTeam] & 0x0F)
        : 0x0F; // permissive sessions get "fully seen"
}

void EntityDeltaCache::FindRemoved(
    const std::vector<CUnit*>& liveUnits,
    std::vector<uint32_t>& removed)
{
    // Build set of live IDs
    std::unordered_set<uint32_t> liveIds;
    liveIds.reserve(liveUnits.size());
    for (const CUnit* u : liveUnits) {
        if (u != nullptr)
            liveIds.insert(static_cast<uint32_t>(u->id));
    }

    // Find cached entries not in live set
    for (auto it = cache.begin(); it != cache.end(); ) {
        if (liveIds.find(it->first) == liveIds.end()) {
            removed.push_back(it->first);
            it = cache.erase(it);
        } else {
            ++it;
        }
    }
}
