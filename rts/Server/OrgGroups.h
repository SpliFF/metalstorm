// OrgGroups — server-side org-group registry (Model A) + macro-directive
// manager for Metalstorm's large-scale command & control.
//
// Design: PLAN-macro-orders.md (hierarchy, order types, posture — ratified
// Q-D-d 2026-07-11: A+C hybrid, v0 = squad + platoon/group only, army tier
// reserved-not-surfaced) and PLAN-macro-directives.md (wire + Lua API).
//
// Two managers live here because they are tightly coupled — a group-scoped
// directive draws its candidate squads from an org group's roster:
//
//   * OrgGroupManager — lightweight server-side org entities (Model A). A
//     group is a roster + metadata, NOT a unit entity: it has its own u32
//     id counter and its own table (Q-D-d §5.4), never appears in the
//     entity stream. v0 only ever writes echelon = Platoon / parentId = 0;
//     an army-echelon or non-zero-parent create is rejected (fail loud).
//
//   * DirectiveManager — macro orders (GroupDirective). An evolution of the
//     landed StandingOrderManager: a directive is scoped either to an org
//     group (draws from its roster) or to conditions/area (draws only from
//     UNassigned squads — rostered squads obey only their own chain,
//     Q-D-d §2). Carries the demand model (requested/assigned strength).
//
// Wire format matches schemas/protocol.fbs OrgGroup{Create,Update,Disband},
// GroupDirective, GroupPosture, OrgGroup{Info,State}, Directive{Info,State}.
#pragma once

#include "StandingOrders.h"          // StandingOrderConditions
#include <cstdint>
#include <functional>
#include <string>
#include <unordered_set>
#include <vector>

// Mirrors SpringWeb::Echelon from the FlatBuffers schema 1:1.
enum class Echelon : uint8_t {
    Squad = 0,
    Platoon = 1,   // "group" — the only tier v0 surfaces
    Army = 2,      // reserved (post-v0); create is rejected in v0
};

// Mirrors SpringWeb::DirectiveType 1:1. Values 0..7 alias StandingOrderType
// so a group-scoped classic order maps with no translation; 8+ are the new
// platoon-level macro directives (PLAN-macro-orders §2).
enum class DirectiveType : uint8_t {
    DefendArea = 0,
    PatrolRoute = 1,
    RallyPoint = 2,
    Fallback = 3,
    Reinforce = 4,
    Screen = 5,
    SupplyRoute = 6,
    BuildBase = 7,
    MoveFormation = 8,
    Assault = 9,
    Defend = 10,
    Overwatch = 11,
    Withdraw = 12,
    Escort = 13,
    DefendFront = 14,
};

// Mirrors SpringWeb::OrderShape 1:1.
enum class OrderShape : uint8_t {
    Point = 0,
    Circle = 1,
    Polygon = 2,
    Polyline = 3,
};

// ----------------------------------------------------------------
// Org groups (Model A)
// ----------------------------------------------------------------

/// A server-side org group. Owned by `team` (a team object with player
/// attribution, not player ownership — macro-orders 2026-06-13 update);
/// visible to allies via OrgGroupState broadcasts.
struct OrgGroup {
    uint32_t id = 0;
    Echelon  echelon = Echelon::Platoon;
    int      team = -1;
    uint32_t parentId = 0;              /// reserved: 0 in v0 (no army parent)
    std::vector<uint32_t> members;      /// squad entity IDs, unique + ordered
    std::string name;                   /// player-visible ("3rd Armoured")
    uint32_t currentDirectiveId = 0;    /// active macro order, 0 = none
    std::string postureJson;            /// engagement/casualty/reinforce/ROE
    uint32_t createdAtFrame = 0;
};

/// Fires when org-group state changes in a way the client cares about
/// (create / roster edit / disband / posture / current-directive change).
/// The server hooks this to push an OrgGroupState snapshot.
using OrgGroupChangeNotifier = std::function<void(int team)>;

class OrgGroupManager {
public:
    void SetChangeNotifier(OrgGroupChangeNotifier cb) { changeNotifier = std::move(cb); }

    /// Create a group owned by `team`. Returns the new group id, or 0 on
    /// rejection: v0 rejects `echelon == Army` and any non-zero `parentId`
    /// (the reserved army tier is not surfaced — fail loud so callers can't
    /// depend on it before it ships). Seed members are pulled from any prior
    /// group first (a squad belongs to at most one platoon).
    uint32_t Create(int team, Echelon echelon, std::string name,
                    const std::vector<uint32_t>& members, uint32_t parentId,
                    uint32_t currentFrame);

    /// Roster / name edit. `addIds` are pulled from any prior group first.
    /// Empty `name` leaves the name unchanged. Cross-team edits return false.
    bool Update(uint32_t groupId, int team,
                const std::vector<uint32_t>& addIds,
                const std::vector<uint32_t>& removeIds,
                const std::string& name);

    /// Disband a group; members become unassigned. Cross-team returns false.
    /// Does not remove the group's directives — the caller wires that so the
    /// DirectiveManager dependency stays one-directional.
    bool Disband(uint32_t groupId, int team);

    /// Store the posture bundle for a group. Cross-team returns false.
    bool SetPosture(uint32_t groupId, int team, std::string postureJson);

    /// Record which directive a group is currently executing (0 = none).
    /// Called by the DirectiveManager; notifies on integer change.
    void SetCurrentDirective(uint32_t groupId, uint32_t directiveId);

    /// True if `unitId` is a member of `groupId`.
    bool IsMember(uint32_t groupId, uint32_t unitId) const;

    /// The group holding `unitId`, or 0 if the unit is unassigned.
    uint32_t GroupOfUnit(uint32_t unitId) const;

    /// A group's current roster, or empty if the group doesn't exist.
    const std::vector<uint32_t>& MembersOf(uint32_t groupId) const;

    /// Drop a dead / removed unit from whatever group holds it. No-op if the
    /// unit is unassigned. Notifies the affected team.
    void OnUnitRemoved(uint32_t unitId);

    /// Prune members that are dead / no longer present from every roster.
    /// Called on the evaluator cadence so a group whose squads all die
    /// lingers *empty* (group-death lingering, macro-orders §1) — ready for
    /// reinforcement refill — rather than streaming stale ids.
    void PruneDeadMembers();

    OrgGroup* Get(uint32_t groupId);
    const OrgGroup* Get(uint32_t groupId) const;

    /// All groups owned by `team`, id-ordered.
    std::vector<const OrgGroup*> GetTeamGroups(int team) const;
    const std::vector<OrgGroup>& GetAllGroups() const { return groups; }

    void Clear();

    // ── Snapshot restore (PLAN-persistence task 1b) ──
    // See StandingOrderManager::RestoreState for why the id counter travels
    // with the state rather than being recomputed from max(id)+1: a group
    // disbanded before the snapshot leaves a gap, and recomputing would be
    // right only until the highest-id group is the one that gets disbanded.
    uint32_t NextId() const { return nextId; }
    void RestoreState(std::vector<OrgGroup> newGroups, uint32_t newNextId);

private:
    std::vector<OrgGroup> groups;
    uint32_t nextId = 1;
    OrgGroupChangeNotifier changeNotifier;
    static const std::vector<uint32_t> kEmptyRoster;

    /// Remove `unitId` from every group except `exceptGroupId`. Returns the
    /// team whose group lost the member, or -1. Enforces the one-platoon rule.
    int PullFromOtherGroups(uint32_t unitId, uint32_t exceptGroupId);
    void NotifyChange(int team) { if (changeNotifier) changeNotifier(team); }
};

extern OrgGroupManager orgGroups;

// ----------------------------------------------------------------
// Macro directives (GroupDirective)
// ----------------------------------------------------------------

/// A macro directive. When `groupId != 0` it is scoped to that org group's
/// roster; when `groupId == 0` it is condition-scoped (a classic area
/// directive) and draws only from squads that belong to no group.
struct Directive {
    uint32_t id = 0;
    int      team = -1;
    uint32_t groupId = 0;
    /// The playerNum that created (and was charged for) this directive, or -1
    /// for an unattributed create (gadget-internal / no clientPlayerNum entry).
    /// Handed to GiveCommand at decomposition so game Lua's AllowCommand hook
    /// can stamp `last_commander` on each unit the directive actually moves —
    /// PLAN-metalstorm-objectives.md §5.1 (endtoend D24). A condition-scoped
    /// directive has no roster at create time, so this is the only point at
    /// which its author can be attached to a unit.
    int      authorPlayerId = -1;
    DirectiveType type = DirectiveType::Defend;
    uint8_t  priority = 0;
    OrderShape shape = OrderShape::Point;
    /// Shape geometry (interpreted per `shape`; see OrgGroups.cpp), plus any
    /// trailing type params (e.g. Escort guard-target id).
    std::vector<float> params;
    StandingOrderConditions conditions;   /// conditions.orgGroup mirrors groupId
    uint32_t requestedStrength = 0;        /// demand model; 0 = take what idles
    std::string phasesJson;                /// reserved v0 (macro-orders §4.4)
    bool active = true;
    uint32_t createdAtFrame = 0;
    uint32_t expiresAtFrame = 0;           /// 0 = no expiry
    std::unordered_set<uint32_t> assigned;
    /// Recomputed each Evaluate() from live member health — the fulfillment
    /// numerator streamed in DirectiveInfo.assigned_strength.
    float assignedStrength = 0.0f;
};

using DirectiveChangeNotifier = std::function<void(int team)>;

class DirectiveManager {
public:
    void SetChangeNotifier(DirectiveChangeNotifier cb) { changeNotifier = std::move(cb); }

    /// Create a directive. `conditions.orgGroup` is forced to `groupId`.
    /// Returns the new directive id. If a group is named, it is marked as
    /// currently executing this directive.
    /// `authorPlayerId` is the charged player (see Directive::authorPlayerId);
    /// -1 leaves the directive unattributed.
    uint32_t Create(int team, DirectiveType type, uint8_t priority, OrderShape shape,
                    std::vector<float> params, StandingOrderConditions cond,
                    uint32_t groupId, uint32_t requestedStrength,
                    std::string phasesJson, uint32_t expiresInFrames,
                    uint32_t currentFrame, int authorPlayerId = -1);

    /// Update an existing directive wholesale. Cross-team returns false.
    /// The scoping group is immutable (recreate to re-scope).
    bool Update(uint32_t id, int team, DirectiveType type, uint8_t priority,
                OrderShape shape, std::vector<float> params,
                StandingOrderConditions cond, uint32_t requestedStrength,
                std::string phasesJson, bool active);

    /// Remove a directive; releases assigned squads. Cross-team returns false.
    bool Remove(uint32_t id, int team);

    /// Remove all directives scoped to a group (called on disband).
    void RemoveForGroup(uint32_t groupId);

    /// Evaluator pass — same cadence/discipline as StandingOrderManager.
    void Evaluate(uint32_t currentFrame);

    std::vector<const Directive*> GetTeamDirectives(int team) const;
    const std::vector<Directive>& GetAllDirectives() const { return directives; }

    void Clear();

    // ── Snapshot restore (PLAN-persistence task 1b) ──
    uint32_t NextId() const { return nextId; }
    void RestoreState(std::vector<Directive> newDirectives, uint32_t newNextId);

private:
    std::vector<Directive> directives;
    uint32_t nextId = 1;
    DirectiveChangeNotifier changeNotifier;
    void NotifyChange(int team) { if (changeNotifier) changeNotifier(team); }
};

extern DirectiveManager directiveManager;
