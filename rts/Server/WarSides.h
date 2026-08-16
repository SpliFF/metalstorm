// WarSides — the one decoder for the `war_sides` modoption.
//
// `war_sides` is written once by the lobby at room-create time
// (`EncodeWarSides`, ScenarioDiscovery.h) as
// `"<faction>:<team>[,<faction>:<team>…]"`, e.g. `"compact:0,union:1"`, and is
// then read by three unrelated processes: the lobby's RoomManager (to seat a
// slot), the client (to label a side), and — since PLAN-metalstorm-lobby.md
// task 2 — the *game server*, which needs it to seat a dynamic joiner whose
// account never appeared in the launch roster.
//
// It lived as a private loop inside `GameRoom::SideTeams()`, which is a member
// of a type the game server has no room row for. Two copies of a hand-rolled
// parser either side of a process boundary is exactly the shape that lets a
// faction be seated on team 0 in one process and refused in the other, so the
// loop moved here and `GameRoom` now delegates. Same discipline as task 1's
// `SessionKindToString`/`SessionKindFromString`: one encoder, one decoder.
#pragma once

/// One side's territorial standing, as the sim's foothold census reports it
/// (PLAN-metalstorm-wars.md §7 faction elimination, task 4). Lives here rather
/// than beside the rule that consumes it because it is a per-side VALUE, and
/// this header is the one place the three processes already agree on what a
/// side is — putting it next to the Director would make `WarSummary.h`, which
/// only reports the census, include the component that decides on it.
struct WarSideFootholds {
    std::string factionId;
    /// Declared start regions this side still holds. A region captured
    /// ELSEWHERE is not a foothold: §7's condition is "all its start regions
    /// gone", so a faction pushed off its own ground while sitting on someone
    /// else's is eliminated — which is the reading that makes the condition
    /// reachable at all.
    unsigned held = 0;
};

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

/// A war's sides as `(faction, team)`, in the order the lobby offers them.
using WarSides = std::vector<std::pair<std::string, uint8_t>>;

/// Parse a `war_sides` spec. Returns empty for an absent or wholly
/// unparseable spec — every consumer reads that as "legacy two-team room",
/// and deliberately NOT as `{0, 1}`: a legacy room's teams have no faction
/// names, and inventing some would let the faction seating rule fire on a room
/// that never declared a side.
///
/// Malformed entries are dropped individually rather than failing the whole
/// spec, because a side this server cannot name is still a side the other
/// entries must not be renumbered around.
inline WarSides ParseWarSides(const std::string& spec) {
    WarSides out;
    size_t pos = 0;
    while (pos < spec.size()) {
        const size_t comma = spec.find(',', pos);
        const std::string entry = spec.substr(
            pos, comma == std::string::npos ? std::string::npos : comma - pos);
        // `colon > 0` — an entry with no faction name is not a side, however
        // parseable its number looks.
        const size_t colon = entry.find(':');
        if (colon != std::string::npos && colon > 0 && colon + 1 < entry.size()) {
            const std::string num = entry.substr(colon + 1);
            // Reject anything non-numeric rather than let atoi's 0 quietly
            // seat two sides on the same team.
            if (!num.empty() &&
                num.find_first_not_of("0123456789") == std::string::npos) {
                const int team = std::atoi(num.c_str());
                if (team >= 0 && team <= 255) {
                    const auto t = static_cast<uint8_t>(team);
                    const bool seen = std::any_of(
                        out.begin(), out.end(),
                        [t](const auto& s) { return s.second == t; });
                    if (!seen)
                        out.emplace_back(entry.substr(0, colon), t);
                }
            }
        }
        if (comma == std::string::npos)
            break;
        pos = comma + 1;
    }
    return out;
}

/// Encode sides back into the `war_sides` modoption form.
///
/// The counterpart to `ParseWarSides`, and the ONE place the grammar is
/// written — `ScenarioDiscovery::EncodeWarSides` builds its list and then
/// delegates here, and PLAN-metalstorm-wars.md's War Director derives the
/// modoption from its `war_sides` rows through the same call. Three readers
/// parse this string in three processes; two independent writers of it is the
/// shape that lets a faction be seated on team 0 in one and refused in
/// another.
///
/// A faction key carrying ',' or ':' is DROPPED rather than emitted, because
/// it would silently reshape the list for every downstream parser — the same
/// rule, and the same reason, as `EncodeWarSideCapacities` below.
inline std::string EncodeWarSides(const WarSides& sides) {
    std::string out;
    for (const auto& [faction, team] : sides) {
        if (faction.empty() || faction.find(',') != std::string::npos ||
            faction.find(':') != std::string::npos)
            continue;
        if (!out.empty())
            out += ',';
        out += faction;
        out += ':';
        out += std::to_string(static_cast<unsigned>(team));
    }
    return out;
}

/// `0` means "no capacity limit", which is what a war that never declares one
/// gets. Chosen so an unset/absent value is permissive: a war that forgot to
/// size its sides should let players in and be rebalanced by §6's seeding,
/// not lock everyone out of a running world.
inline constexpr unsigned WAR_SIDE_CAPACITY_UNLIMITED = 0;

/// Humans per side for a war that declares no per-side capacity, and the
/// fallback for any single side a war leaves unsized (`--war-side-capacity`).
inline constexpr unsigned WAR_SIDE_CAPACITY_DEFAULT = 8;

/// A war's per-side human capacities as `(faction, capacity)`.
///
/// PLAN-metalstorm-lobby.md §6, task 7. Task 2 shipped ONE number for every
/// side (`--war-side-capacity`, default 8) and said so: §6's balance is
/// structural, and a structure in which both sides of a war are the same size
/// cannot express "this faction has a player surplus, give its side more room".
using WarSideCapacities = std::vector<std::pair<std::string, unsigned>>;

/// Parse the `war_side_capacities` modoption
/// (`"<faction>:<capacity>[,<faction>:<capacity>…]"`, e.g. `"compact:8,union:12"`).
///
/// ── Why this is a SECOND modoption and not a third field on `war_sides` ──
/// `war_sides` is parsed by three independent readers (here, the client's
/// `war-sides.ts`, the room screen), and every one of them rejects an entry
/// whose team is not purely numeric — `compact:0:12` would be *dropped*, not
/// mis-read. A browser holding a cached bundle would therefore fall back to the
/// legacy two-team room for every war a new lobby created, which is exactly the
/// D19 defect `war_sides` exists to fix. An additive option can only be
/// ignored by an old reader, and being ignored means "uniform capacity", which
/// is the behaviour that reader already had.
///
/// Deduped by FACTION, not by number — unlike `ParseWarSides`, where a repeated
/// team is a genuine conflict. Two sides sharing a capacity is the normal case.
inline WarSideCapacities ParseWarSideCapacities(const std::string& spec) {
    WarSideCapacities out;
    size_t pos = 0;
    while (pos < spec.size()) {
        const size_t comma = spec.find(',', pos);
        const std::string entry = spec.substr(
            pos, comma == std::string::npos ? std::string::npos : comma - pos);
        const size_t colon = entry.find(':');
        if (colon != std::string::npos && colon > 0 && colon + 1 < entry.size()) {
            const std::string num = entry.substr(colon + 1);
            if (!num.empty() &&
                num.find_first_not_of("0123456789") == std::string::npos) {
                const std::string faction = entry.substr(0, colon);
                const bool seen = std::any_of(
                    out.begin(), out.end(),
                    [&faction](const auto& c) { return c.first == faction; });
                if (!seen)
                    out.emplace_back(faction,
                                     static_cast<unsigned>(std::strtoul(
                                         num.c_str(), nullptr, 10)));
            }
        }
        if (comma == std::string::npos)
            break;
        pos = comma + 1;
    }
    return out;
}

/// The human capacity of `factionId`'s side, or `fallback` when this war
/// declares none for it.
///
/// `fallback` is the war's uniform capacity (`--war-side-capacity`), so a war
/// that authors capacities for some sides and not others is still fully
/// defined, and a war that authors none behaves exactly as it did before
/// task 7. An authored `0` is NOT absence — it is `WAR_SIDE_CAPACITY_UNLIMITED`
/// for that side, deliberately chosen, and overrides a bounded fallback.
inline unsigned CapacityForSideIn(const WarSideCapacities& caps,
                                  const std::string& factionId,
                                  unsigned fallback) {
    if (factionId.empty())
        return fallback;
    for (const auto& [faction, capacity] : caps)
        if (faction == factionId)
            return capacity;
    return fallback;
}

/// Encode capacities back into the modoption form. One encoder for the one
/// decoder above (the discipline task 2 set for `war_sides`): the lobby writes
/// this at war-create time from either the scenario's authored capacities or
/// the seeding rule, and never assembles the string by hand at a call site.
inline std::string EncodeWarSideCapacities(const WarSideCapacities& caps) {
    std::string out;
    for (const auto& [faction, capacity] : caps) {
        // A faction key carrying a separator would silently reshape the list
        // downstream — same rule, same reason, as EncodeWarSides.
        if (faction.empty() || faction.find(',') != std::string::npos ||
            faction.find(':') != std::string::npos)
            continue;
        if (!out.empty())
            out += ',';
        out += faction;
        out += ':';
        out += std::to_string(capacity);
    }
    return out;
}

/// The team `factionId` is seated on in `sides`, or nullopt when this war
/// declares no side for it (including every legacy no-scenario room, whose
/// sides have no names at all).
///
/// An empty `factionId` — a dev account, a `/api/rooms/direct` manifest
/// account, a pre-faction legacy account — never matches, which is what keeps
/// those paths on their existing behaviour.
inline std::optional<uint8_t> TeamForFactionIn(const WarSides& sides,
                                               const std::string& factionId) {
    if (factionId.empty())
        return std::nullopt;
    for (const auto& [faction, team] : sides)
        if (faction == factionId)
            return team;
    return std::nullopt;
}
