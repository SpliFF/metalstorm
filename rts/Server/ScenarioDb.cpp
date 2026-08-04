// ScenarioDb — implementation. See ScenarioDb.h for the design and for why
// the row is the record of truth and the file a regenerable cache.

#include "ScenarioDb.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "scenario-db"

#include <sqlite3.h>

#include <algorithm>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <unordered_set>

// NOTE: <map> is unusable in rts/ — the include path puts rts/Map/ ahead of
// the standard library on a case-insensitive filesystem, so `#include <map>`
// resolves to the engine's map directory. <unordered_set> below is fine.

namespace fs = std::filesystem;

namespace {

/// Read a TEXT column that may be NULL as a std::string ("" for NULL).
std::string ColText(sqlite3_stmt* stmt, int col) {
    const unsigned char* t = sqlite3_column_text(stmt, col);
    return t ? reinterpret_cast<const char*>(t) : "";
}

/// Fill a Record from a row selected with kSelectColumns, in that order.
ScenarioDb::Record ReadRow(sqlite3_stmt* stmt) {
    ScenarioDb::Record r;
    r.id = ColText(stmt, 0);
    r.gameId = ColText(stmt, 1);
    r.displayName = ColText(stmt, 2);
    r.mapId = ColText(stmt, 3);
    r.seed = sqlite3_column_int64(stmt, 4);
    r.generatorVersion = sqlite3_column_int(stmt, 5);
    r.params = ColText(stmt, 6);
    r.lua = ColText(stmt, 7);
    r.createdBy = ColText(stmt, 8);
    r.createdAt = ColText(stmt, 9);
    return r;
}

// Kept as one string so ReadRow's column indices cannot drift from the query.
const char* const kSelectColumns =
    "id, game_id, display_name, map_id, seed, generator_version, "
    "params, lua, created_by, created_at";

} // namespace

namespace ScenarioDb {

void EnsureTable(sqlite3* db) {
    if (db == nullptr)
        return;

    // A custom raw-string delimiter, not the bare R"( … )": SQL text and a
    // default-delimited raw string have bitten this codebase before, and the
    // sequence that terminates one is common enough in generated SQL that the
    // habit is worth more than the two saved characters.
    const char* sql = R"SQL(
        -- Procedurally generated scenarios (tools/mapgen/scenariogen.py).
        -- `lua` is the record of truth; data/games/<game>/scenarios/<id>.lua
        -- is a cache rebuilt from it by ScenarioDb::SyncToDisk.
        --
        -- `id` is the file stem AND the `scenario` modoption value, so it is
        -- the natural primary key — there is no second identity to keep in
        -- step with it. See ScenarioDb.h on why a duplicate id is an upsert.
        CREATE TABLE IF NOT EXISTS generated_scenarios (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT '',
            map_id TEXT NOT NULL DEFAULT '',
            seed INTEGER NOT NULL DEFAULT 0,
            generator_version INTEGER NOT NULL DEFAULT 0,
            params TEXT NOT NULL DEFAULT '',
            lua TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_generated_scenarios_game
            ON generated_scenarios(game_id);
        CREATE INDEX IF NOT EXISTS idx_generated_scenarios_map
            ON generated_scenarios(game_id, map_id);
    )SQL";

    char* errMsg = nullptr;
    if (sqlite3_exec(db, sql, nullptr, nullptr, &errMsg) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "error creating generated_scenarios: %s",
             errMsg ? errMsg : "(no message)");
        sqlite3_free(errMsg);
        return;
    }

    // Non-destructive migration, `users` pattern (Database.cpp:123-136) rather
    // than the DROP+CREATE that MapMetadataDb/GameServersDb use. Those two
    // tables cache something reprocessable from content/; a row here is the
    // ONLY copy of a generated scenario, and dropping it would break every
    // room whose `scenario` modoption names one. Probe for the newest-added
    // column — ALTER TABLE ADD COLUMN fails when it is already present.
    {
        sqlite3_stmt* stmt = nullptr;
        const int probeRc = sqlite3_prepare_v2(
            db, "SELECT created_by FROM generated_scenarios LIMIT 1", -1,
            &stmt, nullptr);
        sqlite3_finalize(stmt);
        if (probeRc != SQLITE_OK) {
            sqlite3_exec(db,
                         "ALTER TABLE generated_scenarios ADD COLUMN "
                         "created_by TEXT NOT NULL DEFAULT ''",
                         nullptr, nullptr, nullptr);
        }
    }
}

bool Upsert(sqlite3* db, const Record& r) {
    if (db == nullptr || !ValidateId(r.id))
        return false;

    // created_at is preserved across a re-generate: COALESCE against the row
    // already there, so an idempotent re-run does not make a months-old
    // scenario look freshly minted in the admin list.
    const char* sql =
        "INSERT OR REPLACE INTO generated_scenarios "
        "(id, game_id, display_name, map_id, seed, generator_version, "
        " params, lua, created_by, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, "
        "  COALESCE((SELECT created_at FROM generated_scenarios WHERE id = ?), "
        "           CURRENT_TIMESTAMP))";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "upsert prepare failed: %s", sqlite3_errmsg(db));
        return false;
    }

    sqlite3_bind_text(stmt, 1, r.id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, r.gameId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, r.displayName.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, r.mapId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 5, r.seed);
    sqlite3_bind_int(stmt, 6, r.generatorVersion);
    sqlite3_bind_text(stmt, 7, r.params.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 8, r.lua.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 9, r.createdBy.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 10, r.id.c_str(), -1, SQLITE_TRANSIENT);

    const int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE) {
        SLOG(SPRING_LOG_ERROR, "upsert '%s' failed: %s", r.id.c_str(),
             sqlite3_errmsg(db));
        return false;
    }
    return true;
}

std::vector<Record> ListForGame(sqlite3* db, const std::string& gameId) {
    std::vector<Record> out;
    if (db == nullptr)
        return out;

    const std::string sql = std::string("SELECT ") + kSelectColumns +
                            " FROM generated_scenarios WHERE game_id = ? "
                            "ORDER BY id";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    sqlite3_bind_text(stmt, 1, gameId.c_str(), -1, SQLITE_TRANSIENT);
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

std::vector<Record> ListAll(sqlite3* db) {
    std::vector<Record> out;
    if (db == nullptr)
        return out;

    const std::string sql = std::string("SELECT ") + kSelectColumns +
                            " FROM generated_scenarios ORDER BY game_id, id";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

std::optional<Record> FindById(sqlite3* db, const std::string& id) {
    if (db == nullptr || id.empty())
        return std::nullopt;

    const std::string sql = std::string("SELECT ") + kSelectColumns +
                            " FROM generated_scenarios WHERE id = ?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);

    std::optional<Record> out;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        out = ReadRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

bool Delete(sqlite3* db, const std::string& id) {
    if (db == nullptr || id.empty())
        return false;

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, "DELETE FROM generated_scenarios WHERE id = ?",
                           -1, &stmt, nullptr) != SQLITE_OK)
        return false;
    sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    const int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    // sqlite3_changes, not rc: a DELETE that matched nothing is still
    // SQLITE_DONE, and the endpoint needs to answer 404 for that case.
    return rc == SQLITE_DONE && sqlite3_changes(db) > 0;
}

bool ValidateId(const std::string& id) {
    // Long enough to hold prefix + slug + hash with room to spare, short
    // enough that no filesystem rejects the resulting name.
    constexpr size_t kMaxIdLength = 96;

    const size_t prefixLen = std::strlen(kIdPrefix);
    if (id.size() <= prefixLen || id.size() > kMaxIdLength)
        return false;
    if (id.compare(0, prefixLen, kIdPrefix) != 0)
        return false;
    // An allowlist, not a denylist of path characters: `scenario_id()` only
    // ever emits [a-z0-9_], so anything else means the id did not come from
    // the generator and has no business becoming a filename.
    for (const char c : id) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                        c == '_';
        if (!ok)
            return false;
    }
    return true;
}

std::string PathFor(const std::string& gamePath, const std::string& id) {
    if (!ValidateId(id))
        return {};
    return (fs::path(gamePath) / "scenarios" / (id + ".lua")).string();
}

bool Materialise(const Record& r, const std::string& gamePath) {
    const std::string path = PathFor(gamePath, r.id);
    if (path.empty()) {
        SLOG(SPRING_LOG_WARNING,
             "refusing to materialise '%s': not a valid generated scenario id",
             r.id.c_str());
        return false;
    }

    std::error_code ec;
    fs::create_directories(fs::path(gamePath) / "scenarios", ec);

    // Temp file + rename. `Discover` and the game server can both be reading
    // this directory while we write; a truncated file parses as garbage and
    // would drop the scenario out of the lobby with a warning blaming the
    // content instead of the race.
    const std::string tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (!f) {
            SLOG(SPRING_LOG_ERROR, "cannot open '%s' for writing", tmp.c_str());
            return false;
        }
        f.write(r.lua.data(), static_cast<std::streamsize>(r.lua.size()));
        f.close();
        if (!f) {
            SLOG(SPRING_LOG_ERROR, "write failed for '%s'", tmp.c_str());
            fs::remove(tmp, ec);
            return false;
        }
    }
    fs::rename(tmp, path, ec);
    if (ec) {
        SLOG(SPRING_LOG_ERROR, "rename '%s' -> '%s' failed: %s", tmp.c_str(),
             path.c_str(), ec.message().c_str());
        fs::remove(tmp, ec);
        return false;
    }
    return true;
}

bool Unmaterialise(const std::string& id, const std::string& gamePath) {
    const std::string path = PathFor(gamePath, id);
    if (path.empty())
        return false;
    std::error_code ec;
    return fs::remove(path, ec);
}

SyncResult SyncToDisk(sqlite3* db, const std::string& gameId,
                      const std::string& gamePath) {
    SyncResult out;

    const std::vector<Record> rows = ListForGame(db, gameId);

    std::unordered_set<std::string> claimed;
    for (const auto& r : rows) {
        if (Materialise(r, gamePath)) {
            claimed.insert(r.id + ".lua");
            ++out.written;
        } else {
            ++out.failed;
        }
    }

    // Orphan sweep. Only `gen_*.lua` is ever considered, so an authored
    // scenario cannot be collected however wrong the table is — which matters
    // because this runs unattended at every lobby start.
    std::error_code ec;
    const fs::path dir = fs::path(gamePath) / "scenarios";
    if (fs::is_directory(dir, ec)) {
        std::vector<fs::path> doomed;
        for (const auto& entry : fs::directory_iterator(dir, ec)) {
            if (ec)
                break;
            if (!entry.is_regular_file(ec))
                continue;
            const fs::path& p = entry.path();
            if (p.extension() != ".lua")
                continue;
            const std::string stem = p.stem().string();
            if (!ValidateId(stem))
                continue;  // authored content, or a name we did not mint
            if (claimed.count(p.filename().string()) == 0)
                doomed.push_back(p);
        }
        // Collected after the walk, not during it: erasing from under a
        // directory_iterator is unspecified.
        for (const auto& p : doomed) {
            if (fs::remove(p, ec)) {
                ++out.orphansRemoved;
                SLOG(SPRING_LOG_INFO,
                     "removed orphaned generated scenario '%s' (no row owns it)",
                     p.filename().string().c_str());
            }
        }
    }

    if (out.written > 0 || out.orphansRemoved > 0 || out.failed > 0) {
        SLOG(SPRING_LOG_INFO,
             "game '%s': materialised %d generated scenario(s), removed %d "
             "orphan(s), %d failure(s)",
             gameId.c_str(), out.written, out.orphansRemoved, out.failed);
    }
    return out;
}

std::string DisambiguateDisplayName(sqlite3* db, const std::string& gameId,
                                    const std::string& desired,
                                    const std::string& ownId) {
    if (db == nullptr || desired.empty())
        return desired;

    const char* sql =
        "SELECT COUNT(*) FROM generated_scenarios "
        "WHERE game_id = ? AND display_name = ? AND id <> ?";

    const auto taken = [&](const std::string& candidate) {
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
            return false;
        sqlite3_bind_text(stmt, 1, gameId.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 2, candidate.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 3, ownId.c_str(), -1, SQLITE_TRANSIENT);
        bool used = false;
        if (sqlite3_step(stmt) == SQLITE_ROW)
            used = sqlite3_column_int(stmt, 0) > 0;
        sqlite3_finalize(stmt);
        return used;
    };

    if (!taken(desired))
        return desired;

    // Bounded: past a couple of dozen identically-titled wars on one map the
    // suffix has stopped being informative anyway, and an unbounded loop here
    // would be a denial of service on a table an admin controls.
    for (int n = 2; n <= 64; ++n) {
        const std::string candidate = desired + " (" + std::to_string(n) + ")";
        if (!taken(candidate))
            return candidate;
    }
    return desired;
}

} // namespace ScenarioDb
