// OrgGroups — org-group registry (Model A) + macro-directive manager.
// See OrgGroups.h and PLAN-macro-orders.md / PLAN-macro-directives.md.

#include "OrgGroups.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "System/EventHandler.h"
#include "System/float3.h"

#include <algorithm>

OrgGroupManager orgGroups;
DirectiveManager directiveManager;

const std::vector<uint32_t> OrgGroupManager::kEmptyRoster;

// ================================================================
// Group names (PLAN-metalstorm-command-language.md §5)
// ================================================================
//
// Two jobs live here and they pull in opposite directions.
//
// GIVING a name. `OrgGroup::name` has been on the wire since the macro-orders
// lane and NOTHING ever set it: AI.createGroup passes none, there is no naming
// UI, so every group in every client rendered as "Group 7". A number is not
// something a player says out loud, which put the natural-language layer's
// "names, not ids" pillar out of reach for the one entity type a player
// commands most. An unnamed create now draws a callsign from the register.
//
// DISTRUSTING a name. A group name is player-supplied text that ends up inside
// an LLM context payload — the NL proxy ships the named-entity index as part
// of the prompt (§2), and a group is in that index. It is untrusted input in
// the prompt-injection sense, and the only defence available at THIS layer is
// that a name stays short and stays printable: no newlines to fake a message
// boundary, no control bytes, no paragraph of instructions wearing a squad's
// hat. So every path that can set a name goes through SanitizeGroupName —
// Create as well as Update, because Create takes the same untrusted string off
// the same wire message.

/// Callsigns for auto-named groups. Post-nuclear scavenger register
/// (PLAN-metalstorm-worldbuilding.md decision 7): predators, carrion birds,
/// rust and fire — what a crew paints on a hull, not a table of organisation.
/// The order IS the assignment order, so it is deliberately not alphabetical.
static const char* const kCallsigns[] = {
    "Chimera",  "Basilisk", "Warhound", "Jackal",   "Vulture",
    "Rust",     "Ember",    "Kestrel",  "Mantis",   "Cinder",
    "Wyvern",   "Scarab",   "Magpie",   "Ash",      "Grendel",
    "Hyena",    "Cobra",    "Slag",     "Falcon",   "Wraith",
    "Boar",     "Tinder",   "Adder",    "Raven",    "Ironjaw",
    "Gargoyle", "Shrike",   "Coyote",   "Thresher", "Kiln",
    "Locust",   "Direwolf", "Marrow",   "Condor",   "Bramble",
    "Salt",     "Harrier",  "Gnaw",     "Pyre",     "Scrapper",
};
static constexpr size_t kCallsignCount = sizeof(kCallsigns) / sizeof(kCallsigns[0]);

/// Longest name any consumer will ever be handed. Short on purpose — see the
/// "DISTRUSTING a name" note above; this is a payload budget, not a UI one.
static constexpr size_t kMaxGroupNameBytes = 32;

size_t OrgGroupManager::CallsignCount() { return kCallsignCount; }

/// Echelon → the word that follows the callsign. v0 rejects Army before it can
/// reach here (Create fails loud on the reserved tier), so "Battlegroup" is
/// unreachable today and is spelled out anyway so the day the tier ships it
/// doesn't ship as "Chimera Army".
static const char* EchelonSuffix(Echelon echelon)
{
    switch (echelon) {
        case Echelon::Squad:   return "Squad";
        case Echelon::Platoon: return "Platoon";
        case Echelon::Army:    return "Battlegroup";
    }
    return "Squad";
}

/// Strip control bytes, cap at kMaxGroupNameBytes, trim the edges.
///
/// The cap is applied on a UTF-8 CHARACTER boundary, not a byte one: half a
/// multi-byte sequence is invalid UTF-8, and invalid UTF-8 is exactly what
/// breaks the JSON this name is about to be serialised into. (This does not
/// *validate* the input's encoding — it only guarantees the cap can't be what
/// corrupts it.)
static std::string SanitizeGroupName(const std::string& raw)
{
    std::string out;
    out.reserve(std::min(raw.size(), kMaxGroupNameBytes));
    for (const unsigned char c : raw) {
        if (c < 0x20 || c == 0x7F) continue;   // control chars, incl. \n \r \t
        out.push_back(static_cast<char>(c));
    }

    size_t cut = std::min(out.size(), kMaxGroupNameBytes);
    // Back off while the byte AT the cut is a continuation byte — cutting there
    // would leave a lead byte with no tail.
    while (cut > 0 && cut < out.size() &&
           (static_cast<unsigned char>(out[cut]) & 0xC0) == 0x80)
        --cut;
    out.resize(cut);

    const size_t first = out.find_first_not_of(' ');
    if (first == std::string::npos) return std::string();
    return out.substr(first, out.find_last_not_of(' ') - first + 1);
}

std::string OrgGroupManager::AssignCallsign(int team, Echelon echelon) const
{
    // The used-set is DERIVED from the team's live groups rather than kept as
    // separate state. That is not only less bookkeeping: a disbanded group's
    // callsign returns to the pool, Clear() needs no companion reset, and — the
    // case a side table gets wrong — a player who renames a group to "Chimera
    // Platoon" by hand blocks the assigner from handing that same name to
    // somebody else. Uniqueness is a property of what EXISTS, so read what
    // exists.
    std::unordered_set<std::string> taken;
    for (const auto& g : groups)
        if (g.team == team) taken.insert(g.name);

    const std::string suffix = EchelonSuffix(echelon);
    // Start at a team-dependent offset: allied teams broadcast their groups to
    // each other (OrgGroupState), and two "Chimera Platoon"s across an alliance
    // is a question the player shouldn't have to be asked.
    const size_t start = static_cast<size_t>(team > 0 ? team : 0) % kCallsignCount;

    // Rounds are unbounded but termination is not in doubt: `taken` holds at
    // most groups.size() names, and every round offers kCallsignCount fresh
    // candidates, so round (groups.size() / kCallsignCount + 1) cannot be full.
    for (uint32_t round = 0; ; ++round) {
        for (size_t i = 0; i < kCallsignCount; ++i) {
            std::string candidate = kCallsigns[(start + i) % kCallsignCount] + (" " + suffix);
            if (round > 0) candidate += " " + std::to_string(round + 1);
            // Sanitize BEFORE the uniqueness test so the check runs against the
            // string that will actually be stored.
            candidate = SanitizeGroupName(candidate);
            if (taken.count(candidate) == 0) return candidate;
        }
    }
}

// ================================================================
// OrgGroupManager
// ================================================================

int OrgGroupManager::PullFromOtherGroups(uint32_t unitId, uint32_t exceptGroupId)
{
    int touched = -1;
    for (auto& g : groups) {
        if (g.id == exceptGroupId) continue;
        auto it = std::find(g.members.begin(), g.members.end(), unitId);
        if (it != g.members.end()) {
            g.members.erase(it);
            touched = g.team;
        }
    }
    return touched;
}

uint32_t OrgGroupManager::Create(int team, Echelon echelon, std::string name,
                                 const std::vector<uint32_t>& members,
                                 uint32_t parentId, uint32_t currentFrame)
{
    // v0 field discipline (PLAN-macro-directives §1): the army tier is
    // reserved in the schema but not surfaced — reject rather than
    // half-implement, so callers can't depend on it before it ships.
    if (echelon == Echelon::Army || parentId != 0)
        return 0;

    OrgGroup g;
    g.id = nextId++;
    g.echelon = echelon;
    g.team = team;
    g.parentId = 0;
    // An explicit name is capped and stripped but otherwise passes through
    // untouched; no name at all (the AI path, and an unnamed player create)
    // draws a callsign, so "Group 7" never has to be rendered.
    g.name = SanitizeGroupName(name);
    if (g.name.empty()) g.name = AssignCallsign(team, echelon);
    g.createdAtFrame = currentFrame;
    groups.push_back(std::move(g));
    OrgGroup& created = groups.back();

    // Seed the roster, enforcing the one-platoon rule. Track other teams'
    // groups that lost a member so they get a refresh too (shouldn't happen
    // across teams in practice, but a defensive notify is cheap).
    std::unordered_set<int> otherDirtyTeams;
    for (uint32_t uid : members) {
        if (std::find(created.members.begin(), created.members.end(), uid) != created.members.end())
            continue;   // dedup within the seed list
        const int t = PullFromOtherGroups(uid, created.id);
        if (t >= 0 && t != team) otherDirtyTeams.insert(t);
        created.members.push_back(uid);
    }

    const uint32_t newId = created.id;
    for (int t : otherDirtyTeams) NotifyChange(t);
    NotifyChange(team);
    return newId;
}

bool OrgGroupManager::Update(uint32_t groupId, int team,
                             const std::vector<uint32_t>& addIds,
                             const std::vector<uint32_t>& removeIds,
                             const std::string& name)
{
    OrgGroup* g = Get(groupId);
    if (g == nullptr) return false;
    if (g->team != team) return false;

    std::unordered_set<int> otherDirtyTeams;
    for (uint32_t uid : removeIds) {
        auto it = std::find(g->members.begin(), g->members.end(), uid);
        if (it != g->members.end()) g->members.erase(it);
    }
    for (uint32_t uid : addIds) {
        if (std::find(g->members.begin(), g->members.end(), uid) != g->members.end())
            continue;
        const int t = PullFromOtherGroups(uid, groupId);
        if (t >= 0 && t != team) otherDirtyTeams.insert(t);
        g->members.push_back(uid);
    }
    // A rename is untrusted input on the same footing as Create's wire name —
    // capped and stripped before it is stored (see "DISTRUSTING a name"). A
    // name that sanitizes down to nothing (all control bytes, all spaces) is
    // treated as "no name given", the same as an empty one: the roster edit
    // still applies, only the rename is dropped. The player-facing complaint
    // for that lives client-side, where nl-envelope's checkRef rejects the
    // name before it is ever sent.
    const std::string cleanName = SanitizeGroupName(name);
    if (!cleanName.empty()) g->name = cleanName;

    for (int t : otherDirtyTeams) NotifyChange(t);
    NotifyChange(team);
    return true;
}

bool OrgGroupManager::Disband(uint32_t groupId, int team)
{
    for (auto it = groups.begin(); it != groups.end(); ++it) {
        if (it->id != groupId) continue;
        if (it->team != team) return false;
        const int t = it->team;
        groups.erase(it);
        NotifyChange(t);
        return true;
    }
    return false;
}

bool OrgGroupManager::SetPosture(uint32_t groupId, int team, std::string postureJson)
{
    OrgGroup* g = Get(groupId);
    if (g == nullptr || g->team != team) return false;
    g->postureJson = std::move(postureJson);
    NotifyChange(team);
    return true;
}

void OrgGroupManager::SetCurrentDirective(uint32_t groupId, uint32_t directiveId)
{
    OrgGroup* g = Get(groupId);
    if (g == nullptr) return;
    if (g->currentDirectiveId == directiveId) return;
    g->currentDirectiveId = directiveId;
    NotifyChange(g->team);
}

bool OrgGroupManager::IsMember(uint32_t groupId, uint32_t unitId) const
{
    const OrgGroup* g = Get(groupId);
    if (g == nullptr) return false;
    return std::find(g->members.begin(), g->members.end(), unitId) != g->members.end();
}

uint32_t OrgGroupManager::GroupOfUnit(uint32_t unitId) const
{
    for (const auto& g : groups) {
        if (std::find(g.members.begin(), g.members.end(), unitId) != g.members.end())
            return g.id;
    }
    return 0;
}

const std::vector<uint32_t>& OrgGroupManager::MembersOf(uint32_t groupId) const
{
    const OrgGroup* g = Get(groupId);
    return g ? g->members : kEmptyRoster;
}

void OrgGroupManager::OnUnitRemoved(uint32_t unitId)
{
    const int t = PullFromOtherGroups(unitId, 0);
    if (t >= 0) NotifyChange(t);
}

void OrgGroupManager::PruneDeadMembers()
{
    std::unordered_set<int> dirtyTeams;
    for (auto& g : groups) {
        const size_t before = g.members.size();
        g.members.erase(
            std::remove_if(g.members.begin(), g.members.end(), [](uint32_t uid) {
                const CUnit* u = unitHandler.GetUnit(uid);
                return u == nullptr || u->isDead;
            }),
            g.members.end());
        if (g.members.size() != before) dirtyTeams.insert(g.team);
    }
    for (int t : dirtyTeams) NotifyChange(t);
}

OrgGroup* OrgGroupManager::Get(uint32_t groupId)
{
    for (auto& g : groups) if (g.id == groupId) return &g;
    return nullptr;
}

const OrgGroup* OrgGroupManager::Get(uint32_t groupId) const
{
    for (const auto& g : groups) if (g.id == groupId) return &g;
    return nullptr;
}

std::vector<const OrgGroup*> OrgGroupManager::GetTeamGroups(int team) const
{
    std::vector<const OrgGroup*> out;
    for (const auto& g : groups) if (g.team == team) out.push_back(&g);
    std::stable_sort(out.begin(), out.end(),
        [](const OrgGroup* a, const OrgGroup* b) { return a->id < b->id; });
    return out;
}

void OrgGroupManager::Clear()
{
    groups.clear();
    nextId = 1;
}

// ================================================================
// DirectiveManager
// ================================================================

/// Empty command queue = idle (same discriminator StandingOrderManager
/// uses). Directly-commanded members fall out of the candidate pool until
/// they finish — this gives the per-squad suspend / auto-rejoin behaviour
/// (Q-D-d §3) for free on a group-scoped directive.
static bool DirIsIdle(const CUnit* u)
{
    if (u == nullptr || u->isDead) return false;
    return u->commandAI->commandQue.empty();
}

/// Non-spatial conditions (idleOnly is handled by the caller so a
/// group-scoped directive can re-issue only to idle members). Spatial /
/// type / strength filters mirror StandingOrders' PassesConditions.
static bool DirPassesFilters(const CUnit* u, const StandingOrderConditions& c)
{
    if (!c.squadTypes.empty()) {
        const uint16_t def = u->unitDef ? static_cast<uint16_t>(u->unitDef->id) : 0;
        if (std::find(c.squadTypes.begin(), c.squadTypes.end(), def) == c.squadTypes.end())
            return false;
    }
    if (c.withinRadius > 0.0f && u->pos.distance2D(c.withinCenter) > c.withinRadius)
        return false;
    if (c.outsideRadius > 0.0f && u->pos.distance2D(c.outsideCenter) < c.outsideRadius)
        return false;
    if (c.minStrength > 0.0f && u->health < c.minStrength)
        return false;
    return true;
}

/// Read a world point from `params` at `offset` (needs 3 floats there).
static bool DirReadVec3(const std::vector<float>& p, size_t offset, float3& out)
{
    if (p.size() < offset + 3) return false;
    out = float3(p[offset], p[offset + 1], p[offset + 2]);
    return true;
}

/// Shape geometry layout (matches the protocol.fbs OrderShape doc):
///   Point    → [x,y,z]
///   Circle   → [x,y,z,radius]
///   Polygon  → [x1,y1,z1, ...]            first vertex is the anchor
///   Polyline → [frontage/depth, x1,y1,z1, ...]
/// Returns the offset of the first vertex triplet.
static size_t ShapeVertexOffset(OrderShape shape)
{
    return (shape == OrderShape::Polyline) ? 1 : 0;
}

/// A representative "anchor" point for the shape — the centre of a circle,
/// the first vertex of a point/polygon, or the polyline vertex nearest the
/// unit. Used by the default engine decompositions (the simple move/defend/
/// withdraw types — richer combined-arms decomposition is game-Lua territory
/// via DecomposeDirective, not landed in v0).
static bool ShapeAnchor(const Directive& d, const CUnit* u, float3& out)
{
    const size_t base = ShapeVertexOffset(d.shape);
    if (d.shape == OrderShape::Polyline) {
        // Nearest vertex along the front — carves the line so each squad
        // holds the segment closest to it (DEFEND_FRONT, macro-orders §4.1).
        float best = -1.0f;
        bool found = false;
        for (size_t off = base; off + 3 <= d.params.size(); off += 3) {
            const float3 v(d.params[off], d.params[off + 1], d.params[off + 2]);
            const float dist = u->pos.distance2D(v);
            if (!found || dist < best) { best = dist; out = v; found = true; }
        }
        return found;
    }
    return DirReadVec3(d.params, base, out);
}

/// Issue the concrete command for one (unit, directive) pairing. Returns
/// true if a command was issued. Engine defaults only — the simple types;
/// gameplay-heavy decomposition (artillery coordination, combined arms) is
/// deferred to the game's DecomposeDirective callin (macro-orders §2).
static bool IssueDirectiveCommand(CUnit* u, const Directive& d)
{
    float3 anchor;
    switch (d.type) {
        // 0..7 alias the classic standing-order types — reuse their mapping
        // so a group-scoped classic order works with no new decomposition.
        case DirectiveType::DefendArea:
        case DirectiveType::Defend:
        case DirectiveType::Assault:
        case DirectiveType::Overwatch: {
            // Hold / engage an area. CMD_FIGHT auto-engages enemies in range
            // while advancing to the anchor — the closest built-in to
            // "defend/assault this area". (Overwatch's fire-arc and Assault's
            // artillery split are game-Lua refinements, not v0 engine.)
            if (!ShapeAnchor(d, u, anchor)) return false;
            u->commandAI->GiveCommand(Command(CMD_FIGHT, 0, anchor));
            return true;
        }
        case DirectiveType::DefendFront: {
            if (!ShapeAnchor(d, u, anchor)) return false;  // nearest front vertex
            u->commandAI->GiveCommand(Command(CMD_FIGHT, 0, anchor));
            return true;
        }
        case DirectiveType::MoveFormation:
        case DirectiveType::RallyPoint:
        case DirectiveType::Fallback:
        case DirectiveType::Reinforce:
        case DirectiveType::Withdraw:
        case DirectiveType::BuildBase: {
            // Reposition to the anchor. (Intra-squad formation offsets are
            // cosmetic client-side, PLAN-macro-squads; fight-on-retreat
            // posture for Withdraw folds into GroupPosture, next fire.)
            if (!ShapeAnchor(d, u, anchor)) return false;
            u->commandAI->GiveCommand(Command(CMD_MOVE, 0, anchor));
            return true;
        }
        case DirectiveType::PatrolRoute:
        case DirectiveType::Screen:
        case DirectiveType::SupplyRoute: {
            // Walk the vertices as a patrol.
            const size_t base = ShapeVertexOffset(d.shape);
            size_t issued = 0;
            for (size_t off = base; off + 3 <= d.params.size(); off += 3) {
                float3 wp(d.params[off], d.params[off + 1], d.params[off + 2]);
                u->commandAI->GiveCommand(Command(CMD_PATROL, (issued == 0) ? 0 : SHIFT_KEY, wp));
                ++issued;
            }
            return issued > 0;
        }
        case DirectiveType::Escort: {
            // Guard a target entity if one is supplied as the trailing param
            // (params[last] = target unit id); else fall back to moving to
            // the anchor.
            if (!d.params.empty()) {
                const uint32_t targetId = static_cast<uint32_t>(d.params.back());
                const CUnit* target = unitHandler.GetUnit(targetId);
                if (target != nullptr && !target->isDead && targetId != u->id) {
                    Command cmd(CMD_GUARD, 0);
                    cmd.PushParam(static_cast<float>(targetId));
                    u->commandAI->GiveCommand(cmd);
                    return true;
                }
            }
            if (!ShapeAnchor(d, u, anchor)) return false;
            u->commandAI->GiveCommand(Command(CMD_MOVE, 0, anchor));
            return true;
        }
    }
    return false;
}

uint32_t DirectiveManager::Create(int team, DirectiveType type, uint8_t priority,
                                  OrderShape shape, std::vector<float> params,
                                  StandingOrderConditions cond, uint32_t groupId,
                                  uint32_t requestedStrength, std::string phasesJson,
                                  uint32_t expiresInFrames, uint32_t currentFrame)
{
    Directive d;
    d.id = nextId++;
    d.team = team;
    d.groupId = groupId;
    d.type = type;
    d.priority = priority;
    d.shape = shape;
    d.params = std::move(params);
    d.conditions = std::move(cond);
    d.conditions.orgGroup = groupId;    // conditions mirror the scope
    d.requestedStrength = requestedStrength;
    d.phasesJson = std::move(phasesJson);
    d.active = true;
    d.createdAtFrame = currentFrame;
    d.expiresAtFrame = (expiresInFrames > 0) ? (currentFrame + expiresInFrames) : 0;
    directives.push_back(std::move(d));
    const uint32_t newId = directives.back().id;

    if (groupId != 0) orgGroups.SetCurrentDirective(groupId, newId);
    NotifyChange(team);
    return newId;
}

bool DirectiveManager::Update(uint32_t id, int team, DirectiveType type, uint8_t priority,
                              OrderShape shape, std::vector<float> params,
                              StandingOrderConditions cond, uint32_t requestedStrength,
                              std::string phasesJson, bool active)
{
    for (auto& d : directives) {
        if (d.id != id) continue;
        if (d.team != team) return false;
        d.type = type;
        d.priority = priority;
        d.shape = shape;
        d.params = std::move(params);
        d.conditions = std::move(cond);
        d.conditions.orgGroup = d.groupId;   // scope is immutable
        d.requestedStrength = requestedStrength;
        d.phasesJson = std::move(phasesJson);
        if (d.active && !active) { d.assigned.clear(); d.assignedStrength = 0.0f; }
        d.active = active;
        NotifyChange(team);
        return true;
    }
    return false;
}

bool DirectiveManager::Remove(uint32_t id, int team)
{
    for (auto it = directives.begin(); it != directives.end(); ++it) {
        if (it->id != id) continue;
        if (it->team != team) return false;
        const int t = it->team;
        const uint32_t gid = it->groupId;
        directives.erase(it);
        if (gid != 0) orgGroups.SetCurrentDirective(gid, 0);
        NotifyChange(t);
        return true;
    }
    return false;
}

void DirectiveManager::RemoveForGroup(uint32_t groupId)
{
    if (groupId == 0) return;
    std::unordered_set<int> dirtyTeams;
    for (auto it = directives.begin(); it != directives.end(); ) {
        if (it->groupId == groupId) {
            dirtyTeams.insert(it->team);
            it = directives.erase(it);
        } else {
            ++it;
        }
    }
    for (int t : dirtyTeams) NotifyChange(t);
}

std::vector<const Directive*> DirectiveManager::GetTeamDirectives(int team) const
{
    std::vector<const Directive*> out;
    for (const auto& d : directives) if (d.team == team) out.push_back(&d);
    std::stable_sort(out.begin(), out.end(),
        [](const Directive* a, const Directive* b) {
            if (a->priority != b->priority) return a->priority > b->priority;
            return a->id < b->id;
        });
    return out;
}

void DirectiveManager::Clear()
{
    directives.clear();
    nextId = 1;
}

void DirectiveManager::Evaluate(uint32_t currentFrame)
{
    std::unordered_set<int> dirtyTeams;

    // Expire past deadline.
    for (auto it = directives.begin(); it != directives.end(); ) {
        if (it->expiresAtFrame > 0 && currentFrame >= it->expiresAtFrame) {
            dirtyTeams.insert(it->team);
            const uint32_t gid = it->groupId;
            it = directives.erase(it);
            if (gid != 0) orgGroups.SetCurrentDirective(gid, 0);
        } else {
            ++it;
        }
    }

    // Priority desc, id asc — same ladder clients see.
    std::stable_sort(directives.begin(), directives.end(),
        [](const Directive& a, const Directive& b) {
            if (a.priority != b.priority) return a.priority > b.priority;
            return a.id < b.id;
        });

    // Release assignments for dead / direct-commanded units, then recompute
    // the fulfillment strength from live health.
    for (auto& d : directives) {
        if (!d.active) { d.assigned.clear(); d.assignedStrength = 0.0f; continue; }
        float strength = 0.0f;
        for (auto it = d.assigned.begin(); it != d.assigned.end(); ) {
            const CUnit* u = unitHandler.GetUnit(*it);
            if (u == nullptr || u->isDead || !u->commandAI->commandQue.empty()) {
                it = d.assigned.erase(it);   // died, or direct-commanded → re-pool
            } else {
                strength += u->health;
                ++it;
            }
        }
        if (d.assignedStrength != strength) { d.assignedStrength = strength; }
    }

    for (auto& d : directives) {
        if (!d.active) continue;
        const size_t assignedBefore = d.assigned.size();
        const float strengthBefore = d.assignedStrength;

        // Build the candidate list per scope:
        //  * group-scoped   → the group's current roster (idle members only);
        //  * condition-scoped → unassigned squads (belong to no org group —
        //    rostered squads obey only their own chain, Q-D-d §2).
        auto consider = [&](CUnit* u) {
            if (u == nullptr || u->isDead) return;
            if (u->team != d.team) return;
            if (d.assigned.count(u->id) != 0) return;
            if (!DirIsIdle(u)) return;                // suspend/auto-rejoin
            if (!DirPassesFilters(u, d.conditions)) return;
            // Demand model: stop once the requested aggregate strength is met.
            if (d.requestedStrength > 0 && d.assignedStrength >= static_cast<float>(d.requestedStrength))
                return;
            // Game-Lua veto (extends the landed AllowStandingOrderAssign
            // pattern): AllowDirectiveAssign can block an (order, unit) pair.
            if (!eventHandler.AllowDirectiveAssign(d.id, u)) return;
            if (IssueDirectiveCommand(u, d)) {
                d.assigned.insert(u->id);
                d.assignedStrength += u->health;
            }
        };

        if (d.groupId != 0) {
            for (uint32_t uid : orgGroups.MembersOf(d.groupId))
                consider(unitHandler.GetUnit(uid));
        } else {
            for (CUnit* u : unitHandler.GetActiveUnits()) {
                if (u != nullptr && orgGroups.GroupOfUnit(u->id) != 0) continue;
                consider(u);
            }
        }

        if (d.assigned.size() != assignedBefore || d.assignedStrength != strengthBefore)
            dirtyTeams.insert(d.team);
    }

    for (int t : dirtyTeams) NotifyChange(t);
}
