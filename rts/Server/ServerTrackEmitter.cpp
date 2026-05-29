// ServerTrackEmitter — see header.
#include "ServerTrackEmitter.h"

#include "DecalEventCollector.h"
#include "Map/MapInfo.h"     // CMapInfo::TerrainType::receiveTracks
#include "Map/ReadMap.h"     // readMap, mapDims
#include "Sim/Misc/GlobalConstants.h"  // GAME_SPEED
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Units/UnitHandler.h"

#include <algorithm>
#include <cctype>
#include <cmath>

ServerTrackEmitter serverTrackEmitter;

namespace {
std::string ToLower(const std::string& in) {
    std::string s(in);
    for (char& c : s)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}
}

void ServerTrackEmitter::Init() {
    if (initialized)
        return;
    if (unitDefHandler == nullptr)
        return; // defs not parsed yet — retried on next Emit()

    const unsigned int n = unitDefHandler->NumUnitDefs();

    // Pass 1: collect the distinct lowercased track-type names among
    // track-leaving defs, then sort. The sort defines trackTypeId; the
    // client sorts the same set (lowercase ASCII byte order == JS default
    // string sort) and so agrees on every index with no wire exchange.
    trackNames.clear();
    for (unsigned int id = 1; id <= n; ++id) {
        const UnitDef* ud = unitDefHandler->GetUnitDefByID(static_cast<int>(id));
        if (ud == nullptr || !ud->decalDef.leaveTrackDecals)
            continue;
        const std::string nm = ToLower(ud->decalDef.trackDecalTypeName);
        if (nm.empty())
            continue;
        if (std::find(trackNames.begin(), trackNames.end(), nm) == trackNames.end())
            trackNames.push_back(nm);
    }
    std::sort(trackNames.begin(), trackNames.end());

    // Pass 2: per-defId trackTypeId cache for O(1) emission lookup.
    defTrackTypeId.assign(n + 1, 0xFFFF);
    for (unsigned int id = 1; id <= n; ++id) {
        const UnitDef* ud = unitDefHandler->GetUnitDefByID(static_cast<int>(id));
        if (ud == nullptr || !ud->decalDef.leaveTrackDecals)
            continue;
        const std::string nm = ToLower(ud->decalDef.trackDecalTypeName);
        const auto it = std::find(trackNames.begin(), trackNames.end(), nm);
        if (it != trackNames.end())
            defTrackTypeId[id] = static_cast<uint16_t>(it - trackNames.begin());
    }

    initialized = true;
}

void ServerTrackEmitter::Emit(int frameNum) {
    if (!initialized)
        Init();
    if (!initialized)
        return; // defs still not ready

    const auto& activeUnits = unitHandler.GetActiveUnits();
    for (CUnit* u : activeUnits) {
        if (u == nullptr || u->isDead)
            continue;
        const UnitDef* ud = u->unitDef;
        if (ud == nullptr || !ud->decalDef.leaveTrackDecals)
            continue;

        const int defId = ud->id;
        if (defId < 0 || defId >= static_cast<int>(defTrackTypeId.size()))
            continue;
        const uint16_t typeId = defTrackTypeId[defId];
        if (typeId == 0xFFFF)
            continue;

        const float width = ud->decalDef.trackDecalWidth;
        if (width <= 0.0f)
            continue;

        // Recoil lays a new segment once the unit has moved one track-width.
        const float step = std::max(width, 1.0f);
        const float step2 = step * step;

        const float3 cur = u->pos;
        const auto it = memo.find(u->id);
        if (it == memo.end()) {
            // First sighting: anchor, no segment yet.
            memo.emplace(u->id, TrackMemo{cur, frameNum});
            continue;
        }

        TrackMemo& m = it->second;
        const float dx = cur.x - m.pos.x;
        const float dz = cur.z - m.pos.z;
        const float d2 = dx * dx + dz * dz;
        if (d2 < step2) {
            // Alive but hasn't travelled far enough — keep the memo fresh so
            // it isn't pruned as a dead unit.
            m.lastFrame = frameNum;
            continue;
        }

        // Terrain-type gate: skip terrain whose map terrain-type doesn't
        // receive tracks (water / rock / metal). Authoritative + saves the
        // wire (we never ship a segment that wouldn't render). The typemap is
        // half-resolution: one entry per 2×2 map squares = 16 elmos.
        if (readMap != nullptr && mapInfo != nullptr) {
            const int tx = std::clamp(static_cast<int>(cur.x) / (2 * SQUARE_SIZE), 0, mapDims.hmapx - 1);
            const int tz = std::clamp(static_cast<int>(cur.z) / (2 * SQUARE_SIZE), 0, mapDims.hmapy - 1);
            const uint8_t tt = readMap->GetTypeMapSynced()[tz * mapDims.hmapx + tx];
            if (!mapInfo->terrainTypes[tt].receiveTracks) {
                // Re-anchor so re-entering track-receiving terrain doesn't lay
                // one giant bridging segment across the gap.
                m.pos = cur;
                m.lastFrame = frameNum;
                continue;
            }
        }

        const float inv = 1.0f / std::sqrt(d2);
        TrackSegmentEventData ev;
        ev.unitId = static_cast<uint32_t>(u->id);
        ev.pos = cur; // client snaps y to its heightmap on receipt
        ev.dirX = dx * inv;
        ev.dirZ = dz * inv;
        ev.width = width;
        ev.strength = ud->decalDef.trackDecalStrength;
        ev.trackTypeId = typeId;
        ev.team = static_cast<uint8_t>(u->team);
        trackSegmentEvents.Push(ev);

        m.pos = cur;
        m.lastFrame = frameNum;
    }

    // Prune memo entries for units that died or stopped appearing, every
    // ~10s, so the map stays bounded over a long game. Alive movers refresh
    // lastFrame every tick (both branches above), so only stale ids expire.
    if (frameNum - lastPruneFrame > 10 * GAME_SPEED) {
        lastPruneFrame = frameNum;
        for (auto it = memo.begin(); it != memo.end();) {
            if (frameNum - it->second.lastFrame > 10 * GAME_SPEED)
                it = memo.erase(it);
            else
                ++it;
        }
    }
}
