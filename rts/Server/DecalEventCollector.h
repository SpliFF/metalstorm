// DecalEventCollector — collects ground-decal events each sim frame.
//
// Two event kinds feed the client decal renderer:
//   * Scars   — scorch marks from weapon explosions. Emitted by the
//               ServerDecalHandler (an IExplosionListener) which mirrors
//               Recoil's CGroundDecalHandler::ExplosionOccurred path.
//   * Tracks  — vehicle tread segments. Emitted per tick from the unit
//               movement tracker for units whose UnitDef leaves tracks.
//
// The sim loop drains both queues each tick, filters by per-session LOS,
// and broadcasts them as a custom-binary envelope (0x08). No delta
// compression — decals are write-once events, never updated.
#pragma once

#include "System/float3.h"
#include <cstdint>
#include <mutex>
#include <vector>

// A scorch scar spawned by an explosion. Geometry + lifetime + tint are
// resolved server-side from the WeaponDef (faithful to Recoil's derivation);
// the client picks a random scar texture from the loaded atlas at spawn.
struct ScarEventData {
    float3 pos;        // world position, y snapped to ground height
    float  radius;     // scar half-extent in elmos
    float  ttl;        // lifetime in seconds
    float  alpha;      // initial opacity 0..1
    float  glow;       // additive glow intensity 0..1
    float  glowTtl;    // glow lifetime in seconds
    float  r, g, b, a; // colour tint 0..1
};

class ScarEventCollector {
public:
    void Push(const ScarEventData& event) {
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back(event);
    }

    std::vector<ScarEventData> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<ScarEventData> drained;
        drained.swap(events);
        return drained;
    }

    size_t Size() const {
        std::lock_guard<std::mutex> lock(mutex);
        return events.size();
    }

private:
    mutable std::mutex mutex;
    std::vector<ScarEventData> events;
};

extern ScarEventCollector scarEvents;

// One tread-track segment laid down by a moving unit. The client connects
// consecutive segments along the unit's travel vector. `trackTypeId` indexes
// the loaded track-texture atlas (resolved from UnitDef trackDecalTypeName at
// game start).
struct TrackSegmentEventData {
    uint32_t unitId;
    float3   pos;          // current tracked position (segment end)
    float    dirX, dirZ;   // travel direction, normalised in the XZ plane
    float    width;        // track width in elmos
    float    strength;     // fade-time multiplier
    uint16_t trackTypeId;  // index into the client track atlas
    uint8_t  team;
};

class TrackSegmentEventCollector {
public:
    void Push(const TrackSegmentEventData& event) {
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back(event);
    }

    std::vector<TrackSegmentEventData> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<TrackSegmentEventData> drained;
        drained.swap(events);
        return drained;
    }

    size_t Size() const {
        std::lock_guard<std::mutex> lock(mutex);
        return events.size();
    }

private:
    mutable std::mutex mutex;
    std::vector<TrackSegmentEventData> events;
};

extern TrackSegmentEventCollector trackSegmentEvents;
