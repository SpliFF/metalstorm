// IntelEventCollector — collects per-tick intel events the server needs
// to fan out to clients.
//
// Currently captures `UnitSeismicPing` from the engine event handler.
// Other transition callins (UnitEnteredLos / UnitLeftLos / UnitCloaked /
// etc.) are *not* batched here: the per-session snapshot already carries
// the per-unit `losStatus` byte, and the client synthesises the
// transition callins from snapshot diffs. Seismic pings are unique
// because they have no entity-state representation — they are positions,
// not unit attributes.
//
// Registered with the engine's CEventHandler at server boot. The sim
// loop drains the collector each tick and per-session filters route
// pings to clients whose ally team matches.
#pragma once

#include "System/EventClient.h"
#include "System/float3.h"

#include <cstdint>
#include <mutex>
#include <vector>

struct SeismicPingData {
    float3 pos;
    float strength;
    int16_t allyTeam;
};

class IntelEventCollector : public CEventClient {
public:
    IntelEventCollector();
    ~IntelEventCollector() override = default;

    /// Register with the engine's EventHandler so UnitSeismicPing fires
    /// into us. Must be called after eventHandler is constructed.
    void Register();

    /// Drain pings collected since the last call. Thread-safe.
    std::vector<SeismicPingData> DrainSeismicPings();

    /// CEventClient overrides ----------------------------------------
    bool GetFullRead() const override { return true; }
    int  GetReadAllyTeam() const override { return AllAccessTeam; }

    void UnitSeismicPing(const CUnit* unit, int allyTeam,
                         const float3& pos, float strength) override;

private:
    mutable std::mutex mutex;
    std::vector<SeismicPingData> seismicPings;
};

/// Global collector. Lifetime: constructed in server boot, destroyed
/// in shutdown. Use a pointer so we can register/destroy in a
/// controlled order alongside the rest of the server singletons.
extern IntelEventCollector* intelEvents;
