// ScenarioDb — SQLite storage for procedurally generated scenarios
// (tools/mapgen/scenariogen.py), plus the materialisation that makes a stored
// row visible to the two consumers that can only read the filesystem.
//
// WHY A DB ROW IS NOT ENOUGH, AND WHY A FILE IS NOT ENOUGH EITHER.
// Two existing consumers read scenarios off disk and neither can be handed a
// database:
//
//   * `ScenarioDiscovery::Discover(gamePath)` iterates `<game>/scenarios/*.lua`
//     and parses each with a bare `lua_State`. It is what the lobby's Create
//     Game picker is built from.
//   * The sim loads a scenario BY FILENAME — `game_scenario.lua:602` does
//     `VFS.Include('scenarios/' .. name .. '.lua')` with the `scenario`
//     modoption. There is no hook there for a row.
//
// So a scenario that exists only as a row is invisible in the lobby and
// unloadable by the sim. Conversely a scenario that exists only as a file is
// indistinguishable from authored content, has no record of the seed and knobs
// that produced it, and cannot survive a `data/` wipe (which is routine — the
// whole tree is gitignored).
//
// THE SPLIT. The ROW is the record of truth; the FILE is a regenerable cache.
// `SyncToDisk` rebuilds every file from its row, so deleting the entire
// `scenarios/gen_*.lua` set and re-running it is a no-op — that is a test
// (tests/test_scenario_db.cpp), not an aspiration. Ingest writes the row and
// then materialises; deletion removes the row and then the file.
//
// WHY FLAT `gen_*.lua` AND NOT A `generated/` SUBDIRECTORY. Settled in commit
// 23e075d41d and restated here because it is the constraint that kills the
// obvious alternative: `Discover` uses a NON-recursive `directory_iterator`, so
// a file one level down is never found; and the file stem has to remain a valid
// `scenario` modoption, which a path separator would break. A `gen_` prefix
// gives the same two properties a subdirectory was wanted for — a gitignore
// pattern (`/data/games/metalstorm/scenarios/gen_*.lua`) and a sweep that
// provably cannot touch an authored scenario — without moving the file
// somewhere neither consumer looks.
//
// COLLISIONS. `scenariogen.py`'s id is `gen_<map-slug>_<hash(map|seed|version)>`
// and generation is deterministic, so the same (map, seed, version) yields the
// same id AND byte-identical Lua. Re-generating is therefore an idempotent
// upsert rather than a conflict — see `Upsert`. Display names are NOT unique
// (the generator's suffix table is indexed `seed % len`), so two different seeds
// on one map can mint the same title; `DisambiguateDisplayName` handles that so
// the picker never shows two identical rows.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

struct sqlite3;

namespace ScenarioDb {

/// The id prefix every generated scenario carries. Load-bearing in three
/// places: the gitignore pattern, the orphan sweep's "is this file mine?"
/// test, and `ValidateId` — which is what stops an ingest from overwriting an
/// authored `scenarios/meridian_basin.lua`.
inline constexpr const char* kIdPrefix = "gen_";

/// One stored scenario. `lua` is the record of truth — everything else is
/// either provenance (how to reproduce it) or a denormalised copy of something
/// the Lua already says, kept so the admin list can be rendered without
/// parsing every row.
struct Record {
    /// `gen_<slug>_<hash>` — the file stem, and therefore also the `scenario`
    /// modoption value. Primary key.
    std::string id;

    /// The game whose `scenarios/` directory this materialises into.
    std::string gameId;

    /// The generator's minted title, e.g. "Ashen Reach — Standard War". Copied
    /// from the Lua's `name` field at ingest, possibly with a disambiguating
    /// suffix (see `DisambiguateDisplayName`). The lobby does NOT read this to
    /// build the picker — it re-parses the materialised file, so the picker can
    /// never disagree with what the sim will load — but the admin list does.
    std::string displayName;

    /// `world.map`. Denormalised for the admin list and for `ListForMap`.
    std::string mapId;

    /// The seed passed to scenariogen.py. With `mapId` and `generatorVersion`
    /// this is the complete input needed to reproduce `lua` byte for byte.
    int64_t seed = 0;

    /// scenariogen.py's `GENERATOR_VERSION` at the time of generation. Part of
    /// the id hash, so a version bump mints a new id rather than silently
    /// changing what an existing id means.
    int generatorVersion = 0;

    /// The generator knobs as a JSON object (`{"sides":2,"towns":3,...}`).
    /// Opaque to the server — stored so a row can be regenerated, and shown in
    /// the admin list.
    std::string params;

    /// The complete scenario source. This is the thing that is authoritative;
    /// the file on disk is a copy of it.
    std::string lua;

    /// Username of the admin who ingested it, for the audit trail.
    std::string createdBy;

    /// SQLite CURRENT_TIMESTAMP at insert.
    std::string createdAt;
};

/// Ensure the `generated_scenarios` table exists at the current schema.
///
/// Unlike `MapMetadataDb::EnsureTable` / `GameServersDb::EnsureTables`, a stale
/// schema here is MIGRATED, never dropped: those two tables are caches of
/// something reprocessable from `content/`, whereas a row here is the only copy
/// of a generated scenario — dropping the table would destroy wars players may
/// already have rooms pointing at. So this follows the `users` pattern
/// (Database.cpp:123-136): probe for the newest column, `ALTER TABLE ADD
/// COLUMN` when it is missing.
void EnsureTable(sqlite3* db);

/// Insert or replace `r` by id.
///
/// REPLACE rather than a conflict because of determinism: an id encodes
/// (map, seed, generator version), and those three inputs always produce the
/// same Lua. So "this id already exists" means "you generated the same
/// scenario twice", and the honest answer is to keep one row, not to raise an
/// error the caller can only resolve by ignoring it. Returns false on a real
/// SQLite failure.
bool Upsert(sqlite3* db, const Record& r);

/// Every stored scenario for `gameId`, ordered by id so the ordering matches
/// `ScenarioDiscovery::Discover`'s.
std::vector<Record> ListForGame(sqlite3* db, const std::string& gameId);

/// Every stored scenario, all games, ordered by (game_id, id).
std::vector<Record> ListAll(sqlite3* db);

/// One row by id, or nullopt.
std::optional<Record> FindById(sqlite3* db, const std::string& id);

/// Delete the row for `id`. Returns true when a row was actually removed, so
/// the caller can distinguish "deleted" from "was not there" — the delete
/// endpoint reports 404 for the latter rather than a misleading success.
bool Delete(sqlite3* db, const std::string& id);

/// True when `id` is safe to use as a `scenarios/<id>.lua` filename AND is
/// recognisably ours.
///
/// Three separate jobs, all required:
///   1. Path safety. The id is concatenated into a filesystem path and into
///      `VFS.Include('scenarios/' .. id .. '.lua')`. `/`, `\` and `..` are
///      rejected; so is everything outside `[a-z0-9_]`, which is stricter than
///      strictly necessary and deliberately so — `scenario_id()` only ever
///      emits that set.
///   2. Ownership. Must start with `kIdPrefix`, so an ingest can never write
///      over an authored scenario, and so the orphan sweep can tell its own
///      files from content that belongs in git.
///   3. Length, so a pathological id cannot produce a filename the filesystem
///      rejects halfway through a write.
bool ValidateId(const std::string& id);

/// The absolute-or-relative path a record materialises to:
/// `<gamePath>/scenarios/<id>.lua`. Returns "" for an id `ValidateId` rejects,
/// so a caller that forgets to validate still cannot escape the directory.
std::string PathFor(const std::string& gamePath, const std::string& id);

/// Write `r.lua` to `PathFor(gamePath, r.id)`, creating `scenarios/` if
/// needed. Returns false on a rejected id or an IO failure.
///
/// The write is atomic (temp file + rename) because `Discover` and the sim can
/// both be reading this directory while it happens — a half-written scenario
/// would parse as garbage and drop out of the lobby with a warning that points
/// at the content rather than at the race.
bool Materialise(const Record& r, const std::string& gamePath);

/// Remove `PathFor(gamePath, id)`. Returns true when a file was removed.
bool Unmaterialise(const std::string& id, const std::string& gamePath);

/// Result of a `SyncToDisk` pass, for logging.
struct SyncResult {
    /// Files written (every row for the game — the rebuild is unconditional,
    /// see the note on SyncToDisk).
    int written = 0;
    /// `gen_*.lua` files removed because no row claimed them.
    int orphansRemoved = 0;
    /// Rows whose file could not be written.
    int failed = 0;
};

/// Rebuild `<gamePath>/scenarios/` from the rows for `gameId`: write every
/// row's Lua, then delete every `gen_*.lua` no row claims.
///
/// Unconditional rewrite rather than a mtime/hash comparison. The rows are few
/// and small, and the failure this prevents — a file edited by hand or
/// truncated by a crash, silently diverging from the row that is supposed to
/// define it — is exactly the kind that surfaces as an unreproducible war.
/// Rewriting is also what makes "delete every file, re-sync, compare" a
/// meaningful test of the round trip.
///
/// The sweep only ever considers files matching `kIdPrefix`, so an authored
/// scenario cannot be collected no matter what the table contains. Called at
/// lobby startup (before discovery) and after every ingest/delete.
SyncResult SyncToDisk(sqlite3* db, const std::string& gameId,
                      const std::string& gamePath);

/// A display name for `desired` that no OTHER row of `gameId` already uses.
///
/// The generator picks its suffix as `SCENARIO_SUFFIXES[seed % len]`, so two
/// seeds on one map collide roughly one time in `len`. The picker is a flat
/// `<option>` list keyed by nothing the player can see, so two identical
/// titles are genuinely ambiguous there. Appends ` (2)`, ` (3)`, … until free.
///
/// A row that already holds `desired` under its OWN id is not a collision —
/// re-generating the same scenario must be idempotent, not a name-inflating
/// ratchet that turns "Ashen Reach — Standard War" into "… (7)" over seven
/// re-runs.
std::string DisambiguateDisplayName(sqlite3* db, const std::string& gameId,
                                    const std::string& desired,
                                    const std::string& ownId);

} // namespace ScenarioDb
