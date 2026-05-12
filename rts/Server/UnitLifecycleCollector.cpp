// UnitLifecycleCollector — see header.

#include "UnitLifecycleCollector.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "System/EventHandler.h"

UnitLifecycleCollector* unitLifecycleEvents = nullptr;

UnitLifecycleCollector::UnitLifecycleCollector()
    : CEventClient("UnitLifecycleCollector", 0, /*synced=*/true)
{
}

void UnitLifecycleCollector::Register() {
    eventHandler.AddClient(this);
}

std::vector<UnitLifecycleEventData> UnitLifecycleCollector::Drain() {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<UnitLifecycleEventData> drained;
    drained.swap(events);
    return drained;
}

void UnitLifecycleCollector::UnitCreated(
    const CUnit* unit, const CUnit* builder)
{
    if (unit == nullptr) return;
    UnitLifecycleEventData e{};
    e.kind      = UnitLifecycleKind::Created;
    e.unitId    = static_cast<uint32_t>(unit->id);
    e.unitDefId = (unit->unitDef != nullptr)
        ? static_cast<uint16_t>(unit->unitDef->id) : 0;
    e.unitTeam  = static_cast<uint8_t>(unit->team);
    e.factoryId    = 0;
    e.factoryDefId = 0;
    e.userOrders   = false;
    e.oldTeam      = -1;
    e.newTeam      = -1;
    e.builderId    = (builder != nullptr)
        ? static_cast<uint32_t>(builder->id) : 0;

    std::lock_guard<std::mutex> lock(mutex);
    events.push_back(e);
}

void UnitLifecycleCollector::UnitFromFactory(
    const CUnit* unit, const CUnit* factory, bool userOrders)
{
    if (unit == nullptr || factory == nullptr) return;
    UnitLifecycleEventData e{};
    e.kind         = UnitLifecycleKind::FromFactory;
    e.unitId       = static_cast<uint32_t>(unit->id);
    e.unitDefId    = (unit->unitDef != nullptr)
        ? static_cast<uint16_t>(unit->unitDef->id) : 0;
    e.unitTeam     = static_cast<uint8_t>(unit->team);
    e.factoryId    = static_cast<uint32_t>(factory->id);
    e.factoryDefId = (factory->unitDef != nullptr)
        ? static_cast<uint16_t>(factory->unitDef->id) : 0;
    e.userOrders   = userOrders;
    e.oldTeam      = -1;
    e.newTeam      = -1;
    e.builderId    = 0;

    std::lock_guard<std::mutex> lock(mutex);
    events.push_back(e);
}

void UnitLifecycleCollector::UnitTaken(
    const CUnit* unit, int oldTeam, int newTeam)
{
    if (unit == nullptr) return;
    UnitLifecycleEventData e{};
    e.kind      = UnitLifecycleKind::Taken;
    e.unitId    = static_cast<uint32_t>(unit->id);
    e.unitDefId = (unit->unitDef != nullptr)
        ? static_cast<uint16_t>(unit->unitDef->id) : 0;
    e.unitTeam  = static_cast<uint8_t>(unit->team);
    e.factoryId    = 0;
    e.factoryDefId = 0;
    e.userOrders   = false;
    e.oldTeam   = static_cast<int8_t>(oldTeam);
    e.newTeam   = static_cast<int8_t>(newTeam);

    std::lock_guard<std::mutex> lock(mutex);
    events.push_back(e);
}

void UnitLifecycleCollector::UnitGiven(
    const CUnit* unit, int oldTeam, int newTeam)
{
    if (unit == nullptr) return;
    UnitLifecycleEventData e{};
    e.kind      = UnitLifecycleKind::Given;
    e.unitId    = static_cast<uint32_t>(unit->id);
    e.unitDefId = (unit->unitDef != nullptr)
        ? static_cast<uint16_t>(unit->unitDef->id) : 0;
    e.unitTeam  = static_cast<uint8_t>(unit->team);
    e.factoryId    = 0;
    e.factoryDefId = 0;
    e.userOrders   = false;
    e.oldTeam   = static_cast<int8_t>(oldTeam);
    e.newTeam   = static_cast<int8_t>(newTeam);

    std::lock_guard<std::mutex> lock(mutex);
    events.push_back(e);
}
