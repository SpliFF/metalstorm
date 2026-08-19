// WorldDirector — the lobby-side service that owns the WORLD (the persistent
// strategic layer above battles).
//
// PLAN-worldsim.md W1. Design: PLAN-metalstorm-worldbuilding.md §"World
// structure — the strategic map / battle split" and §"The strategic map"
// (Capture 10 + Capture 11).
//
// ── The one rule, and the boundary it draws ────────────────────────────────
// The World Director is the War Director *promoted*: a lobby-side object that
// **never touches sim state**. So, like WarDirector, this whole file is
// SQLite plus arithmetic, and it is testable headless.
//
// The boundary that matters most, because getting it wrong silently corrupts
// both layers: **every `war*` table is keyed by `room_id` and describes ONE
// BATTLE.** A war is an event; a world is the persistent thing the event
// happens inside. Nothing here reads, writes or extends a `war*` table, and
// no world column is keyed by a room. The seam between the layers (staging,
// escrow, settlement write-back) is W6 and later, and it will be a NEW
// world-scoped row written at battle end — never a war row re-interpreted as
// world state.
//
// ── What a world is, as rows ───────────────────────────────────────────────
//   `worlds`             one row per persistent world: its clock definition
//                        (epoch + ratio) and its tunables blob.
//   `world_pois`         Capture 10's points of interest — the world map is a
//                        map of EARTH and playable regions are POIs on it, so
//                        a POI carries lat/lon and (optionally) the battle map
//                        based around it. A POI with no map is legal: "not all
//                        regions will be visitable".
//   `world_poi_edges`    strategic movement is BETWEEN POIs, so the world is a
//                        graph and transit time is an edge weight — in WORLD
//                        ms, because that is the clock a march is measured on.
//   `world_pause_ledger` Capture 11's admin global pause, as intervals. The
//                        clock is computed from them (WorldClock.h); pausing
//                        is a row, not a stopped process.
//
// All four are keyed by `world_id` (TEXT — worlds are named, not numbered, and
// a name is what the UI and the operator both use). Migration is ADDITIVE
// only, never probe-and-drop: a row here is the only copy of the world.
//
// ── Numbers are data (pillar 7) ────────────────────────────────────────────
// Nothing in the .cpp may bake a rate into an expression. The time ratio is a
// pair of columns; everything else a world can be tuned by lives in
// `worlds.config_json` (and per-POI/per-edge `config_json`), with the defaults
// gathered in `WorldDefaults` below so a seeder has one place to read them
// from. W3's dynamic POI count and W4's pause policy add keys to that blob;
// they do not add literals to the code.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "WorldClock.h"

struct sqlite3;

/// The default world every lobby seeds on first boot if it has no world at
/// all. Capture 10: the core map is Earth — hence the id.
inline constexpr const char* kDefaultWorldId   = "earth";
inline constexpr const char* kDefaultWorldName = "Earth";

/// Ship-with defaults for the per-world tunables blob. These are the values
/// written into a NEW world's `config_json`; an existing world's row is the
/// authority afterwards, which is what makes them tunable without a rebuild.
///
/// Kept as a struct rather than loose constants so the seeder writes one
/// object and a later milestone can add a key in exactly one place.
struct WorldDefaults {
    /// Capture 10: POI count scales with world age / player count. W1 only
    /// records the knobs; W3's seeder is what honours them.
    int    poiBudgetInitial      = 8;
    int    poiBudgetMax          = 64;
    /// Real days of world age per additional POI slot.
    double poiPerWorldAgeDay     = 0.5;
    /// Additional POI slots per registered player.
    double poiPerRegisteredPlayer = 0.25;
    /// W3 turns a great-circle distance into an edge weight with this: world
    /// ms of transit per kilometre.
    double transitWorldMsPerKm   = 60000.0;

    nlohmann::json ToJson() const;
};

/// A `worlds` row.
struct WorldRecord {
    std::string worldId;
    std::string name;
    /// "active" | "archived". A PAUSED world is not a state here — pause is
    /// the ledger, and asking the row would give two answers that can differ.
    std::string state = "active";
    WorldClockConfig clock;
    int64_t     createdAt = 0;
    /// Per-world tunables (see WorldDefaults). Opaque to this file beyond
    /// being valid JSON: a world may carry keys this build has never heard of.
    nlohmann::json config = nlohmann::json::object();
};

/// A `world_pois` row — one point of interest on the Earth map.
struct WorldPoiRecord {
    std::string worldId;
    std::string poiId;
    std::string name;      ///< the "Randtown" register: a post-collapse name
    double      lat = 0.0;
    double      lon = 0.0;
    std::string kind = "region";
    /// The battle map based around this POI, or empty — "not all regions will
    /// be visitable", so a world-only POI is a legal, expected row.
    std::string mapId;
    std::vector<std::string> tags;
    int64_t     createdAt = 0;
    nlohmann::json config = nlohmann::json::object();

    bool HasBattleMap() const { return !mapId.empty(); }
};

/// A `world_poi_edges` row — a transit link. Weight is in WORLD ms because a
/// march is measured on the world clock, not on wall time.
struct WorldPoiEdgeRecord {
    std::string worldId;
    std::string fromPoi;
    std::string toPoi;
    int64_t     transitWorldMs = 0;
    std::string kind = "transit";
    /// Stored on one row rather than as two mirrored rows, so that widening a
    /// route cannot update one direction and miss the other.
    bool        bidirectional = true;
    nlohmann::json config = nlohmann::json::object();
};

/// The durable half. Static, like WarDirector: there is no per-instance state
/// to hold, and the handle is the lobby's shared one.
class WorldDirector {
public:
    /// Create the four tables if absent. ADDITIVE migration only — see the
    /// header note: these rows are the only copy of the world.
    static void EnsureTables(sqlite3* db);

    /// Seed `kDefaultWorldId` if the database has NO world at all, and return
    /// the id of the world the lobby should serve.
    ///
    /// Guarded on "no worlds exist" rather than "this id is missing", so that
    /// an operator who renamed or archived the starting world does not get it
    /// silently recreated on the next restart. Idempotent: calling it on every
    /// boot must never rewrite an existing world's epoch — that would move the
    /// world clock, which is the one number nothing may retroactively change.
    static std::string SeedDefaultWorld(sqlite3* db, int64_t nowRealMs);

    static bool Upsert(sqlite3* db, const WorldRecord& w);
    static std::optional<WorldRecord> Load(sqlite3* db, const std::string& worldId);
    static std::vector<WorldRecord> ListWorlds(sqlite3* db);

    /// The id `GET /api/world` answers for when no `?world=` is given: the
    /// oldest active world. Empty if the database has none.
    static std::string PrimaryWorldId(sqlite3* db);

    static bool UpsertPoi(sqlite3* db, const WorldPoiRecord& poi);
    static std::vector<WorldPoiRecord> PoisFor(sqlite3* db, const std::string& worldId);
    static std::optional<WorldPoiRecord> LoadPoi(sqlite3* db,
                                                 const std::string& worldId,
                                                 const std::string& poiId);

    static bool UpsertEdge(sqlite3* db, const WorldPoiEdgeRecord& edge);
    static std::vector<WorldPoiEdgeRecord> EdgesFor(sqlite3* db, const std::string& worldId);

    // ── The pause ledger (Capture 11) ──────────────────────────────────────
    // W1 ships the STORE and the arithmetic; the admin route that calls these
    // is W4 (and the battle half of a global pause — orchestrating
    // `/api/gm/pause` over every running game server — is explicitly not here).

    /// Open a pause interval. Returns false if one is already open: a pause is
    /// a state, not a counter, and two open intervals would make "resume"
    /// ambiguous.
    static bool OpenPause(sqlite3* db, const std::string& worldId, int64_t nowRealMs,
                          const std::string& reason, const std::string& actor);
    /// Close the open interval. Returns false if none was open.
    static bool ClosePause(sqlite3* db, const std::string& worldId, int64_t nowRealMs);
    static std::vector<WorldPauseInterval> PausesFor(sqlite3* db, const std::string& worldId);

    /// The world clock right now, for `worldId`. Reads the row and the ledger,
    /// then defers entirely to `ReadWorldClock` — no arithmetic lives here.
    static std::optional<WorldClockReading> ClockFor(sqlite3* db,
                                                    const std::string& worldId,
                                                    int64_t nowRealMs);

    // ── The read-only HTTP surface, as data ────────────────────────────────
    // The route handlers in lobby_main are thin wrappers around these two, so
    // that the RESPONSE BODY is testable without a socket, a lobby or a
    // network thread — the same trick that makes the war seed boot-call
    // testable in WarDirector.

    /// `GET /api/world` — clock + meta for one world.
    static nlohmann::json WorldStatusJson(sqlite3* db, const std::string& worldId,
                                          int64_t nowRealMs);
    /// `GET /api/world/pois` — nodes + edges.
    static nlohmann::json WorldPoisJson(sqlite3* db, const std::string& worldId);
};
