#include "WorldFactions.h"

#include <sqlite3.h>


#include <cctype>

#include "SqliteThreading.h"
#include "WorldDirector.h"

namespace {

void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

std::string ColText(sqlite3_stmt* s, int idx) {
    if (const unsigned char* u = sqlite3_column_text(s, idx))
        return reinterpret_cast<const char*>(u);
    return {};
}

/// Same rule as WorldDirector's: an unreadable tunables blob degrades to an
/// empty object rather than failing the row. A faction whose parameter sheet
/// cannot be parsed still has a name, a roster and a colour, and those are
/// what the map needs.
nlohmann::json ParseConfig(const std::string& raw) {
    if (raw.empty()) return nlohmann::json::object();
    nlohmann::json j = nlohmann::json::parse(raw, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object()) return nlohmann::json::object();
    return j;
}

/// Per-key fallback, never "the blob is missing so the defaults apply". A
/// world seeded before W7 has a config_json with the W1 keys only, and a
/// whole-blob fallback would be right there and wrong for a world that has
/// tuned exactly one of these.
double CfgDouble(const nlohmann::json& j, const char* key, double fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return it->get<double>();
}

int CfgInt(const nlohmann::json& j, const char* key, int fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number_integer()) return fallback;
    return it->get<int>();
}

/// A colour is written into a canvas fillStyle, so it is validated to exactly
/// "#rrggbb" rather than escaped: anything else is refused and the caller
/// falls back to the archetype's.
bool IsHexColour(const std::string& c) {
    if (c.size() != 7 || c[0] != '#') return false;
    for (size_t i = 1; i < c.size(); ++i)
        if (!std::isxdigit(static_cast<unsigned char>(c[i]))) return false;
    return true;
}

const char* kFactionColumns =
    "world_id, faction_id, name, archetype, governance, colour, side_key, "
    "founder_account_id, founded_at, state, config_json";

WorldFactionRecord ReadFactionRow(sqlite3_stmt* s) {
    WorldFactionRecord f;
    f.worldId          = ColText(s, 0);
    f.factionId        = ColText(s, 1);
    f.name             = ColText(s, 2);
    f.archetype        = ColText(s, 3);
    f.governance       = ColText(s, 4);
    f.colour           = ColText(s, 5);
    f.sideKey          = ColText(s, 6);
    f.founderAccountId = sqlite3_column_int64(s, 7);
    f.foundedAt        = sqlite3_column_int64(s, 8);
    f.state            = ColText(s, 9);
    f.config           = ParseConfig(ColText(s, 10));
    return f;
}

const char* kMemberColumns =
    "world_id, faction_id, account_id, username, role, rank, joined_at";

WorldFactionMemberRecord ReadMemberRow(sqlite3_stmt* s) {
    WorldFactionMemberRecord m;
    m.worldId   = ColText(s, 0);
    m.factionId = ColText(s, 1);
    m.accountId = sqlite3_column_int64(s, 2);
    m.username  = ColText(s, 3);
    m.role      = ColText(s, 4);
    m.rank      = sqlite3_column_double(s, 5);
    m.joinedAt  = sqlite3_column_int64(s, 6);
    return m;
}

WorldFactionFoundResult Failure(const std::string& error, const std::string& detail) {
    WorldFactionFoundResult r;
    r.ok = false;
    r.error = error;
    r.detail = detail;
    return r;
}

}  // namespace

// ─────────────────────────── archetypes ────────────────────────────────────

nlohmann::json WorldFactionParameters::ToJson() const {
    nlohmann::json j;
    j["diplomacy"]   = diplomacy;
    j["command"]     = command;
    j["finance"]     = finance;
    j["production"]  = production;
    j["mining"]      = mining;
    j["intel"]       = intel;
    j["electronics"] = electronics;
    j["loyalty"]     = loyalty;
    j["technology"]  = technology;
    j["archaeology"] = archaeology;
    return j;
}

WorldFactionParameters WorldFactionParameters::FromJson(const nlohmann::json& j) {
    WorldFactionParameters p;
    p.diplomacy   = CfgDouble(j, "diplomacy",   p.diplomacy);
    p.command     = CfgDouble(j, "command",     p.command);
    p.finance     = CfgDouble(j, "finance",     p.finance);
    p.production  = CfgDouble(j, "production",  p.production);
    p.mining      = CfgDouble(j, "mining",      p.mining);
    p.intel       = CfgDouble(j, "intel",       p.intel);
    p.electronics = CfgDouble(j, "electronics", p.electronics);
    p.loyalty     = CfgDouble(j, "loyalty",     p.loyalty);
    p.technology  = CfgDouble(j, "technology",  p.technology);
    p.archaeology = CfgDouble(j, "archaeology", p.archaeology);
    return p;
}

nlohmann::json WorldFactionArchetype::ToJson() const {
    nlohmann::json j;
    j["key"]          = key;
    j["name"]         = name;
    j["description"]  = description;
    j["nameRegister"] = nameRegister;
    j["governance"]   = governance;
    j["colour"]       = colour;
    j["parameters"]   = parameters.ToJson();
    return j;
}

const std::vector<WorldFactionArchetype>& WorldFactionArchetypes() {
    // §4's matrix, transcribed once. L=0.25, M=0.5, H=0.75, half-steps at the
    // midpoint — the bands' ORDER is the designed content; the absolute
    // numbers are a scale nothing multiplies by yet, and the row is the
    // authority the moment a faction is founded from one of these.
    static const std::vector<WorldFactionArchetype> kArchetypes = [] {
        std::vector<WorldFactionArchetype> v;

        WorldFactionArchetype order;
        order.key          = kArchetypeOrder;
        order.name         = "Order";
        order.description  = "Governments and corporations: hierarchy, "
                             "production, and orders that arrive on time.";
        order.nameRegister = "formal";
        order.governance   = "hierarchical";
        order.colour       = "#5b9bd5";
        order.parameters   = {/*dip*/0.5,  /*cmd*/0.75, /*fin*/0.625, /*prod*/0.75,
                              /*min*/0.5,  /*intel*/0.5, /*elec*/0.625, /*loy*/0.5,
                              /*tech*/0.5, /*arch*/0.375};
        v.push_back(order);

        WorldFactionArchetype dynasty;
        dynasty.key          = kArchetypeDynasty;
        dynasty.name         = "Dynasty";
        dynasty.description  = "Grand families trading on wealth and prestige "
                               "— and keepers of the old machines.";
        dynasty.nameRegister = "dynastic";
        dynasty.governance   = "council";
        dynasty.colour       = "#c9a227";
        dynasty.parameters   = {/*dip*/0.75, /*cmd*/0.5, /*fin*/0.75, /*prod*/0.375,
                                /*min*/0.5,  /*intel*/0.5, /*elec*/0.25, /*loy*/0.625,
                                /*tech*/0.75, /*arch*/0.625};
        v.push_back(dynasty);

        WorldFactionArchetype resistance;
        resistance.key          = kArchetypeResistance;
        resistance.name         = "Resistance";
        resistance.description  = "Guerrillas and rebels: sympathisers "
                                  "everywhere, devotion instead of pay.";
        resistance.nameRegister = "cause";
        resistance.governance   = "consensus";
        resistance.colour       = "#c0504d";
        resistance.parameters   = {/*dip*/0.375, /*cmd*/0.25, /*fin*/0.25, /*prod*/0.25,
                                   /*min*/0.375, /*intel*/0.75, /*elec*/0.375, /*loy*/0.75,
                                   /*tech*/0.25, /*arch*/0.375};
        v.push_back(resistance);

        WorldFactionArchetype anarchic;
        anarchic.key          = kArchetypeAnarchic;
        anarchic.name         = "Free Companies";
        anarchic.description  = "Smugglers and gangs: salvage fluency, street "
                                "networks, and barely a structure at all.";
        anarchic.nameRegister = "street";
        anarchic.governance   = "minimal";
        anarchic.colour       = "#7f9a4e";
        anarchic.parameters   = {/*dip*/0.25, /*cmd*/0.25, /*fin*/0.25, /*prod*/0.375,
                                 /*min*/0.625, /*intel*/0.625, /*elec*/0.5, /*loy*/0.375,
                                 /*tech*/0.375, /*arch*/0.625};
        v.push_back(anarchic);

        return v;
    }();
    return kArchetypes;
}

std::optional<WorldFactionArchetype> WorldFactionArchetypeFor(const std::string& key) {
    for (const auto& a : WorldFactionArchetypes())
        if (a.key == key) return a;
    return std::nullopt;
}

// ─────────────────────────── the per-world rules ───────────────────────────

WorldFactionRules WorldFactionRules::FromWorldConfig(const nlohmann::json& worldConfig) {
    // The struct's own members already carry the ship-with values, and
    // WorldDefaults writes the same numbers into a new world's blob — so a
    // world that predates W7 and one seeded today behave identically until
    // somebody tunes one.
    const WorldDefaults d;
    WorldFactionRules r;
    r.startingAuthority     = CfgDouble(worldConfig, "startingAuthority", d.startingAuthority);
    r.foundFactionAuthority = CfgDouble(worldConfig, "foundFactionAuthority", d.foundFactionAuthority);
    r.foundFactionCost      = CfgDouble(worldConfig, "foundFactionCost", d.foundFactionCost);
    r.nameMinLen            = CfgInt(worldConfig, "factionNameMinLen", d.factionNameMinLen);
    r.nameMaxLen            = CfgInt(worldConfig, "factionNameMaxLen", d.factionNameMaxLen);
    return r;
}

// ─────────────────────────── pure policy ───────────────────────────────────

std::string SlugifyFactionName(const std::string& name) {
    std::string out;
    bool pendingDash = false;
    for (const unsigned char c : name) {
        if (std::isalnum(c)) {
            if (pendingDash && !out.empty()) out += '-';
            pendingDash = false;
            out += static_cast<char>(std::tolower(c));
        } else {
            // Every run of non-alphanumerics collapses to ONE dash, and only
            // if something follows it — so "House  Verendi!" and
            // "house-verendi" are the same id, which is what stops a world
            // holding two factions a player cannot tell apart.
            pendingDash = true;
        }
    }
    return out;
}

std::string ValidateFactionName(const std::string& name, const WorldFactionRules& rules) {
    if (static_cast<int>(name.size()) < rules.nameMinLen)
        return "too short";
    if (static_cast<int>(name.size()) > rules.nameMaxLen)
        return "too long";
    for (const unsigned char c : name) {
        // Control characters (and DEL) are refused outright: they carry no
        // meaning in a name and they are what turns a roster line into a
        // forged one. Everything else printable is allowed — a faction name
        // is player content, and narrowing it to ASCII would refuse most of
        // the world's own languages.
        if (c < 0x20 || c == 0x7f)
            return "control characters are not allowed";
    }
    if (SlugifyFactionName(name).empty())
        return "must contain at least one letter or digit";
    return {};
}

SideKeyAction ReconcileSideKey(const std::string& accountSideKey,
                               const std::string& factionSideKey) {
    if (factionSideKey.empty()) return SideKeyAction::None;
    if (accountSideKey.empty()) return SideKeyAction::Adopt;
    if (accountSideKey == factionSideKey) return SideKeyAction::None;
    return SideKeyAction::Refuse;
}

// ─────────────────────────── the rows ──────────────────────────────────────

void WorldFactions::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_factions ("
        "  world_id TEXT NOT NULL,"
        "  faction_id TEXT NOT NULL,"
        "  name TEXT NOT NULL DEFAULT '',"
        "  archetype TEXT NOT NULL DEFAULT '',"
        "  governance TEXT NOT NULL DEFAULT '',"
        "  colour TEXT NOT NULL DEFAULT '',"
        // The bridge to users.faction_id (see the header). Empty is legal: a
        // faction that has not bound a side yet fields nobody in battle.
        "  side_key TEXT NOT NULL DEFAULT '',"
        "  founder_account_id INTEGER NOT NULL DEFAULT 0,"
        "  founded_at INTEGER NOT NULL DEFAULT 0,"
        "  state TEXT NOT NULL DEFAULT 'active',"
        "  config_json TEXT NOT NULL DEFAULT '{}',"
        "  PRIMARY KEY (world_id, faction_id)"
        ")", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_faction_members ("
        "  world_id TEXT NOT NULL,"
        "  faction_id TEXT NOT NULL,"
        "  account_id INTEGER NOT NULL,"
        "  username TEXT NOT NULL DEFAULT '',"
        "  role TEXT NOT NULL DEFAULT 'member',"
        "  rank REAL NOT NULL DEFAULT 0,"
        "  joined_at INTEGER NOT NULL DEFAULT 0,"
        // (world_id, account_id) and NOT (world_id, faction_id, account_id):
        // one faction per player per world is a SCHEMA fact here, so "which
        // faction is this player in" has exactly one answer and no caller
        // needs a tie-break rule.
        "  PRIMARY KEY (world_id, account_id)"
        ")", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_authority ("
        "  world_id TEXT NOT NULL,"
        "  account_id INTEGER NOT NULL,"
        "  authority REAL NOT NULL DEFAULT 0,"
        "  capacity REAL NOT NULL DEFAULT 0,"
        "  updated_at INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (world_id, account_id)"
        ")", nullptr, nullptr, nullptr);

    // The roster view is "everyone in this faction", which the membership
    // primary key (world_id, account_id) cannot serve.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_members_faction "
        "ON world_faction_members(world_id, faction_id)", nullptr, nullptr, nullptr);
}

bool WorldFactions::Upsert(sqlite3* db, const WorldFactionRecord& f) {
    if (!db || f.worldId.empty() || f.factionId.empty()) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldFactionUpsert", [&] {
        static const char* kSql =
            "INSERT INTO world_factions (world_id, faction_id, name, archetype,"
            "                            governance, colour, side_key,"
            "                            founder_account_id, founded_at, state,"
            "                            config_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(world_id, faction_id) DO UPDATE SET "
            "  name=excluded.name, archetype=excluded.archetype,"
            "  governance=excluded.governance, colour=excluded.colour,"
            "  side_key=excluded.side_key, state=excluded.state,"
            "  config_json=excluded.config_json";
        // founder_account_id and founded_at are NOT updated: a faction is
        // founded once, by one player, same rule as `worlds.created_at`.
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        const std::string cfg = f.config.dump();
        BindText(stmt, 1, f.worldId);
        BindText(stmt, 2, f.factionId);
        BindText(stmt, 3, f.name);
        BindText(stmt, 4, f.archetype);
        BindText(stmt, 5, f.governance);
        BindText(stmt, 6, f.colour);
        BindText(stmt, 7, f.sideKey);
        sqlite3_bind_int64(stmt, 8, f.founderAccountId);
        sqlite3_bind_int64(stmt, 9, f.foundedAt);
        BindText(stmt, 10, f.state);
        BindText(stmt, 11, cfg);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

std::optional<WorldFactionRecord> WorldFactions::Load(sqlite3* db,
                                                      const std::string& worldId,
                                                      const std::string& factionId) {
    if (!db || worldId.empty() || factionId.empty()) return std::nullopt;
    const std::string sql = std::string("SELECT ") + kFactionColumns +
                            " FROM world_factions WHERE world_id=? AND faction_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, factionId);
    std::optional<WorldFactionRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        out = ReadFactionRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldFactionRecord> WorldFactions::ListFor(sqlite3* db,
                                                       const std::string& worldId) {
    std::vector<WorldFactionRecord> out;
    if (!db || worldId.empty()) return out;
    const std::string sql = std::string("SELECT ") + kFactionColumns +
                            " FROM world_factions WHERE world_id=? "
                            "ORDER BY founded_at ASC, faction_id ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    BindText(stmt, 1, worldId);
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadFactionRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

// ─────────────────────────── membership ────────────────────────────────────

namespace {

/// Insert or replace one membership row. Not a public method: joining is
/// always a decision (Found or Join) and a bare "put this row there" is how a
/// second faction ends up holding a member the first still thinks it has.
bool WriteMembership(sqlite3* db, const WorldFactionMemberRecord& m) {
    static const char* kSql =
        "INSERT INTO world_faction_members "
        "(world_id, faction_id, account_id, username, role, rank, joined_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(world_id, account_id) DO UPDATE SET "
        "  faction_id=excluded.faction_id, username=excluded.username,"
        "  role=excluded.role, rank=excluded.rank, joined_at=excluded.joined_at";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK)
        return false;
    BindText(stmt, 1, m.worldId);
    BindText(stmt, 2, m.factionId);
    sqlite3_bind_int64(stmt, 3, m.accountId);
    BindText(stmt, 4, m.username);
    BindText(stmt, 5, m.role);
    sqlite3_bind_double(stmt, 6, m.rank);
    sqlite3_bind_int64(stmt, 7, m.joinedAt);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

int CountMembers(sqlite3* db, const std::string& worldId, const std::string& factionId) {
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT COUNT(*) FROM world_faction_members "
            "WHERE world_id=? AND faction_id=?",
            -1, &stmt, nullptr) != SQLITE_OK)
        return 0;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, factionId);
    int n = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) n = sqlite3_column_int(stmt, 0);
    sqlite3_finalize(stmt);
    return n;
}

}  // namespace

std::optional<WorldFactionMemberRecord> WorldFactions::MembershipFor(
    sqlite3* db, const std::string& worldId, int64_t accountId) {
    if (!db || worldId.empty() || accountId <= 0) return std::nullopt;
    const std::string sql = std::string("SELECT ") + kMemberColumns +
                            " FROM world_faction_members "
                            "WHERE world_id=? AND account_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    BindText(stmt, 1, worldId);
    sqlite3_bind_int64(stmt, 2, accountId);
    std::optional<WorldFactionMemberRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        out = ReadMemberRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldFactionMemberRecord> WorldFactions::MembersOf(
    sqlite3* db, const std::string& worldId, const std::string& factionId) {
    std::vector<WorldFactionMemberRecord> out;
    if (!db || worldId.empty() || factionId.empty()) return out;
    const std::string sql = std::string("SELECT ") + kMemberColumns +
                            " FROM world_faction_members "
                            "WHERE world_id=? AND faction_id=? "
                            "ORDER BY joined_at ASC, account_id ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, factionId);
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadMemberRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

// ─────────────────────────── authority ─────────────────────────────────────

WorldAuthorityRecord WorldFactions::AuthorityFor(sqlite3* db,
                                                 const std::string& worldId,
                                                 int64_t accountId,
                                                 const WorldFactionRules& rules,
                                                 int64_t nowRealMs) {
    WorldAuthorityRecord out;
    out.worldId   = worldId;
    out.accountId = accountId;
    if (!db || worldId.empty() || accountId <= 0) return out;

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT authority, capacity, updated_at FROM world_authority "
            "WHERE world_id=? AND account_id=?",
            -1, &stmt, nullptr) == SQLITE_OK) {
        BindText(stmt, 1, worldId);
        sqlite3_bind_int64(stmt, 2, accountId);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            out.authority = sqlite3_column_double(stmt, 0);
            out.capacity  = sqlite3_column_double(stmt, 1);
            out.updatedAt = sqlite3_column_int64(stmt, 2);
            sqlite3_finalize(stmt);
            return out;
        }
        sqlite3_finalize(stmt);
    }

    // First contact with this world: credit the starting grant and persist it,
    // so the number a player is shown is the number the founding gate will
    // read back — a computed-on-read default would drift the moment the
    // world's config is tuned between the two.
    out.authority = rules.startingAuthority;
    out.capacity  = 0.0;
    out.updatedAt = nowRealMs;
    const WorldAuthorityRecord seed = out;
    SqliteWriteTransaction(db, "WorldAuthoritySeed", [&] {
        sqlite3_stmt* ins = nullptr;
        if (sqlite3_prepare_v2(db,
                "INSERT INTO world_authority "
                "(world_id, account_id, authority, capacity, updated_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(world_id, account_id) DO NOTHING",
                -1, &ins, nullptr) != SQLITE_OK)
            return SQLITE_ERROR;
        BindText(ins, 1, seed.worldId);
        sqlite3_bind_int64(ins, 2, seed.accountId);
        sqlite3_bind_double(ins, 3, seed.authority);
        sqlite3_bind_double(ins, 4, seed.capacity);
        sqlite3_bind_int64(ins, 5, seed.updatedAt);
        const bool ok = sqlite3_step(ins) == SQLITE_DONE;
        sqlite3_finalize(ins);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return out;
}

bool WorldFactions::AdjustAuthority(sqlite3* db, const std::string& worldId,
                                    int64_t accountId, double delta,
                                    int64_t nowRealMs) {
    if (!db || worldId.empty() || accountId <= 0) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldAdjustAuthority", [&] {
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db,
                "UPDATE world_authority "
                "SET authority=MAX(0, authority + ?), updated_at=? "
                "WHERE world_id=? AND account_id=?",
                -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        sqlite3_bind_double(stmt, 1, delta);
        sqlite3_bind_int64(stmt, 2, nowRealMs);
        BindText(stmt, 3, worldId);
        sqlite3_bind_int64(stmt, 4, accountId);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        if (!ok) return SQLITE_ERROR;
        // No row = this account has never been seen in this world, so there is
        // nothing to adjust. The caller that spends always reads first
        // (AuthorityFor creates the row), which is what makes this an
        // unreachable-by-design case rather than a silent loss.
        if (sqlite3_changes(db) == 0) {
            ok = false;
            return SQLITE_ABORT;
        }
        return SQLITE_OK;
    });
    return committed && ok;
}

// ─────────────────────────── founding + joining ────────────────────────────

WorldFactionFoundResult WorldFactions::Found(sqlite3* db,
                                             const WorldFactionRules& rules,
                                             const WorldFactionFoundRequest& req,
                                             int64_t nowRealMs) {
    if (!db || req.worldId.empty() || req.accountId <= 0)
        return Failure("db_error", "no world or no account");

    if (const std::string why = ValidateFactionName(req.name, rules); !why.empty())
        return Failure("bad_name", why);

    const auto archetype = WorldFactionArchetypeFor(req.archetype);
    if (!archetype)
        return Failure("bad_archetype", "unknown archetype '" + req.archetype + "'");

    // Already in a faction: founding is joining, and the one-faction-per-world
    // rule is the schema's, so this is refused before anything is spent
    // rather than caught by a constraint after.
    if (const auto existing = MembershipFor(db, req.worldId, req.accountId))
        return Failure("already_member",
                       "leave '" + existing->factionId + "' first");

    const std::string factionId = SlugifyFactionName(req.name);
    if (Load(db, req.worldId, factionId))
        return Failure("name_taken", "a faction with that name already exists");

    // The seat POI is resolved BEFORE the spend, so a founder is never charged
    // for a faction seated nowhere.
    if (!req.seatPoiId.empty()) {
        const auto poi = WorldDirector::LoadPoi(db, req.worldId, req.seatPoiId);
        if (!poi)
            return Failure("bad_seat", "no such POI in this world");
        if (!poi->ownerFactionId.empty())
            return Failure("seat_taken",
                           "'" + poi->name + "' is already held by " +
                           poi->ownerFactionId);
    }

    const auto authority = AuthorityFor(db, req.worldId, req.accountId, rules, nowRealMs);
    if (authority.authority < rules.foundFactionAuthority) {
        WorldFactionFoundResult r =
            Failure("insufficient_authority", "not enough world authority to found");
        r.have = authority.authority;
        r.need = rules.foundFactionAuthority;
        return r;
    }

    WorldFactionRecord f;
    f.worldId          = req.worldId;
    f.factionId        = factionId;
    f.name             = req.name;
    f.archetype        = archetype->key;
    f.governance       = req.governance.empty() ? archetype->governance : req.governance;
    f.colour           = IsHexColour(req.colour) ? req.colour : archetype->colour;
    f.sideKey          = req.sideKey;
    f.founderAccountId = req.accountId;
    f.foundedAt        = nowRealMs;
    f.state            = "active";
    // The archetype sheet is COPIED, not referenced: §4's "faction creation
    // copies the sheet; deviation edits the copy". A later edit to the
    // archetype must never retune a faction somebody has been playing.
    f.config["parameters"]   = archetype->parameters.ToJson();
    f.config["nameRegister"] = archetype->nameRegister;

    WorldFactionMemberRecord m;
    m.worldId   = req.worldId;
    m.factionId = factionId;
    m.accountId = req.accountId;
    m.username  = req.username;
    m.role      = "founder";
    m.rank      = 0.0;
    m.joinedAt  = nowRealMs;

    // One transaction for the whole act: the faction row, the founder's
    // membership, the spend and the seat claim are only correct together. A
    // faction with no founder — or a spend with no faction — is a state
    // nothing recovers from, and the re-entrancy of SqliteWriteTransaction is
    // what lets the nested writers below join this transaction rather than
    // open their own.
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldFoundFaction", [&] {
        if (!Upsert(db, f))            { ok = false; return SQLITE_ERROR; }
        if (!WriteMembership(db, m))   { ok = false; return SQLITE_ERROR; }
        if (rules.foundFactionCost > 0 &&
            !AdjustAuthority(db, req.worldId, req.accountId,
                             -rules.foundFactionCost, nowRealMs)) {
            ok = false;
            return SQLITE_ERROR;
        }
        if (!req.seatPoiId.empty() &&
            !WorldDirector::SetPoiOwner(db, req.worldId, req.seatPoiId, factionId)) {
            ok = false;
            return SQLITE_ERROR;
        }
        return SQLITE_OK;
    });
    if (!committed || !ok)
        return Failure("db_error", "the founding write did not reach disk");

    WorldFactionFoundResult r;
    r.ok = true;
    r.faction = f;
    r.have = authority.authority - rules.foundFactionCost;
    r.need = rules.foundFactionAuthority;
    return r;
}

WorldFactionFoundResult WorldFactions::Join(sqlite3* db, const std::string& worldId,
                                            const std::string& factionId,
                                            int64_t accountId,
                                            const std::string& username,
                                            int64_t nowRealMs) {
    if (!db || worldId.empty() || accountId <= 0)
        return Failure("db_error", "no world or no account");
    const auto faction = Load(db, worldId, factionId);
    if (!faction)
        return Failure("no_such_faction", "no faction '" + factionId + "' in this world");
    if (const auto existing = MembershipFor(db, worldId, accountId)) {
        if (existing->factionId == factionId) {
            // Already in: reported as success with the faction, because the
            // caller's intent ("I want to be in this faction") holds.
            WorldFactionFoundResult r;
            r.ok = true;
            r.faction = faction;
            return r;
        }
        return Failure("already_member", "leave '" + existing->factionId + "' first");
    }

    WorldFactionMemberRecord m;
    m.worldId   = worldId;
    m.factionId = factionId;
    m.accountId = accountId;
    m.username  = username;
    m.role      = "member";
    m.rank      = 0.0;
    m.joinedAt  = nowRealMs;

    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldJoinFaction", [&] {
        if (!WriteMembership(db, m)) { ok = false; return SQLITE_ERROR; }
        // A dormant faction someone joins is active again — the roster is
        // what "dormant" means, so the flag must follow it or the two
        // disagree the moment a faction is revived.
        if (faction->state != "active") {
            WorldFactionRecord revived = *faction;
            revived.state = "active";
            if (!Upsert(db, revived)) { ok = false; return SQLITE_ERROR; }
        }
        return SQLITE_OK;
    });
    if (!committed || !ok)
        return Failure("db_error", "the join write did not reach disk");

    WorldFactionFoundResult r;
    r.ok = true;
    r.faction = faction;
    return r;
}

bool WorldFactions::Leave(sqlite3* db, const std::string& worldId, int64_t accountId) {
    if (!db || worldId.empty() || accountId <= 0) return false;
    const auto existing = MembershipFor(db, worldId, accountId);
    if (!existing) return false;

    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldLeaveFaction", [&] {
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db,
                "DELETE FROM world_faction_members "
                "WHERE world_id=? AND account_id=?",
                -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, worldId);
        sqlite3_bind_int64(stmt, 2, accountId);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        if (!ok) return SQLITE_ERROR;

        // The last member out marks the faction dormant. It is NOT deleted:
        // its POIs still name it as their owner and its settlements are
        // history, so removing the row would leave both pointing at nothing.
        if (CountMembers(db, worldId, existing->factionId) == 0) {
            if (const auto f = Load(db, worldId, existing->factionId)) {
                WorldFactionRecord dormant = *f;
                dormant.state = "dormant";
                if (!Upsert(db, dormant)) { ok = false; return SQLITE_ERROR; }
            }
        }
        return SQLITE_OK;
    });
    return committed && ok;
}

// ─────────────────────────── the HTTP surface ──────────────────────────────

nlohmann::json WorldFactions::FactionsJson(sqlite3* db, const std::string& worldId,
                                           const WorldFactionRules& rules) {
    nlohmann::json out;
    out["worldId"] = worldId;

    nlohmann::json arr = nlohmann::json::array();
    for (const auto& f : ListFor(db, worldId)) {
        nlohmann::json j;
        j["id"]         = f.factionId;
        j["name"]       = f.name;
        j["archetype"]  = f.archetype;
        j["governance"] = f.governance;
        j["colour"]     = f.colour;
        // Null rather than "" for an unbound side, the same branch-on-absence
        // rule `mapId` and `owner` follow.
        if (f.sideKey.empty()) j["sideKey"] = nullptr;
        else                   j["sideKey"] = f.sideKey;
        j["foundedAt"]   = f.foundedAt;
        j["state"]       = f.state;
        j["config"]      = f.config;
        j["memberCount"] = static_cast<int64_t>(MembersOf(db, worldId, f.factionId).size());
        arr.push_back(std::move(j));
    }
    out["factions"] = std::move(arr);

    // The archetype catalogue rides along: a client rendering the "found a
    // faction" form needs the sheets and the roster together, and two
    // round-trips for one form is a race against another player founding in
    // between.
    nlohmann::json arch = nlohmann::json::array();
    for (const auto& a : WorldFactionArchetypes())
        arch.push_back(a.ToJson());
    out["archetypes"] = std::move(arch);

    nlohmann::json r;
    r["foundFactionAuthority"] = rules.foundFactionAuthority;
    r["foundFactionCost"]      = rules.foundFactionCost;
    r["nameMinLen"]            = rules.nameMinLen;
    r["nameMaxLen"]            = rules.nameMaxLen;
    out["rules"] = std::move(r);
    return out;
}

nlohmann::json WorldFactions::MeJson(sqlite3* db, const std::string& worldId,
                                     int64_t accountId, const WorldFactionRules& rules,
                                     int64_t nowRealMs) {
    nlohmann::json out;
    out["worldId"]   = worldId;
    out["accountId"] = accountId;

    const auto a = AuthorityFor(db, worldId, accountId, rules, nowRealMs);
    out["authority"] = a.authority;
    out["capacity"]  = a.capacity;
    out["canFound"]  = a.authority >= rules.foundFactionAuthority;

    if (const auto m = MembershipFor(db, worldId, accountId)) {
        nlohmann::json j;
        j["factionId"] = m->factionId;
        j["role"]      = m->role;
        j["rank"]      = m->rank;
        j["joinedAt"]  = m->joinedAt;
        if (const auto f = Load(db, worldId, m->factionId)) {
            j["name"]   = f->name;
            j["colour"] = f->colour;
            if (f->sideKey.empty()) j["sideKey"] = nullptr;
            else                    j["sideKey"] = f->sideKey;
        }
        out["membership"] = std::move(j);
    } else {
        out["membership"] = nullptr;
    }
    return out;
}

nlohmann::json WorldFactions::AttachFactions(nlohmann::json poisJson, sqlite3* db,
                                             const std::string& worldId) {
    nlohmann::json map = nlohmann::json::object();
    for (const auto& f : ListFor(db, worldId)) {
        nlohmann::json j;
        j["name"]      = f.name;
        j["colour"]    = f.colour;
        j["archetype"] = f.archetype;
        j["state"]     = f.state;
        map[f.factionId] = std::move(j);
    }
    poisJson["factions"] = std::move(map);
    return poisJson;
}
