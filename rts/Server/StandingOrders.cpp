// StandingOrders — server-side standing order manager + evaluator.

#include "StandingOrders.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/TeamHandler.h"
#include "System/EventHandler.h"
#include "OrgGroups.h"

#include <algorithm>

StandingOrderManager standingOrders;

uint32_t StandingOrderManager::Create(int team, StandingOrderType type, uint8_t priority,
                                      std::vector<float> params,
                                      StandingOrderConditions cond,
                                      uint32_t expiresInFrames,
                                      uint32_t currentFrame,
                                      int authorPlayerId)
{
    // S6 cap. Refuse rather than truncate: silently evicting somebody else's
    // oldest directive would look to the player like an order that stopped
    // working for no reason, and the caller can report a refusal.
    if (perTeamCap > 0 && CountTeamOrders(team) >= perTeamCap)
        return 0;

    StandingOrder o;
    o.id = nextId++;
    o.team = team;
    o.authorPlayerId = authorPlayerId;
    o.type = type;
    o.priority = priority;
    o.params = std::move(params);
    o.conditions = std::move(cond);
    o.active = true;
    o.createdAtFrame = currentFrame;
    // S6 TTL: an omitted deadline gets the default one. `expiresInFrames > 0`
    // from the caller always wins, including a caller that wants a *longer*
    // life than the default.
    const uint32_t ttl = (expiresInFrames > 0) ? expiresInFrames : defaultTtlFrames;
    o.expiresAtFrame = (ttl > 0) ? (currentFrame + ttl) : 0;
    orders.push_back(std::move(o));
    NotifyChange(team);
    return orders.back().id;
}

bool StandingOrderManager::Update(uint32_t orderId, int team, uint8_t priority,
                                  std::vector<float> params,
                                  StandingOrderConditions cond, bool active)
{
    for (auto& o : orders) {
        if (o.id != orderId) continue;
        if (o.team != team) return false;
        o.priority = priority;
        o.params = std::move(params);
        o.conditions = std::move(cond);
        // Pausing an order releases its assigned squads so they
        // re-enter the candidate pool. Without this the evaluator
        // wouldn't issue new commands but the existing assignments
        // would still count against assigned_squad_count.
        if (o.active && !active) o.assigned.clear();
        o.active = active;
        NotifyChange(team);
        return true;
    }
    return false;
}

bool StandingOrderManager::Remove(uint32_t orderId, int team)
{
    for (auto it = orders.begin(); it != orders.end(); ++it) {
        if (it->id != orderId) continue;
        if (it->team != team) return false;
        const int t = it->team;
        orders.erase(it);
        NotifyChange(t);
        return true;
    }
    return false;
}

size_t StandingOrderManager::CountTeamOrders(int team) const
{
    size_t n = 0;
    for (const auto& o : orders) {
        if (o.team == team) ++n;
    }
    return n;
}

std::vector<const StandingOrder*> StandingOrderManager::GetTeamOrders(int team) const
{
    std::vector<const StandingOrder*> result;
    for (const auto& o : orders) {
        if (o.team == team) result.push_back(&o);
    }
    // Stable sort: priority desc, then id asc. Same ordering the
    // evaluator uses, so clients see the assignment ladder.
    std::stable_sort(result.begin(), result.end(),
        [](const StandingOrder* a, const StandingOrder* b) {
            if (a->priority != b->priority) return a->priority > b->priority;
            return a->id < b->id;
        });
    return result;
}

void StandingOrderManager::Clear()
{
    orders.clear();
    nextId = 1;
}

// ----------------------------------------------------------------
// Evaluator
// ----------------------------------------------------------------

/// A unit is "idle" if its command queue is empty AND it is not held
/// by a guard / patrol / fight that the evaluator itself issued on a
/// previous pass. The simplest discriminator is: empty queue. Once
/// issued, the unit's queue is non-empty so it falls out of the
/// candidate pool until it finishes — at which point it can be picked
/// up again on the next evaluator tick (preserving the "standing order
/// re-issues" property).
static bool UnitIsIdle(const CUnit* unit)
{
    if (unit == nullptr || unit->isDead) return false;
    return unit->commandAI->commandQue.empty();
}

/// Does the squad pass every populated filter in `c`? Spatial filters
/// compare against the unit's mid position.
static bool PassesConditions(const CUnit* unit, const StandingOrderConditions& c)
{
    if (c.idleOnly && !UnitIsIdle(unit)) return false;

    // Org-group scope (macro-orders §4.2, the A+C fusion): a group-scoped
    // standing order draws only from that group's roster.
    if (c.orgGroup != 0 && !orgGroups.IsMember(c.orgGroup, unit->id)) return false;

    if (!c.squadTypes.empty()) {
        const uint16_t def = unit->unitDef ? static_cast<uint16_t>(unit->unitDef->id) : 0;
        bool found = false;
        for (uint16_t allowed : c.squadTypes) {
            if (allowed == def) { found = true; break; }
        }
        if (!found) return false;
    }

    if (c.withinRadius > 0.0f) {
        const float d = unit->pos.distance2D(c.withinCenter);
        if (d > c.withinRadius) return false;
    }
    if (c.outsideRadius > 0.0f) {
        const float d = unit->pos.distance2D(c.outsideCenter);
        if (d < c.outsideRadius) return false;
    }
    if (c.minStrength > 0.0f) {
        if (unit->health < c.minStrength) return false;
    }
    // hasCapabilities is left to game-specific Lua to filter via the
    // pre-evaluator hook (TODO once Lua API lands). Empty list = no-op.
    return true;
}

/// Returns true if the order's first param triplet is a valid world
/// point. Used by DefendArea / RallyPoint / Fallback / Reinforce.
static bool ReadVec3(const std::vector<float>& p, size_t offset, float3& out)
{
    if (p.size() < offset + 3) return false;
    out = float3(p[offset], p[offset + 1], p[offset + 2]);
    return true;
}

/// Issue the concrete command for a single (unit, order) pairing.
/// Returns true if a command was actually issued so the caller can
/// count it against `assigned`.
static bool IssueCommandFor(CUnit* unit, const StandingOrder& order)
{
    // Issued ON BEHALF OF the order's author — see the identical helper in
    // OrgGroups.cpp's IssueDirectiveCommand for the full rationale
    // (PLAN-metalstorm-objectives.md §5.1, endtoend D24). `fromLua = true`
    // keeps the decomposed command free of an authority charge; the real
    // playerNum lets game Lua stamp `last_commander` on what the order moves.
    const auto issue = [&](const Command& c) {
        unit->commandAI->GiveCommand(c, order.authorPlayerId, /*fromSynced=*/true, /*fromLua=*/true);
    };

    switch (order.type) {
        case StandingOrderType::DefendArea: {
            // params = [x, y, z, radius]. We issue CMD_FIGHT at the
            // centre — CCommandAI's fight logic auto-engages enemies
            // in the unit's weapon range while pursuing the target,
            // which is the closest Spring built-in to "defend this
            // area". A future refinement could check enemy proximity
            // and dispatch to the closest threat instead.
            float3 target;
            if (!ReadVec3(order.params, 0, target)) return false;
            Command cmd(CMD_FIGHT, 0, target);
            issue(cmd);
            return true;
        }
        case StandingOrderType::PatrolRoute: {
            // params = [x1,y1,z1, x2,y2,z2, ...]. Queue first as a
            // PATROL (replaces queue), then SHIFT-PATROL the rest.
            const size_t nPts = order.params.size() / 3;
            if (nPts == 0) return false;
            for (size_t i = 0; i < nPts; i++) {
                float3 wp(order.params[i*3 + 0], order.params[i*3 + 1], order.params[i*3 + 2]);
                Command cmd(CMD_PATROL, (i == 0) ? 0 : SHIFT_KEY, wp);
                issue(cmd);
            }
            return true;
        }
        case StandingOrderType::RallyPoint:
        case StandingOrderType::Fallback:
        case StandingOrderType::Reinforce: {
            // All three map to a plain CMD_MOVE to the listed point —
            // the difference is in which squads they match (handled by
            // conditions, not by command type).
            float3 target;
            if (!ReadVec3(order.params, 0, target)) return false;
            Command cmd(CMD_MOVE, 0, target);
            issue(cmd);
            return true;
        }
        case StandingOrderType::Screen:
        case StandingOrderType::SupplyRoute: {
            // Both are "line between two points". Issue a patrol
            // between the endpoints so the assigned unit walks back
            // and forth.
            float3 a, b;
            if (!ReadVec3(order.params, 0, a)) return false;
            if (!ReadVec3(order.params, 3, b)) return false;
            Command first(CMD_PATROL, 0, a);
            Command second(CMD_PATROL, SHIFT_KEY, b);
            issue(first);
            issue(second);
            return true;
        }
        case StandingOrderType::BuildBase: {
            // BuildBase is loose: params = [x, y, z, defId, defId, ...].
            // Issue CMD_MOVE first, then queue CMD_BUILD per defId at
            // the centre + small offset so builders fan out a tiny
            // bit. Reserved for future iteration — the build slot
            // placement logic belongs in Lua, not the C++ evaluator.
            // For v1, just CMD_MOVE the builder to the spot and let a
            // separate gadget handle the actual build queue.
            float3 target;
            if (!ReadVec3(order.params, 0, target)) return false;
            Command cmd(CMD_MOVE, 0, target);
            issue(cmd);
            return true;
        }
    }
    return false;
}

void StandingOrderManager::Evaluate(uint32_t currentFrame)
{
    // Expire orders past their deadline first. Track per-team
    // notifications so we only push one StandingOrderState per team
    // even if multiple orders expire on the same tick.
    std::unordered_set<int> dirtyTeams;
    for (auto it = orders.begin(); it != orders.end(); ) {
        if (it->expiresAtFrame > 0 && currentFrame >= it->expiresAtFrame) {
            dirtyTeams.insert(it->team);
            it = orders.erase(it);
        } else {
            ++it;
        }
    }

    // Sort by priority (desc), then id (asc) — same ordering as
    // GetTeamOrders so clients see the assignment ladder.
    std::stable_sort(orders.begin(), orders.end(),
        [](const StandingOrder& a, const StandingOrder& b) {
            if (a.priority != b.priority) return a.priority > b.priority;
            return a.id < b.id;
        });

    // Drop assignments for units that died or got direct-commanded
    // since the last evaluator pass. This restores them to the idle
    // candidate pool.
    for (auto& o : orders) {
        if (!o.active) { o.assigned.clear(); continue; }
        for (auto it = o.assigned.begin(); it != o.assigned.end(); ) {
            const CUnit* u = unitHandler.GetUnit(*it);
            if (u == nullptr || u->isDead || !u->commandAI->commandQue.empty()) {
                if (u == nullptr || u->isDead) {
                    it = o.assigned.erase(it);
                } else {
                    // Unit got direct-commanded — release it. The next
                    // evaluator pass may re-assign once it's idle.
                    it = o.assigned.erase(it);
                }
            } else {
                ++it;
            }
        }
    }

    // Build the candidate pool once: every idle, non-dead unit indexed
    // by team. Iterating activeUnits is O(N); the per-order match below
    // is O(N×O) on the worst case but most evaluator passes will leave
    // very few idle units to consider.
    const auto& activeUnits = unitHandler.GetActiveUnits();

    for (auto& order : orders) {
        if (!order.active) continue;

        size_t assignedBefore = order.assigned.size();
        for (CUnit* unit : activeUnits) {
            if (unit == nullptr || unit->isDead) continue;
            if (unit->team != order.team) continue;
            if (order.assigned.count(unit->id) != 0) continue;
            if (!PassesConditions(unit, order.conditions)) continue;

            // Final game-Lua veto: gadget:AllowStandingOrderAssign
            // can return false to block this (order, unit) pair —
            // primary use is resolving the order's hasCapabilities
            // tags against game-specific unit tagging the C++
            // evaluator can't see. Default impl allows; only the
            // synced LuaRules handle implements an override.
            if (!eventHandler.AllowStandingOrderAssign(order.id, unit))
                continue;

            if (IssueCommandFor(unit, order)) {
                order.assigned.insert(unit->id);
            }
        }
        if (order.assigned.size() != assignedBefore) {
            dirtyTeams.insert(order.team);
        }
    }

    for (int t : dirtyTeams) NotifyChange(t);
}
