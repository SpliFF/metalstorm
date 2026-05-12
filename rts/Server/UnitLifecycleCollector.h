// UnitLifecycleCollector — captures lifecycle callins the client needs
// to dispatch into widgets but can't derive from the per-tick entity
// stream alone:
//
//   - UnitFromFactory  → fires when a factory completes a unit; carries
//                        the factory id + def + userOrders flag. Can't
//                        be derived client-side because we'd have to
//                        spatially correlate the new unit with a nearby
//                        factory.
//   - UnitTaken / UnitGiven → fire on team-transfer (LuaSyncedCtrl
//                        TransferUnit, AllowResourceTransfer, etc.).
//                        Can't be derived from the entity stream:
//                        snapshots only show the new team, not the
//                        transfer cause.
//
// Registered with the engine's CEventHandler at server boot. The sim
// loop drains the collector each tick and per-session filters route
// events to clients whose ally team is allowed to see them.
#pragma once

#include "System/EventClient.h"

#include <cstdint>
#include <mutex>
#include <vector>

enum class UnitLifecycleKind : uint8_t {
    FromFactory = 0,
    Taken       = 1,
    Given       = 2,
    Created     = 3,
};

struct UnitLifecycleEventData {
    UnitLifecycleKind kind;
    uint32_t unitId;
    uint16_t unitDefId;
    uint8_t  unitTeam;          // unit's current team at emit time
    // FromFactory-specific (zeroed for Taken/Given/Created)
    uint32_t factoryId;
    uint16_t factoryDefId;
    bool     userOrders;
    // Taken/Given-specific (-1 for FromFactory/Created)
    int8_t   oldTeam;
    int8_t   newTeam;
    // Created-specific: initiating builder id (0 = none, or non-Created kinds).
    uint32_t builderId;
};

class UnitLifecycleCollector : public CEventClient {
public:
    UnitLifecycleCollector();
    ~UnitLifecycleCollector() override = default;

    /// Register with the engine's EventHandler. Must be called after
    /// `eventHandler` is constructed.
    void Register();

    /// Drain events collected since the last call. Thread-safe.
    std::vector<UnitLifecycleEventData> Drain();

    /// CEventClient overrides ----------------------------------------
    bool GetFullRead() const override { return true; }
    int  GetReadAllyTeam() const override { return AllAccessTeam; }

    void UnitCreated(const CUnit* unit, const CUnit* builder) override;
    void UnitFromFactory(const CUnit* unit, const CUnit* factory, bool userOrders) override;
    void UnitTaken(const CUnit* unit, int oldTeam, int newTeam) override;
    void UnitGiven(const CUnit* unit, int oldTeam, int newTeam) override;

private:
    mutable std::mutex mutex;
    std::vector<UnitLifecycleEventData> events;
};

/// Global collector. Lifetime: constructed in server boot, destroyed
/// at shutdown. Pointer rather than value so registration order can be
/// controlled alongside the other server singletons.
extern UnitLifecycleCollector* unitLifecycleEvents;
