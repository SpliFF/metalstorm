// WorldStaging — PLAN-worldsim.md W10: battle triggers from the map.
//
// Design sources, all three of which this file is the join of:
//   - PLAN-metalstorm-worldbuilding.md Capture 28 + §"Battle Staging": a
//     battle exists as a WORLD EVENT before it starts. While the committed
//     force is in transit the battle is "in staging"; the attacker's
//     world-days in transit are the defender's real hours of warning, and the
//     scenario materialises AT STAGING END, from world state.
//   - PLAN-metalstorm-transports.md §7.1 (the instigation rule): "a battle
//     opens when a faction commits at least one transport carrying at least
//     one squad to a POI it does not hold". The defender needs no transport —
//     it is home.
//   - PLAN-metalstorm-transports.md §7.2: the world layer may commit late
//     forces DURING the staging window only; commitment closes when the
//     battle starts.
//
// ── What this file is, and what it deliberately is not ─────────────────────
// It is the world-layer OBJECT: one `world_staging` row per gathering battle,
// its window sized from the POI edge transit weights, plus the pure policy
// that decides whether a commitment is an instigation and how long its window
// is. It owns no war, spawns no process and knows no room.
//
// **It does not create wars.** W10's materialisation runs through the EXISTING
// lobby war-creation machinery (`demandSeedWar` in rts/lobby_main.cpp →
// `PlanWarSeed` → `BuildWarBootManifest` → `runDirectStart`), constrained to
// the POI's battle map. There is exactly one room-creation path in this
// program and the world layer joins it at the call site, per the W6 precedent
// (WorldDirector.h's note: the lobby's sweep is the one place that holds both
// a world handle and a war handle). This file's half of that seam is
// `DueStagings` (what is ready) and `MarkMaterialised`/`MarkFailed` (what
// happened) — two reads and two writes, no war vocabulary in either.
//
// ── The marker states W5 promised ──────────────────────────────────────────
// W5 shipped quiet/staging/active but only two of them could ever occur: a
// POI was "staging" solely because a war row already existed in `Seeding`/
// `Open`, i.e. because somebody had already created the battle by hand. W10
// is what makes the FIRST state real — a POI is `staging` because the world
// says a force is inbound, before any room exists. `AttachStaging` upgrades
// the W5 body accordingly and never downgrades it: a POI with a live battle
// stays `active` even while a second force gathers against it.
//
// ── Numbers are data (pillar 7) ────────────────────────────────────────────
// Window length, its clamps and the retry budget are keys in the world's
// `config_json`, defaulted in `WorldDefaults` (WorldDirector.h) and resolved
// per key by `WorldStagingRules::FromWorldConfig` — same discipline as every
// other rate family in this layer. Q16 ("minimum/maximum staging durations
// (config, pillar 7)") is answered here and nowhere else.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "WorldDirector.h"

struct sqlite3;

// ─────────────────────────── the per-world rates ───────────────────────────

/// Every number W10 uses, resolved for ONE world.
struct WorldStagingRules {
    /// The window a commitment gets when no transit edge can price it — an
    /// unconnected POI, or a first commitment from nowhere in particular.
    /// World ms, so it is read on the same clock the edge weights are.
    double stagingWindowDefaultWorldMs = 12.0 * 3600.0 * 1000.0;  // 12 world hours
    /// §7.4's model in one knob: the window is the edge's transit weight
    /// times this. 1.0 means "the window IS the transit time", which is the
    /// design's literal statement; the knob exists because the warning length
    /// is the game's central async-fairness lever (§"Battle Staging") and
    /// tuning it must not mean re-weighting the whole POI graph.
    double stagingWindowPerTransitMs   = 1.0;
    /// Q16's floor and ceiling. The floor stops a dense cluster of near POIs
    /// from producing a no-warning attack (warning IS the mechanic); the
    /// ceiling stops an intercontinental edge from parking a battle a
    /// fortnight out where nobody will remember it.
    double stagingWindowMinWorldMs     = 1.0 * 3600.0 * 1000.0;   // 1 world hour
    double stagingWindowMaxWorldMs     = 72.0 * 3600.0 * 1000.0;  // 3 world days
    /// How many times materialisation may fail before the row is given up on.
    /// A failure is usually transient (the seed cooldown, a game server that
    /// could not boot), so the row retries on the next sweep; it must not
    /// retry forever, because a POI whose map no scenario fields would spin
    /// on every tick for the life of the world.
    int    materialiseMaxAttempts      = 5;

    static WorldStagingRules FromWorldConfig(const nlohmann::json& worldConfig);
};

// ─────────────────────────── the rows ──────────────────────────────────────

/// `world_staging.state`. Four values, and the two terminal ones are kept
/// apart on purpose: "this became a battle" and "this never could" are
/// different facts about the world and a player is owed the difference.
enum class WorldStagingState : uint8_t {
    Staging,       ///< the window is open; force may still be committed (§7.2)
    Materialised,  ///< the window closed and a war was created for it
    Cancelled,     ///< withdrawn before contact
    Failed,        ///< the window closed and no war could be created
};

const char* WorldStagingStateToString(WorldStagingState s);
WorldStagingState WorldStagingStateFromString(const std::string& s);

/// One gathering battle.
struct WorldStagingRecord {
    /// The row's own identity. Two forces may gather against one POI at once
    /// (two attackers, or one attacker in two waves from different origins),
    /// so `(world_id, poi_id)` is emphatically NOT a key here.
    int64_t     stagingId = 0;
    std::string worldId;
    /// The POI being attacked — the battle's place, and the map it will be
    /// fought on (`world_pois.map_id`).
    std::string poiId;
    /// The world faction that committed the force. Not an account: a
    /// commitment is a faction's act even when one player clicked it, and the
    /// battle side that materialises is the faction's `side_key`.
    std::string attackerFactionId;
    /// Where the force set out from, or empty when the committer did not name
    /// one. Only ever used to PRICE the window (the edge weight); the world
    /// layer does not simulate the march.
    std::string originPoiId;
    /// §7.1's instigation test, as counted force. Squads ride transports;
    /// both must be non-zero for the commitment to open a battle at all.
    int         transports = 0;
    int         squads     = 0;
    /// The account that committed, as a label for the UI and the alert list.
    int64_t     committedByAccountId = 0;

    WorldStagingState state = WorldStagingState::Staging;
    /// The window, on the WORLD clock — the only clock a march is measured
    /// on (WorldDirector.h's edge-weight note).
    int64_t     openedAtWorldMs = 0;
    int64_t     endsAtWorldMs   = 0;
    /// Materialisation bookkeeping. `roomId` is a LABEL, exactly as it is in
    /// `world_settlement_ledger` (W6): rooms are reused, so it is never a
    /// join key back into a `war*` table.
    uint32_t    roomId   = 0;
    int         attempts = 0;
    std::string lastError;
    int64_t     createdAt  = 0;
    int64_t     resolvedAt = 0;

    bool IsOpen() const { return state == WorldStagingState::Staging; }
};

/// What a caller asks for. Deliberately a struct rather than eight arguments:
/// a later milestone adds carrier class and cargo manifest to it, and the
/// route handler should not have to change shape when it does.
struct WorldStagingCommitRequest {
    std::string worldId;
    std::string poiId;
    std::string attackerFactionId;
    std::string originPoiId;
    int         transports = 0;
    int         squads     = 0;
    int64_t     accountId  = 0;
};

/// What came back. `error` is a stable machine token the route maps to a
/// status code, in the same idiom `WorldFactionFoundResult` uses.
struct WorldStagingCommitResult {
    bool        ok = false;
    /// "no_world" | "no_poi" | "no_faction" | "no_transport" | "no_squads" |
    /// "already_held" | "no_battle_map" | "db_error"
    std::string error;
    /// True when the commitment JOINED an already-open staging rather than
    /// opening one (§7.2's late commitment). The window does not move.
    bool        joined = false;
    WorldStagingRecord staging;
};

// ─────────────────────────── pure policy ───────────────────────────────────

/// §7.1's instigation rule, as a predicate over already-loaded facts. Pure so
/// the rule is testable without a database and stated in exactly one place:
/// at least one transport, carrying at least one squad, at a POI the faction
/// does not hold. Returns an empty string when the commitment instigates, or
/// the machine token for why it does not.
std::string StagingInstigationError(int transports, int squads,
                                    const std::string& attackerFactionId,
                                    const std::string& poiOwnerFactionId);

/// The window a commitment gets, in world ms: the transit weight of the edge
/// it travels, scaled and clamped by the rules. `transitWorldMs <= 0` means
/// "no edge priced it" and yields the default (itself clamped, so a
/// misconfigured default cannot escape Q16's bounds).
int64_t StagingWindowFor(int64_t transitWorldMs, const WorldStagingRules& rules);

/// The cheapest edge weight from any POI in `heldOrOrigin` to `poiId`, or 0
/// when none of them touch it. Pure over an already-loaded edge list — the
/// same "arithmetic on two loaded lists" discipline WorldWarLinkage.h keeps.
/// Undirected edges count in both directions; a directed edge counts only
/// from → to, because a one-way route is one way for a march too.
int64_t CheapestTransitTo(const std::vector<WorldPoiEdgeRecord>& edges,
                          const std::vector<std::string>& fromPois,
                          const std::string& poiId);

// ─────────────────────────── the store ────────────────────────────────────

/// Static, like every other director in this layer.
class WorldStaging {
public:
    /// Create `world_staging`. ADDITIVE only.
    static void EnsureTables(sqlite3* db);

    /// Commit force at a POI (§7.1). Opens a staging row, or joins the
    /// faction's already-open one at that POI and adds the force to it.
    ///
    /// Joining rather than opening a second row is §7.2 read literally: late
    /// force is committed INTO the window, and the window does not move —
    /// otherwise an attacker could hold a defender in permanent staging by
    /// dripping one transport in at a time, which is exactly the "no perfect
    /// surprise" mechanic inverted into a grief.
    static WorldStagingCommitResult Commit(sqlite3* db,
                                           const WorldStagingRules& rules,
                                           const WorldStagingCommitRequest& req,
                                           int64_t nowWorldMs, int64_t nowRealMs);

    static std::optional<WorldStagingRecord> Load(sqlite3* db, int64_t stagingId);
    /// Every open row for a world, oldest window-end first.
    static std::vector<WorldStagingRecord> OpenFor(sqlite3* db,
                                                   const std::string& worldId);
    /// Every row for a world including resolved ones, newest first — the
    /// history a POI panel shows.
    static std::vector<WorldStagingRecord> AllFor(sqlite3* db,
                                                  const std::string& worldId);

    /// Open rows whose window has closed at `nowWorldMs` and which have not
    /// exhausted their retry budget. This is the materialisation queue the
    /// lobby sweep drains; it is a READ, so a sweep that crashes mid-drain
    /// simply sees the same rows again next time.
    static std::vector<WorldStagingRecord> DueStagings(sqlite3* db,
                                                       const std::string& worldId,
                                                       const WorldStagingRules& rules,
                                                       int64_t nowWorldMs);

    /// The window closed and `roomId` is the war that opened for it.
    static bool MarkMaterialised(sqlite3* db, int64_t stagingId, uint32_t roomId,
                                 int64_t nowRealMs);
    /// One materialisation attempt failed. Increments `attempts` and records
    /// `reason`; flips the row to `Failed` once the budget is spent, so a
    /// permanently unstageable POI stops being retried every sweep.
    static bool MarkAttemptFailed(sqlite3* db, int64_t stagingId,
                                  const std::string& reason,
                                  const WorldStagingRules& rules,
                                  int64_t nowRealMs);
    /// Withdrawal before contact (§7.2's residual, and the operator's escape
    /// hatch). Only an open row can be cancelled.
    static bool Cancel(sqlite3* db, int64_t stagingId, int64_t nowRealMs);

    // ── the read-only surface, as data ─────────────────────────────────────

    /// Merge staging onto the `GET /api/world/pois` body, on top of W5's
    /// `AttachBattleStatus` and W7's `AttachFactions`. Every POI gains a
    /// `staging` array (open rows only, each with its attacker, its committed
    /// force and its remaining world ms), and a POI whose W5 status is
    /// `quiet` while a force gathers becomes `staging`.
    ///
    /// Never downgrades: an `active` POI stays active. The two facts are
    /// independent — a battle can be fought at a POI while the next force is
    /// already inbound — and the marker shows the more urgent of them.
    static nlohmann::json AttachStaging(nlohmann::json poisJson, sqlite3* db,
                                        const std::string& worldId,
                                        int64_t nowWorldMs);

    /// One staging row as JSON, in the shape `AttachStaging` embeds.
    static nlohmann::json StagingJson(const WorldStagingRecord& r,
                                      int64_t nowWorldMs);
};
