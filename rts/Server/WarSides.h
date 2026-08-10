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
