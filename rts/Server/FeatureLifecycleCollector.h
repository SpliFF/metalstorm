// FeatureLifecycleCollector — captures `FeatureCreated` / `FeatureDestroyed`
// callins so server_main.cpp can stream wreck (and other runtime-spawned
// feature) lifecycle to clients.
//
// Map-placed features arrive at the client via `MapData.features`; this
// collector covers everything that spawns or despawns after game start:
//   - Unit deaths spawning a corpse via `CFeatureHandler::CreateWreckage`
//   - Wreck → heap → ash chained deathFeature transitions
//   - Lua `Spring.CreateFeature` / `Spring.DestroyFeature`
//   - Debris dropped by explosions / piece projectiles
//
// Registered with the engine's CEventHandler at server boot. The sim
// loop drains the collector each tick and broadcasts a
// `FeatureLifecycleBatch` envelope to every session.
#pragma once

#include "System/EventClient.h"

#include <cstdint>
#include <mutex>
#include <vector>

struct FeatureSpawnEventData {
    uint32_t featureId;
    uint32_t defId;
    float    x, y, z;
    int16_t  heading;
    uint8_t  buildFacing;
    int8_t   team;
    int8_t   allyTeam;
};

struct FeatureRemovedEventData {
    uint32_t featureId;
};

class FeatureLifecycleCollector : public CEventClient {
public:
    FeatureLifecycleCollector();
    ~FeatureLifecycleCollector() override = default;

    /// Register with the engine's EventHandler so FeatureCreated /
    /// FeatureDestroyed dispatch into this collector. Subscribes via
    /// `eventHandler.InsertEvent` directly — `WantsEvent` autobinding
    /// requires `RegisterLinkedEvents<T>(this)` plumbing the existing
    /// server collectors skip.
    void Register();

    /// Drain events collected since the last call. Thread-safe.
    void Drain(std::vector<FeatureSpawnEventData>& outSpawns,
               std::vector<FeatureRemovedEventData>& outRemoved);

    /// CEventClient overrides ----------------------------------------
    bool GetFullRead() const override { return true; }
    int  GetReadAllyTeam() const override { return AllAccessTeam; }
    bool WantsEvent(const std::string& eventName) override;

    void FeatureCreated(const CFeature* feature) override;
    void FeatureDestroyed(const CFeature* feature) override;

private:
    mutable std::mutex mutex;
    std::vector<FeatureSpawnEventData> spawns;
    std::vector<FeatureRemovedEventData> removed;
};

extern FeatureLifecycleCollector* featureLifecycleEvents;
