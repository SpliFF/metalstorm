// WarSummary — the small per-war digest a running game server publishes for
// the war browser, and the lobby's decoder for it.
//
// PLAN-metalstorm-lobby.md §4, task 6. §4 names the source explicitly: "Data
// comes from the game_status rendezvous + a small per-war summary the game
// server publishes (per-faction populations + slot capacity + region-control
// snapshot) — a lightweight war-summary the lobby reads, not the full game
// state."
//
// ── Why a digest and not a query ──────────────────────────────────────────
// The two processes share a SQLite file and nothing else (no backchannel —
// see server_main.cpp's lifetime block), and the facts the browser wants are
// facts only the sim holds: who is actually seated on each side right now,
// how many people are watching, and who is winning. The lobby cannot derive
// any of them. It CAN derive the durable half — a war's bindings, its sides,
// its capacity — and does (JoinPreview.h). So the split this file draws is:
//
//   * the game server publishes what only the sim knows (live populations,
//     spectators, region control, frame/uptime);
//   * the lobby keeps owning what outlives the process (bindings, capacity,
//     the seating promise).
//
// That is not tidiness. A war whose server is down still has to list — task 3
// made a war survive its process — so anything the browser needs in that state
// must NOT come from here. `updated_at` is what tells the lobby which half it
// is looking at, and a stale summary is dropped rather than shown as live.
//
// ── One encoder, one decoder ──────────────────────────────────────────────
// Same discipline as task 1's SessionKindToString/FromString and task 2's
// WarSides: the JSON is written in exactly one place and read in exactly one
// place, both here, across a process boundary. The alternative — a writer in
// server_main and a hand-rolled reader in lobby_main — is the shape that lets
// the two disagree about a field for a week before anyone notices, because
// the disagreement is invisible to both compilers.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "WarSides.h"

/// The wire version. Bumped when a field changes meaning; a decoder that does
/// not recognise the version returns nothing rather than guessing, because a
/// misread population is worse than an absent one (the browser degrades to
/// the lobby-derived half, which is always correct).
inline constexpr int kWarSummaryVersion = 1;

/// One declared side of the war, as the sim currently sees it.
struct WarSideSummary {
    int team = -1;
    /// The faction key `war_sides` names for this team.
    std::string faction;
    /// Connected humans seated on this team. NOT the same number as the
    /// binding count the lobby holds: a bound player who is offline still
    /// holds their seat (task 4) but is not here.
    unsigned humans = 0;
    /// AI players on this team. Published because "3/8 players" on a side an
    /// AI is fighting for reads very differently from an empty one.
    unsigned ais = 0;
    /// Regions this team controls right now.
    unsigned regions = 0;
};

/// The region-control snapshot §4 calls "current front/control summary".
/// Deliberately three integers rather than the region graph: the browser
/// shows a war's state at a glance, and the full board is what joining is
/// for.
struct WarControlSummary {
    unsigned total = 0;
    unsigned contested = 0;
    /// Regions no team holds.
    unsigned neutral = 0;
};

struct WarSummary {
    int frame = 0;
    int64_t uptimeSec = 0;
    /// Connected clients seated as spectators (§3 — spectators are content,
    /// and "12 watching" is the field that says so).
    unsigned spectators = 0;
    /// In `war_sides` declaration order, so the browser lists a war's sides
    /// the same way every other surface does.
    std::vector<WarSideSummary> sides;
    WarControlSummary control;
};

/// One player row as the sim holds it. A struct rather than the engine's
/// CPlayer so the builder is a pure function of values and testable without a
/// sim (the shape DynamicJoin.h and GameStartCoordinator.h use).
struct WarSummaryPlayer {
    int team = -1;
    bool spectator = false;
    bool isAI = false;
    bool active = false;
};

/// One region's ownership as `game_regions.lua` publishes it: the
/// `region_<key>_team` param (-1 = nobody) and `region_<key>_contested`.
struct WarSummaryRegion {
    int team = -1;
    bool contested = false;
};

/// Build the digest. Pure.
///
/// Sides come from `war_sides` and not from the teams that happen to have
/// players: a side nobody is on is the single most important row in the
/// browser (it is the one with room for you), and a war that lists only its
/// occupied sides hides exactly the wars a player is looking for.
inline WarSummary BuildWarSummary(const WarSides& sides,
                                  const std::vector<WarSummaryPlayer>& players,
                                  const std::vector<WarSummaryRegion>& regions,
                                  int frame, int64_t uptimeSec) {
    WarSummary s;
    s.frame = frame;
    s.uptimeSec = uptimeSec;
    for (const auto& [faction, team] : sides) {
        WarSideSummary side;
        side.team = static_cast<int>(team);
        side.faction = faction;
        s.sides.push_back(std::move(side));
    }
    auto sideFor = [&s](int team) -> WarSideSummary* {
        for (auto& side : s.sides)
            if (side.team == team) return &side;
        return nullptr;
    };
    for (const auto& p : players) {
        if (!p.active) continue;
        // Spectators are counted before the team lookup, not after: a
        // spectator's team is -1 by construction, and counting them per-side
        // would make the seat they do not hold look occupied.
        if (p.spectator) {
            if (!p.isAI) s.spectators++;
            continue;
        }
        if (auto* side = sideFor(p.team)) {
            if (p.isAI) side->ais++;
            else        side->humans++;
        }
    }
    for (const auto& r : regions) {
        s.control.total++;
        if (r.contested) s.control.contested++;
        if (r.team < 0) { s.control.neutral++; continue; }
        if (auto* side = sideFor(r.team)) side->regions++;
    }
    return s;
}

/// Encode for the `war_summary` row. The only writer.
inline std::string EncodeWarSummary(const WarSummary& s) {
    nlohmann::json j;
    j["v"] = kWarSummaryVersion;
    j["frame"] = s.frame;
    j["uptime_sec"] = s.uptimeSec;
    j["spectators"] = s.spectators;
    j["sides"] = nlohmann::json::array();
    for (const auto& side : s.sides) {
        nlohmann::json sj;
        sj["team"] = side.team;
        sj["faction"] = side.faction;
        sj["humans"] = side.humans;
        sj["ais"] = side.ais;
        sj["regions"] = side.regions;
        j["sides"].push_back(std::move(sj));
    }
    j["control"] = {{"total", s.control.total},
                    {"contested", s.control.contested},
                    {"neutral", s.control.neutral}};
    return j.dump();
}

/// Decode a `war_summary` row. The only reader.
///
/// Returns false for anything it cannot vouch for — malformed JSON, a version
/// it does not know, a missing `sides` array. The caller then shows the
/// lobby-derived half alone, which is the same thing it shows for a war whose
/// server is not running, so there is exactly one degraded state to reason
/// about instead of two.
inline bool DecodeWarSummary(const std::string& text, WarSummary& out) {
    const auto j = nlohmann::json::parse(text, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object()) return false;
    if (j.value("v", 0) != kWarSummaryVersion) return false;
    if (!j.contains("sides") || !j["sides"].is_array()) return false;

    WarSummary s;
    s.frame = j.value("frame", 0);
    s.uptimeSec = j.value("uptime_sec", int64_t{0});
    s.spectators = j.value("spectators", 0u);
    for (const auto& sj : j["sides"]) {
        if (!sj.is_object()) continue;
        WarSideSummary side;
        side.team = sj.value("team", -1);
        side.faction = sj.value("faction", std::string{});
        side.humans = sj.value("humans", 0u);
        side.ais = sj.value("ais", 0u);
        side.regions = sj.value("regions", 0u);
        s.sides.push_back(std::move(side));
    }
    if (j.contains("control") && j["control"].is_object()) {
        s.control.total = j["control"].value("total", 0u);
        s.control.contested = j["control"].value("contested", 0u);
        s.control.neutral = j["control"].value("neutral", 0u);
    }
    out = std::move(s);
    return true;
}

/// How old a summary may be and still be shown as live.
///
/// The publisher writes on the 2s status heartbeat, so this is fifteen missed
/// heartbeats — long enough that a loaded machine or a paused sim does not
/// blink the browser, short enough that a killed server stops claiming
/// players are online within half a minute. Task 3's kill-and-resume case is
/// the one this bounds: the row survives the process, and nothing clears it.
inline constexpr int64_t kWarSummaryStaleSec = 30;
