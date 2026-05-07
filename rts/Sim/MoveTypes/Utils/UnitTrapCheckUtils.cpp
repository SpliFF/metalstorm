/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// #undef NDEBUG

#include "UnitTrapCheckUtils.h"

#include "Sim/Ecs/Registry.h"
#include "Sim/Features/Feature.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/MoveTypes/Components/MoveTypesComponents.h"
#include "Sim/Units/Unit.h"

#include "System/Misc/TracyDefs.h"

using namespace MoveTypes;

void MoveTypes::RegisterFeatureForUnitTrapCheck(CFeature* object) {
    RECOIL_DETAILED_TRACY_ZONE;
    if (gs->frameNum < 0)
        return;

    // Headless server tolerates a missing ECS entity here — wreckage features
    // created during a unit's destructor sometimes lack a valid entity ref
    // because the registry teardown is in flight. Skipping the trap-check
    // registration is harmless (it's a steering-AI optimisation, not state).
    if (!Sim::registry.valid(object->entityReference))
        return;

    Sim::registry.emplace_or_replace<UnitTrapCheck>(object->entityReference
            , UnitTrapCheckType::TRAPPER_IS_FEATURE
            , object->id);
}

void MoveTypes::RegisterUnitForUnitTrapCheck(CUnit* object) {
    RECOIL_DETAILED_TRACY_ZONE;
    if (gs->frameNum < 0)
        return;

    if (!Sim::registry.valid(object->entityReference))
        return;

    Sim::registry.emplace_or_replace<UnitTrapCheck>(object->entityReference
            , UnitTrapCheckType::TRAPPER_IS_UNIT
            , object->id);
}
