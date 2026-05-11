// IntelEventCollector — collects per-tick intel events the server needs
// to fan out to clients.
//
// Captures `UnitSeismicPing` from the engine event handler (pings are
// positions, not unit attributes — they have no entity-state
// representation). Other transition callins (UnitEnteredLos / UnitLeftLos
// / UnitCloaked / etc.) are *not* batched here: the per-session snapshot
// already carries the per-unit `losStatus` byte, and the client
// synthesises transition callins from snapshot diffs.
//
// Also owns the per-allyteam "explored" tracker used by the LOS bitmap
// stream (envelope 0x07). Once any LOS square enters LOS for an
// allyteam, the corresponding explored bit stays set for the rest of
// the game.
//
// Registered with the engine's CEventHandler at server boot. The sim
// loop drains the collector each tick and per-session filters route
// pings to clients whose ally team matches.
#pragma once

#include "System/EventClient.h"
#include "System/float3.h"

#include <array>
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

    /// Build a fog-of-war bitmap snapshot envelope for `allyTeam`.
    /// Returns the full byte buffer (8-byte header + 3 bit-packed
    /// planes: in-LOS / in-radar / explored) ready for SendReliable.
    /// Returns an empty vector if `losHandler` is null or the ally team
    /// is invalid. Resolution is capped at 64×64; smaller maps use
    /// their native LOS-map resolution. Updates the per-allyteam
    /// `exploredMaps` cache as a side effect (sticky-OR'd against the
    /// current in-LOS plane).
    std::vector<uint8_t> BuildLosBitmap(int allyTeam, uint32_t frameNo);

    /// CEventClient overrides ----------------------------------------
    bool GetFullRead() const override { return true; }
    int  GetReadAllyTeam() const override { return AllAccessTeam; }

    void UnitSeismicPing(const CUnit* unit, int allyTeam,
                         const float3& pos, float strength) override;

private:
    mutable std::mutex mutex;
    std::vector<SeismicPingData> seismicPings;

    /// Per-allyteam "ever in LOS" sticky bits. One byte per downsampled
    /// LOS-map square (we waste 7 bits per square for cache simplicity;
    /// the wire payload bit-packs them). Lazily resized to (w × h) on
    /// first emit for each ally team. Index by allyTeam (capped at
    /// MAX_TEAMS).
    std::array<std::vector<uint8_t>, 256> exploredMaps;
    /// Last bitmap dimensions used per ally team. Reset to (0,0) if
    /// dimensions change (e.g. losMipLevel changed mid-game) so the
    /// explored map is rebuilt.
    std::array<std::pair<int, int>, 256> exploredDims{};
};

/// Global collector. Lifetime: constructed in server boot, destroyed
/// in shutdown. Use a pointer so we can register/destroy in a
/// controlled order alongside the rest of the server singletons.
extern IntelEventCollector* intelEvents;
