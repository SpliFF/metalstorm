// StandingOrders — persistent condition-based orders evaluated server-side.
//
// A standing order assigns idle units matching certain criteria to
// perform a recurring task (defend area, patrol route, etc.). The
// server evaluates active standing orders every N ticks and issues
// concrete commands to eligible units via CCommandAI.
//
// Standing orders are stored per-team and exposed to Lua (LuaRules
// and NPC AI) for game-defined automation.
#pragma once

#include "System/float3.h"
#include <cstdint>
#include <string>
#include <vector>

/// Type of standing order.
enum class StandingOrderType : uint8_t {
    DefendArea,      // Idle units move to defend a circular area
    PatrolRoute,     // Idle units patrol a sequence of waypoints
    AttackMove,      // Idle units attack-move to a position
    Guard,           // Idle units guard a specific unit
};

/// Condition for which units are eligible for this order.
struct StandingOrderFilter {
    int team = -1;             // -1 = any team owned by issuing player
    std::string unitCategory;  // e.g. "TANK", "AIR", "" = any
    float maxDistance = 0.0f;  // 0 = no distance limit from order center
};

/// A single standing order.
struct StandingOrder {
    uint32_t id = 0;
    StandingOrderType type = StandingOrderType::DefendArea;
    StandingOrderFilter filter;
    int priority = 0;          // Higher = evaluated first

    // Order-specific data
    float3 position;           // Center point (DefendArea, AttackMove)
    float radius = 500.0f;     // Area radius (DefendArea)
    std::vector<float3> waypoints; // PatrolRoute waypoints
    uint32_t guardTargetId = 0;    // Guard target unit ID

    int maxAssigned = -1;      // -1 = unlimited
    int currentlyAssigned = 0;

    bool active = true;
};

/// Manages standing orders for all teams.
class StandingOrderManager {
public:
    /// Create a new standing order. Returns its ID.
    uint32_t AddOrder(int team, const StandingOrder& order);

    /// Remove a standing order by ID.
    void RemoveOrder(uint32_t orderId);

    /// Evaluate all active standing orders and assign idle units.
    /// Called every N sim ticks from the main loop.
    void Evaluate();

    /// Get all orders for a team.
    std::vector<StandingOrder*> GetTeamOrders(int team);

    /// Get a specific order by ID.
    StandingOrder* GetOrder(uint32_t orderId);

private:
    std::vector<StandingOrder> orders;
    uint32_t nextId = 1;
};

extern StandingOrderManager standingOrders;
