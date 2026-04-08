// StandingOrders — server-side standing order evaluation.

#include "StandingOrders.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/TeamHandler.h"

#include <algorithm>

StandingOrderManager standingOrders;

uint32_t StandingOrderManager::AddOrder(int team, const StandingOrder& order) {
    StandingOrder o = order;
    o.id = nextId++;
    o.filter.team = team;
    orders.push_back(std::move(o));
    return orders.back().id;
}

void StandingOrderManager::RemoveOrder(uint32_t orderId) {
    orders.erase(
        std::remove_if(orders.begin(), orders.end(),
            [orderId](const StandingOrder& o) { return o.id == orderId; }),
        orders.end());
}

std::vector<StandingOrder*> StandingOrderManager::GetTeamOrders(int team) {
    std::vector<StandingOrder*> result;
    for (auto& o : orders) {
        if (o.filter.team == team)
            result.push_back(&o);
    }
    return result;
}

StandingOrder* StandingOrderManager::GetOrder(uint32_t orderId) {
    for (auto& o : orders) {
        if (o.id == orderId)
            return &o;
    }
    return nullptr;
}

/// Check if a unit is idle (no commands queued).
static bool IsUnitIdle(const CUnit* unit) {
    if (unit == nullptr || unit->isDead)
        return false;
    return unit->commandAI->commandQue.empty();
}

void StandingOrderManager::Evaluate() {
    // Sort by priority (higher first)
    std::sort(orders.begin(), orders.end(),
        [](const StandingOrder& a, const StandingOrder& b) {
            return a.priority > b.priority;
        });

    for (auto& order : orders) {
        if (!order.active) continue;

        order.currentlyAssigned = 0;

        const auto& activeUnits = unitHandler.GetActiveUnits();
        for (CUnit* unit : activeUnits) {
            if (unit == nullptr || unit->isDead)
                continue;
            if (unit->team != order.filter.team)
                continue;
            if (!IsUnitIdle(unit))
                continue;

            // Check max assigned limit
            if (order.maxAssigned >= 0 && order.currentlyAssigned >= order.maxAssigned)
                break;

            // Check distance filter
            if (order.filter.maxDistance > 0.0f) {
                float dist = unit->pos.distance2D(order.position);
                if (dist > order.filter.maxDistance)
                    continue;
            }

            // Issue the appropriate command
            switch (order.type) {
                case StandingOrderType::DefendArea: {
                    // Move to a position within the defend radius
                    float3 target = order.position;
                    Command cmd(CMD_FIGHT, 0, target);
                    unit->commandAI->GiveCommand(cmd);
                    break;
                }
                case StandingOrderType::PatrolRoute: {
                    if (order.waypoints.empty()) break;
                    // Queue patrol through all waypoints
                    for (size_t i = 0; i < order.waypoints.size(); i++) {
                        unsigned char opts = (i > 0) ? SHIFT_KEY : 0;
                        Command cmd(CMD_PATROL, opts, order.waypoints[i]);
                        unit->commandAI->GiveCommand(cmd);
                    }
                    break;
                }
                case StandingOrderType::AttackMove: {
                    Command cmd(CMD_FIGHT, 0, order.position);
                    unit->commandAI->GiveCommand(cmd);
                    break;
                }
                case StandingOrderType::Guard: {
                    Command cmd(CMD_GUARD, 0);
                    cmd.PushParam(static_cast<float>(order.guardTargetId));
                    unit->commandAI->GiveCommand(cmd);
                    break;
                }
            }

            order.currentlyAssigned++;
        }
    }
}
