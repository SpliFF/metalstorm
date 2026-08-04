// UnitCommandCollector — see header.

#include "UnitCommandCollector.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/CommandAI/Command.h"
#include "System/EventHandler.h"

UnitCommandCollector* unitCommandEvents = nullptr;

UnitCommandCollector::UnitCommandCollector()
    : CEventClient("UnitCommandCollector", 0, /*synced=*/true)
{
}

void UnitCommandCollector::Register() {
    eventHandler.AddClient(this);
    // AddClient consults WantsEvent(), and CEventClient's default returns
    // false unless `autoLinkEvents` is set — which none of the server
    // collectors wire up. Without the explicit InsertEvent pair this client
    // is constructed, registered, and drained every tick while never being
    // added to listUnitCommand / listUnitCmdDone, so Drain() always returns
    // empty and UnitCommandBatch is never sent. That is exactly what it did
    // until PLAN-latency L4.1 measured the stream and found zero envelopes.
    // Same trap, same fix as FeatureLifecycleCollector::Register.
    eventHandler.InsertEvent(this, "UnitCommand");
    eventHandler.InsertEvent(this, "UnitCmdDone");
}

bool UnitCommandCollector::WantsEvent(const std::string& eventName) {
    return eventName == "UnitCommand" || eventName == "UnitCmdDone";
}

std::vector<UnitCommandEventData> UnitCommandCollector::Drain() {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<UnitCommandEventData> drained;
    drained.swap(events);
    return drained;
}

void UnitCommandCollector::UnitCommand(
    const CUnit* unit, const Command& command,
    int playerNum, bool fromSynced, bool fromLua)
{
    if (unit == nullptr) return;
    UnitCommandEventData e{};
    e.kind      = UnitCommandKind::Issued;
    e.unitId    = static_cast<uint32_t>(unit->id);
    e.unitDefId = (unit->unitDef != nullptr)
        ? static_cast<uint16_t>(unit->unitDef->id) : 0;
    e.unitTeam  = static_cast<uint8_t>(unit->team);
    e.cmdId     = command.GetID();
    const size_t nParams = command.GetNumParams();
    e.params.reserve(nParams);
    for (size_t i = 0; i < nParams; ++i) e.params.push_back(command.GetParam(i));
    e.options   = static_cast<uint8_t>(command.GetOpts());
    e.tag       = static_cast<uint32_t>(command.GetTag());
    e.playerId  = static_cast<int16_t>(playerNum);
    e.fromSynced = fromSynced;
    e.fromLua    = fromLua;

    std::lock_guard<std::mutex> lock(mutex);
    events.push_back(std::move(e));
}

void UnitCommandCollector::UnitCmdDone(
    const CUnit* unit, const Command& command)
{
    if (unit == nullptr) return;
    UnitCommandEventData e{};
    e.kind      = UnitCommandKind::Done;
    e.unitId    = static_cast<uint32_t>(unit->id);
    e.unitDefId = (unit->unitDef != nullptr)
        ? static_cast<uint16_t>(unit->unitDef->id) : 0;
    e.unitTeam  = static_cast<uint8_t>(unit->team);
    e.cmdId     = command.GetID();
    const size_t nParams = command.GetNumParams();
    e.params.reserve(nParams);
    for (size_t i = 0; i < nParams; ++i) e.params.push_back(command.GetParam(i));
    e.options   = static_cast<uint8_t>(command.GetOpts());
    e.tag       = static_cast<uint32_t>(command.GetTag());
    e.playerId  = -1;
    e.fromSynced = false;
    e.fromLua    = false;

    std::lock_guard<std::mutex> lock(mutex);
    events.push_back(std::move(e));
}
