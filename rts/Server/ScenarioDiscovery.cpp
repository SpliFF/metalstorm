// ScenarioDiscovery — implementation. See ScenarioDiscovery.h for the design.
//
// Reads scenario files with a bare lua_State rather than through
// ConfigReader. ConfigReader's contract is a *flat* metadata table read
// through GetString/GetInt/GetBool off stack index 1; a scenario is nested
// (`world.map`) and has an array of objective tables to walk for the
// `victory` flag. Rather than widen ConfigReader's public surface with
// nested accessors that only one caller wants, this file keeps its own
// short-lived state and does the walk inline.
//
// Nothing here executes scenario content — the table is evaluated and read,
// then the state is closed. `game_scenario.lua` still owns validation
// (`validate()` against the real def names) at GameStart; this module reads
// only the four fields the lobby needs to *offer* a scenario.

#include "ScenarioDiscovery.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "scenario-disc"

// See the comment in ConfigReader.cpp: the bundled Lua is compiled as C++,
// so these headers must NOT be wrapped in extern "C".
#include "lauxlib.h"
#include "lua.h"
#include "lualib.h"

#include <algorithm>
#include <filesystem>
#include <string>

namespace fs = std::filesystem;

namespace {

/// Read a string field off the table at `index`. Returns `fallback` when
/// the field is missing or not a string.
std::string GetStringField(lua_State* L, int index, const char* key,
                           const std::string& fallback = {}) {
    lua_getfield(L, index, key);
    std::string out = fallback;
    if (lua_isstring(L, -1))
        out = lua_tostring(L, -1);
    lua_pop(L, 1);
    return out;
}

/// Read a boolean field off the table at `index`. Only a real Lua boolean
/// counts — a missing field yields `fallback` rather than Lua's usual
/// nil-is-false, so "absent" and "explicitly false" stay distinguishable
/// if a caller ever needs that.
bool GetBoolField(lua_State* L, int index, const char* key,
                  bool fallback = false) {
    lua_getfield(L, index, key);
    bool out = fallback;
    if (lua_isboolean(L, -1))
        out = lua_toboolean(L, -1) != 0;
    lua_pop(L, 1);
    return out;
}

/// True when the `objectives` array on the table at `index` contains any
/// entry with `victory = true`.
///
/// Deliberately a plain scan of the array part: `game_scenario.lua`'s
/// stageObjectives copies `victory = o.victory` straight through to
/// game_objectives, and game_gameover watches exactly that flag. If the
/// scenario format ever grows a second terminal shape, this predicate is
/// the one place the lobby's notion of "can this war end" has to follow.
bool HasVictoryObjective(lua_State* L, int index) {
    lua_getfield(L, index, "objectives");
    if (!lua_istable(L, -1)) {
        lua_pop(L, 1);
        return false;
    }
    const int objectives = lua_gettop(L);
    bool found = false;
    const lua_Integer n = static_cast<lua_Integer>(lua_rawlen(L, objectives));
    for (lua_Integer i = 1; i <= n && !found; ++i) {
        lua_rawgeti(L, objectives, i);
        if (lua_istable(L, -1))
            found = GetBoolField(L, lua_gettop(L), "victory", false);
        lua_pop(L, 1);
    }
    lua_pop(L, 1);
    return found;
}

/// Collect the distinct `team` values named by the array field `key` on the
/// table at `index` (`units`, `ai`, …). Entries with no numeric `team` are
/// ignored — `stageUnits` treats those as "any team" and so does this.
std::vector<uint8_t> CollectTeams(lua_State* L, int index, const char* key) {
    std::vector<uint8_t> out;
    lua_getfield(L, index, key);
    if (!lua_istable(L, -1)) {
        lua_pop(L, 1);
        return out;
    }
    const int arr = lua_gettop(L);
    const lua_Integer n = static_cast<lua_Integer>(lua_rawlen(L, arr));
    for (lua_Integer i = 1; i <= n; ++i) {
        lua_rawgeti(L, arr, i);
        if (lua_istable(L, -1)) {
            lua_getfield(L, -1, "team");
            if (lua_isnumber(L, -1)) {
                const auto team =
                    static_cast<uint8_t>(lua_tointeger(L, -1));
                if (std::find(out.begin(), out.end(), team) == out.end())
                    out.push_back(team);
            }
            lua_pop(L, 1);
        }
        lua_pop(L, 1);
    }
    lua_pop(L, 1);
    return out;
}

/// Read the `sides` block and collapse it to one entry per faction, applying
/// the §7.4 resolution rule. See ScenarioDiscovery.h's ScenarioSide for why
/// the unit of a room slot is a side rather than a team.
std::vector<ScenarioDiscovery::ScenarioSide> ReadSides(lua_State* L, int index) {
    std::vector<ScenarioDiscovery::ScenarioSide> out;

    const std::vector<uint8_t> unitTeams = CollectTeams(L, index, "units");
    const std::vector<uint8_t> aiTeams = CollectTeams(L, index, "ai");

    lua_getfield(L, index, "sides");
    if (!lua_istable(L, -1)) {
        lua_pop(L, 1);
        return out;
    }
    const int sides = lua_gettop(L);
    const lua_Integer n = static_cast<lua_Integer>(lua_rawlen(L, sides));
    for (lua_Integer i = 1; i <= n; ++i) {
        lua_rawgeti(L, sides, i);
        if (lua_istable(L, -1)) {
            const int entry = lua_gettop(L);
            const std::string faction = GetStringField(L, entry, "faction");
            lua_getfield(L, entry, "team");
            const bool hasTeam = lua_isnumber(L, -1) != 0;
            const auto team = static_cast<uint8_t>(lua_tointeger(L, -1));
            lua_pop(L, 1);

            if (!faction.empty() && hasTeam) {
                // Group by faction, preserving first-declaration order — the
                // first playable side is the one a room's host is seated on,
                // so the order the author wrote is the order the lobby shows.
                auto it = std::find_if(
                    out.begin(), out.end(),
                    [&](const ScenarioDiscovery::ScenarioSide& s) {
                        return s.faction == faction;
                    });
                if (it == out.end()) {
                    ScenarioDiscovery::ScenarioSide s;
                    s.faction = faction;
                    out.push_back(std::move(s));
                    it = out.end() - 1;
                }
                if (std::find(it->teams.begin(), it->teams.end(), team) ==
                    it->teams.end())
                    it->teams.push_back(team);
            }
        }
        lua_pop(L, 1);
    }
    lua_pop(L, 1);

    const auto contains = [](const std::vector<uint8_t>& v, uint8_t t) {
        return std::find(v.begin(), v.end(), t) != v.end();
    };

    for (auto& side : out) {
        std::sort(side.teams.begin(), side.teams.end());

        // Rule 3: the lowest declared team the scenario actually stages a
        // starting force for. Without this the lobby would happily seat a
        // player on a side's *second* team and hand them an empty army —
        // which, on the AI's slot, is exactly endtoend D19.
        side.team = side.teams.empty() ? 0 : side.teams.front();
        for (const uint8_t t : side.teams) {
            if (contains(unitTeams, t)) {
                side.team = t;
                side.staged = true;
                break;
            }
        }

        // Rule 2: an NPC side is one whose every declared team is claimed by
        // a `scenario.ai` entry. Data-driven, so Meridian's `reavers` is
        // excluded by what the scenario says rather than by its name.
        side.npc = !side.teams.empty();
        for (const uint8_t t : side.teams) {
            if (!contains(aiTeams, t)) {
                side.npc = false;
                break;
            }
        }
    }

    return out;
}

/// Evaluate one scenario file and fill `out`. Returns false when the file
/// does not evaluate to a table — a scenario that needs sim globals at
/// file scope lands here, is logged once, and is simply not offered.
bool LoadOne(const fs::path& file, ScenarioDiscovery::ScenarioInfo& out) {
    lua_State* L = luaL_newstate();
    if (L == nullptr)
        return false;
    luaL_openlibs(L);

    bool ok = false;
    if (luaL_loadfile(L, file.string().c_str()) != LUA_OK ||
        lua_pcall(L, 0, 1, 0) != LUA_OK) {
        SLOG(SPRING_LOG_WARNING, "%s: not offered (%s)", file.string().c_str(),
             lua_isstring(L, -1) ? lua_tostring(L, -1) : "load failed");
    } else if (!lua_istable(L, -1)) {
        SLOG(SPRING_LOG_WARNING, "%s: not offered (did not return a table)",
             file.string().c_str());
    } else {
        const int scn = lua_gettop(L);
        out.id = file.stem().string();
        out.displayName = GetStringField(L, scn, "name", out.id);
        if (out.displayName.empty())
            out.displayName = out.id;
        out.tutorial = GetBoolField(L, scn, "tutorial", false);
        out.retired = GetBoolField(L, scn, "retired", false);
        out.terminal = HasVictoryObjective(L, scn);
        out.sides = ReadSides(L, scn);

        // `world.map` names the map the scenario is authored for. A
        // scenario with no `world` table (or no `map` in it) simply has no
        // map affinity and is never auto-applied.
        lua_getfield(L, scn, "world");
        if (lua_istable(L, -1))
            out.mapId = GetStringField(L, lua_gettop(L), "map", "");
        lua_pop(L, 1);

        ok = true;
    }

    lua_close(L);
    return ok;
}

} // namespace

namespace ScenarioDiscovery {

std::vector<ScenarioInfo> Discover(const std::string& gamePath) {
    std::vector<ScenarioInfo> out;

    std::error_code ec;
    const fs::path dir = fs::path(gamePath) / "scenarios";
    if (!fs::is_directory(dir, ec)) {
        // Not an error: most games ship no scenarios at all.
        return out;
    }

    for (const auto& entry : fs::directory_iterator(dir, ec)) {
        if (ec)
            break;
        if (!entry.is_regular_file(ec))
            continue;
        if (entry.path().extension() != ".lua")
            continue;
        ScenarioInfo info;
        if (LoadOne(entry.path(), info))
            out.push_back(std::move(info));
    }

    std::sort(out.begin(), out.end(),
              [](const ScenarioInfo& a, const ScenarioInfo& b) {
                  return a.id < b.id;
              });

    if (!out.empty()) {
        SLOG(SPRING_LOG_INFO, "discovered %zu scenario(s) in '%s'", out.size(),
             dir.string().c_str());
        for (const auto& s : out) {
            SLOG(SPRING_LOG_INFO, "  - %s (%s) map='%s'%s%s%s sides='%s'",
                 s.displayName.c_str(), s.id.c_str(), s.mapId.c_str(),
                 s.tutorial ? " tutorial" : "",
                 s.retired ? " RETIRED-NOT-OFFERED" : "",
                 s.terminal ? " terminal" : " NO-TERMINAL-CONDITION",
                 EncodeWarSides(s).c_str());
            for (const auto& side : s.sides) {
                if (side.npc || side.staged)
                    continue;
                // A playable side the scenario stages no starting force for
                // is a room slot that begins with no army (endtoend D19).
                SLOG(SPRING_LOG_WARNING,
                     "    scenario '%s' side '%s' resolves to team %u, which "
                     "it stages no starting units for — a player or AI on "
                     "that side would start with nothing",
                     s.id.c_str(), side.faction.c_str(),
                     static_cast<unsigned>(side.team));
            }
        }
    }

    return out;
}

const ScenarioInfo* DefaultForMap(const std::vector<ScenarioInfo>& scenarios,
                                  const std::string& mapId) {
    if (mapId.empty())
        return nullptr;

    const ScenarioInfo* best = nullptr;
    for (const auto& s : scenarios) {
        if (s.tutorial || s.retired || !s.terminal || s.mapId != mapId)
            continue;
        // Lowest id, so the pick is deterministic no matter what order the
        // directory iterator gave us.
        if (best == nullptr || s.id < best->id)
            best = &s;
    }
    return best;
}

std::vector<ScenarioSide> PlayableSides(const ScenarioInfo& info) {
    std::vector<ScenarioSide> out;
    for (const auto& s : info.sides) {
        if (!s.npc)
            out.push_back(s);
    }
    return out;
}

std::string EncodeWarSides(const ScenarioInfo& info) {
    std::string out;
    for (const auto& s : PlayableSides(info)) {
        // The faction key is authored content, but it lands in a modoption
        // that is split on ',' and ':' downstream — a key containing either
        // would silently reshape the list, so skip it rather than emit a
        // string no parser can recover.
        if (s.faction.find(',') != std::string::npos ||
            s.faction.find(':') != std::string::npos) {
            SLOG(SPRING_LOG_WARNING,
                 "scenario '%s': side faction '%s' contains ',' or ':' and "
                 "cannot be encoded as a war_sides entry — side dropped",
                 info.id.c_str(), s.faction.c_str());
            continue;
        }
        if (!out.empty())
            out += ',';
        out += s.faction;
        out += ':';
        out += std::to_string(static_cast<unsigned>(s.team));
    }
    return out;
}

const ScenarioInfo* FindById(const std::vector<ScenarioInfo>& scenarios,
                             const std::string& id) {
    if (id.empty())
        return nullptr;
    for (const auto& s : scenarios) {
        if (s.id == id)
            return &s;
    }
    return nullptr;
}

} // namespace ScenarioDiscovery
