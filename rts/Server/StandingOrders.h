// StandingOrders — server-side standing order manager.
//
// A standing order is a persistent, condition-based directive that
// applies to *any* squad matching its conditions, not to specific
// units. The evaluator runs every ~1 s of sim time and assigns matching
// idle squads to issue concrete CCommandAI commands (CMD_FIGHT,
// CMD_PATROL, etc.). Player-issued direct commands always take
// precedence — a directly commanded squad leaves the standing-order
// candidate pool until it becomes idle again.
//
// See PLAN-orders.md "Standing Orders" section for the full design.
// Wire format matches schemas/protocol.fbs StandingOrder{Create,Update,
// Remove,Info,State} tables.
#pragma once

#include "System/float3.h"
#include <cstdint>
#include <functional>
#include <string>
#include <unordered_set>
#include <vector>

/// Type tag for a standing order. Matches SpringWeb::StandingOrderType
/// from the FlatBuffers schema 1:1 so the values can be cast between
/// the two without translation tables.
enum class StandingOrderType : uint8_t {
    DefendArea = 0,
    PatrolRoute = 1,
    RallyPoint = 2,
    Fallback = 3,
    Reinforce = 4,
    Screen = 5,
    SupplyRoute = 6,
    BuildBase = 7,
};

/// Squad-match conditions. A squad qualifies if every populated field
/// passes. Spatial filters with `*_radius <= 0` are wildcards and do
/// not gate assignment.
struct StandingOrderConditions {
    bool  idleOnly = true;
    std::vector<uint16_t> squadTypes;          /// allowed unit def IDs (empty = any)
    float3 withinCenter;
    float withinRadius = 0.0f;                 /// 0 = wildcard
    float3 outsideCenter;
    float outsideRadius = 0.0f;                /// 0 = wildcard
    float minStrength = 0.0f;                  /// HP × count threshold
    std::vector<std::string> hasCapabilities;  /// game-specific tags
    /// Org-group scope (macro-orders §4.2 — the A+C fusion). When non-zero,
    /// only squads that are members of this org group qualify. 0 = any squad
    /// (classic condition/area scope). See OrgGroups.h / OrgGroupManager.
    uint32_t orgGroup = 0;
};

/// A single standing order. Owned by `team`; visible to its allies via
/// StandingOrderState broadcasts.
struct StandingOrder {
    uint32_t id = 0;
    int      team = -1;
    StandingOrderType type = StandingOrderType::DefendArea;
    uint8_t  priority = 0;
    /// Type-specific params. Schema:
    ///   DefendArea  → [x, y, z, radius]
    ///   PatrolRoute → [x1, y1, z1, x2, y2, z2, ...]
    ///   RallyPoint  → [x, y, z]
    ///   Fallback    → [x, y, z]
    ///   Reinforce   → [x, y, z, threshold]
    ///   Screen      → [x1, y1, z1, x2, y2, z2]
    ///   SupplyRoute → [x1, y1, z1, x2, y2, z2]
    ///   BuildBase   → [x, y, z, buildDefId, ...]
    std::vector<float> params;
    StandingOrderConditions conditions;
    bool active = true;
    uint32_t createdAtFrame = 0;
    uint32_t expiresAtFrame = 0;   /// 0 = no expiry
    /// Squads currently assigned to this order. Mutated by Evaluate()
    /// as squads become idle / receive direct commands.
    std::unordered_set<uint32_t> assigned;
};

/// Notification callback fired when standing-order state changes in a
/// way the client cares about. The server hooks this to push a
/// StandingOrderState snapshot. Triggered on Create / Update / Remove
/// and when an order's assigned_squad_count changes by an integer.
using StandingOrderChangeNotifier = std::function<void(int team)>;

/// Manages standing orders for all teams.
class StandingOrderManager {
public:
    /// Hook the broadcast callback. Called whenever an order is created,
    /// updated, removed, or its assigned_squad_count moves.
    void SetChangeNotifier(StandingOrderChangeNotifier cb) { changeNotifier = std::move(cb); }

    /// Create a new standing order owned by `team`. Returns the new
    /// order ID. `currentFrame` is stamped into createdAtFrame and used
    /// to compute expiresAtFrame from `expiresInFrames` (0 = no expiry).
    uint32_t Create(int team, StandingOrderType type, uint8_t priority,
                    std::vector<float> params, StandingOrderConditions cond,
                    uint32_t expiresInFrames, uint32_t currentFrame);

    /// Update an existing order. Returns false if the order doesn't
    /// exist or `team` doesn't match the order's owner (cross-team
    /// edit attempt).
    bool Update(uint32_t orderId, int team, uint8_t priority,
                std::vector<float> params, StandingOrderConditions cond, bool active);

    /// Remove an order. Releases all assigned squads. Returns false on
    /// id mismatch or cross-team attempt.
    bool Remove(uint32_t orderId, int team);

    /// Evaluator pass. Called periodically (typically every 30 sim
    /// frames = ~1 s). Iterates active orders by priority, assigns
    /// matching idle squads, and issues concrete commands.
    /// `currentFrame` lets the evaluator expire orders past
    /// expiresAtFrame and stamp re-issued commands.
    void Evaluate(uint32_t currentFrame);

    /// All orders owned by `team`, in stable priority-then-id order.
    std::vector<const StandingOrder*> GetTeamOrders(int team) const;

    /// All currently active orders (for broadcast filtering).
    const std::vector<StandingOrder>& GetAllOrders() const { return orders; }

    /// Wipe everything. Called on game reset.
    void Clear();

private:
    std::vector<StandingOrder> orders;
    uint32_t nextId = 1;
    StandingOrderChangeNotifier changeNotifier;

    void NotifyChange(int team) {
        if (changeNotifier) changeNotifier(team);
    }
};

extern StandingOrderManager standingOrders;
