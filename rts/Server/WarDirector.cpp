#include "WarDirector.h"

#include <algorithm>
#include <sqlite3.h>

#include "SqliteThreading.h"

#include <nlohmann/json.hpp>

namespace {

// Bind a std::string as transient — sqlite copies, so the source can go out
// of scope. Same helper (and reason) as WarPlayerBindings.cpp's.
void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

std::string ColText(sqlite3_stmt* s, int idx) {
    if (const unsigned char* u = sqlite3_column_text(s, idx))
        return reinterpret_cast<const char*>(u);
    return {};
}

const char* kWarColumns =
    "room_id, name, theatre, scenario, state, origin, season_id, "
    "created_at, retired_at, last_active_frame, spawned_slot_cap";

WarRecord ReadWarRow(sqlite3_stmt* s) {
    WarRecord w;
    w.roomId   = static_cast<uint32_t>(sqlite3_column_int64(s, 0));
    w.name     = ColText(s, 1);
    w.theatre  = ColText(s, 2);
    w.scenario = ColText(s, 3);
    // An unparseable stored state is read as Archived, not as Seeding. A row
    // this build cannot understand must not be offered to a joiner as a live
    // war — the same fail-closed choice `ParseWarSides` makes when it refuses
    // to invent `{0, 1}` for a spec it could not read.
    w.state    = WarStateFromString(ColText(s, 4)).value_or(WarState::Archived);
    w.origin   = WarOriginFromString(ColText(s, 5)).value_or(WarOrigin::Operator);
    w.seasonId = ColText(s, 6);
    w.createdAt       = sqlite3_column_int64(s, 7);
    w.retiredAt       = sqlite3_column_int64(s, 8);
    w.lastActiveFrame = sqlite3_column_int64(s, 9);
    w.spawnedSlotCap  = static_cast<unsigned>(sqlite3_column_int64(s, 10));
    return w;
}

std::vector<WarRecord> QueryWars(sqlite3* db, const std::string& whereClause,
                                 const std::string& bindText) {
    std::vector<WarRecord> out;
    if (!db) return out;
    const std::string sql = std::string("SELECT ") + kWarColumns +
                            " FROM wars " + whereClause +
                            " ORDER BY created_at DESC, room_id DESC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return out;
    }
    if (!bindText.empty())
        BindText(stmt, 1, bindText);
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadWarRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

// One-statement UPDATE against `wars`, bound (int64, roomId). Every simple
// setter below is this shape, and writing it once keeps the "unknown war
// returns false" contract identical across all of them: sqlite reports
// SQLITE_DONE for an UPDATE that matched nothing, so the row count is the
// only thing that distinguishes a write from a miss.
bool UpdateWar(sqlite3* db, const char* sql, uint32_t roomId,
               const std::vector<int64_t>& leadingInts) {
    if (!db) return false;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    int idx = 1;
    for (const int64_t v : leadingInts)
        sqlite3_bind_int64(stmt, idx++, v);
    sqlite3_bind_int64(stmt, idx, static_cast<int64_t>(roomId));
    const bool stepped = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return stepped && sqlite3_changes(db) > 0;
}

}  // namespace

// ── Planning (pure) ────────────────────────────────────────────────────────

WarSeedPlan PlanWarSeed(const WarSeedRequest& request,
                        const WarSeedPopulation& population) {
    WarSeedPlan plan;
    plan.name         = request.name;
    plan.theatre      = request.theatre;
    plan.gameId       = request.gameId;
    plan.scenario     = request.scenario;
    plan.origin       = request.origin;
    plan.seasonId     = request.seasonId;
    plan.hostUsername = request.hostUsername.empty() ? std::string("director")
                                                     : request.hostUsername;
    plan.caretakerAi  = request.caretakerAi.empty() ? std::string("null")
                                                    : request.caretakerAi;
    plan.autoStart    = request.autoStart;

    if (plan.theatre.empty()) {
        plan.error = "a war needs a theatre (map id)";
        return plan;
    }

    // Dedupe in declaration order — the second mention of a faction adds no
    // side, and dropping it (rather than refusing the request) leaves the
    // remaining sides correctly numbered. Empty names are dropped for the
    // same reason `EncodeWarSides` refuses to encode one: a nameless side is
    // a side no faction can ever match.
    std::vector<std::string> factions;
    for (const auto& f : request.factions) {
        if (f.empty())
            continue;
        if (f.find(',') != std::string::npos || f.find(':') != std::string::npos)
            continue;  // a separator in a key silently reshapes the modoption
        if (std::find(factions.begin(), factions.end(), f) == factions.end())
            factions.push_back(f);
    }

    if (factions.size() < 2) {
        plan.error = "a war needs at least two distinct factions";
        return plan;
    }
    if (request.startBoxCount > 0 && factions.size() > request.startBoxCount) {
        plan.error = "map '" + plan.theatre + "' has " +
                     std::to_string(request.startBoxCount) +
                     " start box(es), war declares " +
                     std::to_string(factions.size()) + " side(s)";
        return plan;
    }
    // 255 is `ParseWarSides`'s own ceiling on a team number; a request past
    // it would encode sides the decoder drops on the far side of the wire.
    if (factions.size() > 256) {
        plan.error = "too many sides (max 256)";
        return plan;
    }

    // Team and start box are the side's index, so the same request always
    // produces the same war — which is what makes a scenario file a war
    // template (§3) rather than a suggestion.
    WarSides sides;
    sides.reserve(factions.size());
    for (size_t i = 0; i < factions.size(); ++i)
        sides.emplace_back(factions[i], static_cast<uint8_t>(i));

    // The capacity rule itself is NOT re-derived here — this is task 7's
    // `SeedSideCapacities` (WarSeeding.h), called with the same population
    // shape it already takes.
    const WarSideCapacities caps = SeedSideCapacities(sides, population);

    plan.sides.reserve(sides.size());
    for (size_t i = 0; i < sides.size(); ++i) {
        WarSideSeed s;
        s.factionId    = sides[i].first;
        s.team         = sides[i].second;
        s.startBox     = static_cast<int>(i);
        s.slotCap      = CapacityForSideIn(caps, s.factionId,
                                           WAR_SIDE_CAPACITY_DEFAULT);
        s.incentivised = false;  // nothing is outnumbered in an empty war
        plan.sides.push_back(std::move(s));
    }

    plan.ok = true;
    return plan;
}

std::string BuildWarBootManifest(const WarSeedPlan& plan) {
    if (!plan.ok)
        return {};

    nlohmann::json m;
    m["name"] = plan.name;
    m["map"]  = plan.theatre;
    if (!plan.gameId.empty())
        m["game"] = plan.gameId;
    // The war half of `SessionKindFromString` — without it a seeded war is a
    // skirmish, and a skirmish ends when its room empties.
    m["sessionKind"] = "persistent";
    if (!plan.scenario.empty())
        m["scenario"] = plan.scenario;
    m["autoStart"] = plan.autoStart;

    // (1) the spectator host — see the header for why it is not a combatant.
    nlohmann::json host;
    host["username"]  = plan.hostUsername;
    host["spectator"] = true;
    m["players"] = nlohmann::json::array({host});

    // (2) one caretaker AI per side, so every declared side is a real team
    // from frame 0 and none of them is a gap team.
    nlohmann::json ais = nlohmann::json::array();
    for (const auto& s : plan.sides) {
        nlohmann::json a;
        a["aiId"]     = plan.caretakerAi;
        a["team"]     = static_cast<int>(s.team);
        a["startPos"] = s.startBox;
        ais.push_back(a);
    }
    m["aiSlots"] = ais;

    // (3) the two modoptions, through the existing encoders.
    nlohmann::json mods;
    mods["war_sides"]            = EncodeWarSides(plan.SideTeams());
    mods["war_side_capacities"]  = EncodeWarSideCapacities(plan.SideCapacities());
    m["modoptions"] = mods;

    return m.dump();
}

// ── The rows ───────────────────────────────────────────────────────────────

void WarDirector::EnsureTables(sqlite3* db) {
    if (!db) return;
    // No probe-and-drop. See the header: these rows are the only copy of the
    // war object, so a schema bump migrates additively.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS wars ("
        "  room_id INTEGER PRIMARY KEY,"
        "  name TEXT NOT NULL DEFAULT '',"
        "  theatre TEXT NOT NULL DEFAULT '',"
        "  scenario TEXT NOT NULL DEFAULT '',"
        "  state TEXT NOT NULL DEFAULT 'seeding',"
        "  origin TEXT NOT NULL DEFAULT 'operator',"
        "  season_id TEXT NOT NULL DEFAULT '',"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  retired_at INTEGER NOT NULL DEFAULT 0,"
        "  last_active_frame INTEGER NOT NULL DEFAULT 0,"
        "  spawned_slot_cap INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS war_sides ("
        "  room_id INTEGER NOT NULL,"
        "  faction_id TEXT NOT NULL,"
        "  team INTEGER NOT NULL DEFAULT -1,"
        "  slot_cap INTEGER NOT NULL DEFAULT 0,"
        "  start_box INTEGER NOT NULL DEFAULT -1,"
        "  incentivised INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (room_id, faction_id)"
        ")", nullptr, nullptr, nullptr);
    // `ListLive` and `WarsFielding` are both state-filtered scans over what
    // will be the largest table here; the primary key leads with room_id and
    // serves neither.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_wars_state ON wars(state)",
        nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_war_sides_faction "
        "ON war_sides(faction_id)", nullptr, nullptr, nullptr);
}

bool WarDirector::Register(sqlite3* db, uint32_t roomId,
                           const WarSeedPlan& plan, int64_t now) {
    if (!db || !plan.ok)
        return false;

    // One transaction for the whole war: a `wars` row whose sides half failed
    // is a war nobody can join and every seeding pass would then re-find.
    //
    // Through `SqliteWriteTransaction` and not a hand-rolled BEGIN/COMMIT pair,
    // because `db` here is the lobby's SHARED handle: the 30 s war sweep runs
    // this on main()'s loop while a Deploy route thread is inside
    // `WarSlotReservations::Reserve` on the same connection. A raw BEGIN would
    // fail with SQLITE_ERROR (not SQLITE_BUSY, so no retry helps), these writes
    // would land inside the reservation's transaction, and the COMMIT below
    // would commit that in-flight reservation early — granting a seat on a
    // full side. See the RULE in SqliteThreading.h.
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WarRegister", [&] {
        {
            static const char* kSql =
                "INSERT INTO wars (room_id, name, theatre, scenario, state, origin,"
                "                  season_id, created_at, retired_at,"
                "                  last_active_frame, spawned_slot_cap) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0) "
                "ON CONFLICT(room_id) DO UPDATE SET "
                "  name=excluded.name, theatre=excluded.theatre,"
                "  scenario=excluded.scenario, state=excluded.state,"
                "  origin=excluded.origin, season_id=excluded.season_id,"
                "  created_at=excluded.created_at, retired_at=0,"
                "  last_active_frame=0, spawned_slot_cap=0";
            sqlite3_stmt* stmt = nullptr;
            if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) == SQLITE_OK) {
                sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
                BindText(stmt, 2, plan.name);
                BindText(stmt, 3, plan.theatre);
                BindText(stmt, 4, plan.scenario);
                BindText(stmt, 5, WarStateToString(WarState::Seeding));
                BindText(stmt, 6, WarOriginToString(plan.origin));
                BindText(stmt, 7, plan.seasonId);
                sqlite3_bind_int64(stmt, 8, now);
                ok = sqlite3_step(stmt) == SQLITE_DONE;
            } else {
                ok = false;
            }
            sqlite3_finalize(stmt);
        }

        // Room ids are reused, so the sides of whatever last held this id are
        // deleted rather than merged into. An upsert alone would leave a dead
        // war's faction sitting in the new war's side list.
        if (ok) {
            sqlite3_stmt* stmt = nullptr;
            if (sqlite3_prepare_v2(db, "DELETE FROM war_sides WHERE room_id=?", -1,
                                   &stmt, nullptr) == SQLITE_OK) {
                sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
                ok = sqlite3_step(stmt) == SQLITE_DONE;
            } else {
                ok = false;
            }
            sqlite3_finalize(stmt);
        }

        for (const auto& s : plan.sides) {
            if (!ok) break;
            static const char* kSql =
                "INSERT INTO war_sides (room_id, faction_id, team, slot_cap,"
                "                       start_box, incentivised) "
                "VALUES (?, ?, ?, ?, ?, ?)";
            sqlite3_stmt* stmt = nullptr;
            if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) == SQLITE_OK) {
                sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
                BindText(stmt, 2, s.factionId);
                sqlite3_bind_int(stmt, 3, static_cast<int>(s.team));
                sqlite3_bind_int64(stmt, 4, static_cast<int64_t>(s.slotCap));
                sqlite3_bind_int(stmt, 5, s.startBox);
                sqlite3_bind_int(stmt, 6, s.incentivised ? 1 : 0);
                ok = sqlite3_step(stmt) == SQLITE_DONE;
            } else {
                ok = false;
            }
            sqlite3_finalize(stmt);
        }

        return ok ? SQLITE_OK : SQLITE_ABORT;
    });
    return ok && committed;
}

bool WarDirector::SetState(sqlite3* db, uint32_t roomId, WarState to,
                           int64_t now) {
    const auto current = Load(db, roomId);
    if (!current)
        return false;
    if (!IsLegalWarTransition(current->state, to))
        return false;
    if (to == WarState::Archived)
        return Retire(db, roomId, now);

    static const char* kSql = "UPDATE wars SET state=? WHERE room_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    BindText(stmt, 1, WarStateToString(to));
    sqlite3_bind_int64(stmt, 2, static_cast<int64_t>(roomId));
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

bool WarDirector::Retire(sqlite3* db, uint32_t roomId, int64_t now) {
    // `retired_at` is stamped only on the FIRST retire: re-retiring an
    // archived war (an operator repeating themselves, an adoption pass
    // re-finding a dead room) must not move the moment the war ended, which
    // is what the digest and the escrow settlement are dated from.
    static const char* kSql =
        "UPDATE wars SET state='archived',"
        "  retired_at=CASE WHEN retired_at=0 THEN ? ELSE retired_at END "
        "WHERE room_id=?";
    return UpdateWar(db, kSql, roomId, {now});
}

bool WarDirector::RecordSpawnedSlotCap(sqlite3* db, uint32_t roomId,
                                       unsigned totalSlotCap) {
    static const char* kSql =
        "UPDATE wars SET spawned_slot_cap=? WHERE room_id=?";
    return UpdateWar(db, kSql, roomId, {static_cast<int64_t>(totalSlotCap)});
}

bool WarDirector::TouchActivity(sqlite3* db, uint32_t roomId, int64_t frame,
                                int64_t now) {
    (void)now;
    // Monotonic: a heartbeat that arrives out of order (or a resumed war
    // whose sim restarts at frame 0 — nothing snapshots the world yet) must
    // not make a war look younger than it is.
    static const char* kSql =
        "UPDATE wars SET last_active_frame=MAX(last_active_frame, ?) "
        "WHERE room_id=?";
    return UpdateWar(db, kSql, roomId, {frame});
}

bool WarDirector::SetSideIncentivised(sqlite3* db, uint32_t roomId,
                                      const std::string& factionId, bool on) {
    if (!db) return false;
    static const char* kSql =
        "UPDATE war_sides SET incentivised=? WHERE room_id=? AND faction_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int(stmt, 1, on ? 1 : 0);
    sqlite3_bind_int64(stmt, 2, static_cast<int64_t>(roomId));
    BindText(stmt, 3, factionId);
    const bool stepped = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return stepped && sqlite3_changes(db) > 0;
}

bool WarDirector::SetSideSlotCap(sqlite3* db, uint32_t roomId,
                                 const std::string& factionId,
                                 unsigned slotCap) {
    if (!db) return false;
    static const char* kSql =
        "UPDATE war_sides SET slot_cap=? WHERE room_id=? AND faction_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(slotCap));
    sqlite3_bind_int64(stmt, 2, static_cast<int64_t>(roomId));
    BindText(stmt, 3, factionId);
    const bool stepped = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return stepped && sqlite3_changes(db) > 0;
}

std::optional<WarRecord> WarDirector::Load(sqlite3* db, uint32_t roomId) {
    if (!db) return std::nullopt;
    const std::string sql =
        std::string("SELECT ") + kWarColumns + " FROM wars WHERE room_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return std::nullopt;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    std::optional<WarRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        out = ReadWarRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WarSideRecord> WarDirector::SidesFor(sqlite3* db, uint32_t roomId) {
    std::vector<WarSideRecord> out;
    if (!db) return out;
    // Ordered by team, so the derived modoption lists sides in the same order
    // the plan did and `war_sides` reads the same way in both directions.
    static const char* kSql =
        "SELECT room_id, faction_id, team, slot_cap, start_box, incentivised "
        "FROM war_sides WHERE room_id=? ORDER BY team ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return out;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        WarSideRecord s;
        s.roomId       = static_cast<uint32_t>(sqlite3_column_int64(stmt, 0));
        s.factionId    = ColText(stmt, 1);
        s.team         = sqlite3_column_int(stmt, 2);
        s.slotCap      = static_cast<unsigned>(sqlite3_column_int64(stmt, 3));
        s.startBox     = sqlite3_column_int(stmt, 4);
        s.incentivised = sqlite3_column_int(stmt, 5) != 0;
        out.push_back(std::move(s));
    }
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WarRecord> WarDirector::ListLive(sqlite3* db) {
    return QueryWars(db, "WHERE state != 'archived'", "");
}

std::vector<WarRecord> WarDirector::ListByState(sqlite3* db, WarState state) {
    return QueryWars(db, "WHERE state = ?1", WarStateToString(state));
}

unsigned WarDirector::WarsFielding(sqlite3* db, const std::string& factionId) {
    if (!db || factionId.empty())
        return 0;
    // A JOIN, not a maintained counter: `warsFielding` is the denominator of
    // the capacity rule, and a counter that drifts by one silently halves (or
    // doubles) every side this faction is offered from then on.
    //
    // `winding_down`/`resolving` wars are counted — they still hold their
    // players, so a faction fielding one is not free to have its next war
    // sized as though it fielded none.
    static const char* kSql =
        "SELECT COUNT(*) FROM war_sides s JOIN wars w ON w.room_id = s.room_id "
        "WHERE s.faction_id = ? AND w.state != 'archived'";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    BindText(stmt, 1, factionId);
    unsigned n = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        n = static_cast<unsigned>(sqlite3_column_int64(stmt, 0));
    sqlite3_finalize(stmt);
    return n;
}

bool WarDirector::Forget(sqlite3* db, uint32_t roomId) {
    if (!db) return false;
    // Shared handle, one transaction helper — see `Register` above and the RULE
    // in SqliteThreading.h. This one is also reached from RoomManager's
    // room-delete chokepoint, so it can legitimately run INSIDE another
    // transaction on this thread; the helper runs it inline there rather than
    // opening a second one that would fail.
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WarForget", [&] {
        for (const char* sql : {"DELETE FROM war_sides WHERE room_id=?",
                                "DELETE FROM wars WHERE room_id=?"}) {
            sqlite3_stmt* stmt = nullptr;
            if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) == SQLITE_OK) {
                sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
                ok = ok && sqlite3_step(stmt) == SQLITE_DONE;
            } else {
                ok = false;
            }
            sqlite3_finalize(stmt);
        }
        return ok ? SQLITE_OK : SQLITE_ABORT;
    });
    return ok && committed;
}
