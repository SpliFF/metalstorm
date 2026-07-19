// LuaExecEngine — executes Lua code in specific contexts.

#include "LuaExecEngine.h"
#include "System/SpringLog/SpringLog.h"

#include "Lua/LuaRules.h"
#include "Lua/LuaGaia.h"
#include "Lua/LuaHandle.h"
#include "Lua/LuaCallInProfiler.h"
#include "Server/SimFrameProfiler.h"

#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Weapons/Weapon.h"
#include "Sim/Weapons/WeaponDef.h"
#include "Sim/Weapons/WeaponDefHandler.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Misc/LosHandler.h"
#include "Server/LuaDebugger.h"
#include "Server/DebugFlags.h"
#include "Server/CombatEventCollector.h"
#include "Server/SoundEventCollector.h"


// Lua compiled as C++ in this project
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>

#include <sstream>
#include <string>
#include <cstring>
#include <vector>
#include <atomic>

#define LOG_SECTION "exec"

namespace {

// Serialize a Lua value at the given stack index to a JSON-ish string.
// Handles: string, number, boolean, nil, table (1 level deep).
std::string LuaValueToString(lua_State* L, int idx, int depth = 0) {
    int t = lua_type(L, idx);
    switch (t) {
        case LUA_TNIL:    return "nil";
        case LUA_TBOOLEAN: return lua_toboolean(L, idx) ? "true" : "false";
        case LUA_TNUMBER:  {
            char buf[64];
            if (lua_isinteger(L, idx))
                snprintf(buf, sizeof(buf), "%lld", (long long)lua_tointeger(L, idx));
            else
                snprintf(buf, sizeof(buf), "%.6g", lua_tonumber(L, idx));
            return buf;
        }
        case LUA_TSTRING:  return lua_tostring(L, idx);
        case LUA_TTABLE: {
            if (depth > 2) return "{...}";
            std::string result = "{";
            bool first = true;
            lua_pushnil(L);
            while (lua_next(L, idx < 0 ? idx - 1 : idx)) {
                if (!first) result += ", ";
                first = false;
                // Key
                if (lua_type(L, -2) == LUA_TSTRING)
                    result += std::string(lua_tostring(L, -2)) + " = ";
                else if (lua_type(L, -2) == LUA_TNUMBER) {
                    char buf[32];
                    snprintf(buf, sizeof(buf), "[%.0f] = ", lua_tonumber(L, -2));
                    result += buf;
                }
                // Value
                result += LuaValueToString(L, -1, depth + 1);
                lua_pop(L, 1);
                if (result.size() > 4096) { result += ", ...}"; return result; }
            }
            result += "}";
            return result;
        }
        default: {
            char buf[64];
            snprintf(buf, sizeof(buf), "<%s>", lua_typename(L, t));
            return buf;
        }
    }
}

// Execute Lua code in a given lua_State, return result string.
std::string ExecuteInLuaState(lua_State* L, const std::string& code) {
    if (!L) return "error: Lua state is null";

    int top = lua_gettop(L);

    // Try loading as expression first (prepend "return ")
    std::string expr = "return " + code;
    int err = luaL_loadstring(L, expr.c_str());
    if (err != LUA_OK) {
        lua_pop(L, 1);
        // Try as statement
        err = luaL_loadstring(L, code.c_str());
        if (err != LUA_OK) {
            std::string msg = lua_tostring(L, -1);
            lua_pop(L, 1);
            return "syntax error: " + msg;
        }
    }

    err = lua_pcall(L, 0, LUA_MULTRET, 0);
    if (err != LUA_OK) {
        std::string msg = lua_tostring(L, -1);
        lua_pop(L, 1);
        return "runtime error: " + msg;
    }

    // Collect return values
    int nresults = lua_gettop(L) - top;
    if (nresults == 0) return "ok";

    std::string result;
    for (int i = 1; i <= nresults; i++) {
        if (i > 1) result += "\t";
        result += LuaValueToString(L, top + i);
    }

    lua_settop(L, top);
    return result;
}

// Execute a built-in server command (not Lua)
std::string ExecuteServerCommand(const std::string& cmd) {
    if (cmd == "frame") {
        return std::to_string(gs->frameNum);
    }
    if (cmd == "state") {
        std::ostringstream ss;
        ss << "frame=" << gs->frameNum
           << " teams=" << teamHandler.ActiveTeams()
           << " units=" << unitHandler.GetActiveUnits().size();
        return ss.str();
    }
    if (cmd.rfind("units", 0) == 0) {
        // "units" or "units <teamId>"
        int filterTeam = -1;
        if (cmd.size() > 6) filterTeam = std::atoi(cmd.c_str() + 6);

        std::ostringstream ss;
        int count = 0;
        for (const CUnit* u : unitHandler.GetActiveUnits()) {
            if (!u) continue;
            if (filterTeam >= 0 && u->team != filterTeam) continue;
            if (count > 0) ss << "\n";
            ss << "id=" << u->id << " def=" << u->unitDef->name
               << " team=" << u->team
               << " hp=" << u->health << "/" << u->maxHealth;
            count++;
            if (count > 100) { ss << "\n... (" << unitHandler.GetActiveUnits().size() << " total)"; break; }
        }
        if (count == 0) ss << "(no units)";
        return ss.str();
    }
    if (cmd == "defs") {
        std::ostringstream ss;
        ss << "unit defs: " << unitDefHandler->NumUnitDefs()
           << ", weapon defs: " << weaponDefHandler->NumWeaponDefs();
        return ss.str();
    }
    if (cmd == "pause") {
        gs->paused = true;
        return "paused";
    }
    if (cmd == "unpause") {
        gs->paused = false;
        return "unpaused";
    }
    if (cmd.rfind("speed ", 0) == 0) {
        float spd = std::atof(cmd.c_str() + 6);
        if (spd > 0.0f && spd <= 100.0f) {
            // Set both: `speedFactor` is the currently-applied speed
            // (the upstream engine lowers it under lag); the sim loop
            // in server_main.cpp reads `wantedSpeedFactor` every tick
            // to recompute the tick interval. Keep them in sync.
            gs->wantedSpeedFactor = spd;
            gs->speedFactor = spd;
            char buf[64];
            snprintf(buf, sizeof(buf), "speed set to %.1f", spd);
            return buf;
        }
        return "invalid speed (0-100)";
    }
    // Debugger commands
    if (cmd == "continue" || cmd == "c") {
        g_luaDebugger.Continue();
        return "resumed";
    }
    if (cmd == "step" || cmd == "s") {
        g_luaDebugger.StepLine();
        return "stepping";
    }
    if (cmd == "step_over" || cmd == "n") {
        g_luaDebugger.StepOver();
        return "step over";
    }
    if (cmd == "step_out" || cmd == "o") {
        g_luaDebugger.StepOut();
        return "step out";
    }
    if (cmd.rfind("break ", 0) == 0) {
        // "break file.lua:42"
        std::string spec = cmd.substr(6);
        auto colon = spec.rfind(':');
        if (colon == std::string::npos) return "usage: break file.lua:line";
        std::string file = spec.substr(0, colon);
        int line = std::atoi(spec.substr(colon + 1).c_str());
        int id = g_luaDebugger.AddBreakpoint(file, line);
        return "breakpoint " + std::to_string(id) + " set";
    }
    if (cmd == "break clear") {
        g_luaDebugger.ClearBreakpoints();
        return "all breakpoints cleared";
    }
    if (cmd == "break list") {
        auto bps = g_luaDebugger.ListBreakpoints();
        if (bps.empty()) return "(no breakpoints)";
        std::ostringstream ss;
        for (const auto& bp : bps) {
            ss << "#" << bp.id << " " << bp.file << ":" << bp.line << "\n";
        }
        return ss.str();
    }

    // -------- Test-harness verbs (PLAN: spring-test) --------
    //
    // These delegate to Spring.* via the LuaRules synced state so they
    // honour AllowUnitCreation / AllowCommand veto rules and routing
    // through ScriptEventDispatcher matches what a real player would
    // get. Calling unitHandler / commandAI directly from the HTTP path
    // would skip those hooks and produce subtly different sim state.
    auto runOnLuaRules = [](const std::string& code) -> std::string {
        if (!luaRules) return "error: LuaRules not loaded (no game running?)";
        return ExecuteInLuaState(luaRules->syncedLuaHandle.GetLuaState(), code);
    };

    // log <subsystem> on|off|status
    if (cmd.rfind("log ", 0) == 0) {
        std::istringstream is(cmd.substr(4));
        std::string subsystem, action;
        is >> subsystem >> action;
        if (subsystem.empty()) {
            return "usage: log <combat|sound|weapon|explosion|order|unit|script> on|off|status";
        }
        // 'log status' alone reports every flag.
        if (subsystem == "status" && action.empty()) {
            std::ostringstream ss;
            ss << "combat="    << (g_debugFlags.combat   .load() ? "on" : "off")
               << " sound="    << (g_debugFlags.sound    .load() ? "on" : "off")
               << " weapon="   << (g_debugFlags.weapon   .load() ? "on" : "off")
               << " explosion="<< (g_debugFlags.explosion.load() ? "on" : "off")
               << " order="    << (g_debugFlags.order    .load() ? "on" : "off")
               << " unit="     << (g_debugFlags.unit     .load() ? "on" : "off")
               << " script="   << (g_debugFlags.script   .load() ? "on" : "off");
            return ss.str();
        }
        std::atomic<bool>* flag = DebugFlagByName(subsystem);
        if (!flag) return "error: unknown subsystem '" + subsystem + "'";
        if (action == "status" || action.empty()) {
            return subsystem + "=" + (flag->load() ? "on" : "off");
        }
        if (action == "on" || action == "true" || action == "1") {
            flag->store(true);
            // Most subsystem-gated SLOGs (CWeapon::Fire, CombatEventCollector,
            // SoundEventCollector) emit at SPRING_LOG_INFO, which is below the
            // default min level of SPRING_LOG_NOTICE — without lifting the
            // floor here the toggle silently does nothing. Documented in
            // memory/project_zk_aim_bench.md as the "debug-log gotcha".
            springlog_set_min_level(SPRING_LOG_INFO);
            return subsystem + "=on";
        }
        if (action == "off" || action == "false" || action == "0") {
            flag->store(false);
            // Restore the default floor only when every flag is now off, so
            // that toggling one subsystem off doesn't mute another that's
            // still enabled.
            if (!AnyDebugFlagOn())
                springlog_set_min_level(SPRING_LOG_NOTICE);
            return subsystem + "=off";
        }
        return "usage: log " + subsystem + " on|off|status";
    }

    // spawn <defName> <x> <z> [team=0] [count=1]
    if (cmd.rfind("spawn ", 0) == 0) {
        std::istringstream is(cmd.substr(6));
        std::string defName;
        float x = 0, z = 0;
        int team = 0, count = 1;
        is >> defName >> x >> z >> team >> count;
        if (defName.empty()) {
            return "usage: spawn <defName> <x> <z> [team=0] [count=1]";
        }
        if (count < 1) count = 1;
        if (count > 256) count = 256;
        // Pre-revive a dead target team so Spring.CreateUnit doesn't
        // raise a Lua error. ZK's game_over.lua flags teams isDead at
        // frame 45 when they have no units (the scenario host never
        // picks a faction, and the AI slot has no start_unit). After
        // that, Spring.CreateUnit calls luaL_error and aborts the
        // whole snippet; Spring.TransferUnit silently no-ops on a
        // dead team. Resetting isDead at the C++ level here lets the
        // straightforward `Spring.CreateUnit(...team)` path work.
        if (team >= 0 && team < teamHandler.ActiveTeams()) {
            CTeam* t = teamHandler.Team(team);
            if (t && t->isDead) {
                t->isDead = false;
                SLOG(SPRING_LOG_NOTICE, "spawn: revived dead team %d", team);
            }
        }
        std::ostringstream lua;
        lua << "local targetTeam = " << team << "\n"
            << "local ids = {}\n"
            << "for i = 1, " << count << " do\n"
            << "  local ox, oz = 0, 0\n"
            << "  if " << count << " > 1 then\n"
            << "    local n = math.ceil(math.sqrt(" << count << "))\n"
            << "    ox = ((i - 1) % n) * 48\n"
            << "    oz = math.floor((i - 1) / n) * 48\n"
            << "  end\n"
            << "  local px, pz = " << x << " + ox, " << z << " + oz\n"
            << "  local py = Spring.GetGroundHeight(px, pz)\n"
            << "  local ok, id = pcall(Spring.CreateUnit, '" << defName << "', px, py, pz, 0, targetTeam)\n"
            << "  if ok and id then ids[#ids+1] = id end\n"
            << "end\n"
            << "return 'spawned ' .. #ids .. ' unit(s): ' .. table.concat(ids, ',')\n";
        return runOnLuaRules(lua.str());
    }

    // revive_team <teamId|all>  — flip team.isDead back to false. ZK's
    // game_over.lua marks teams dead at frame 45 when they have no
    // units; scenarios that want to spawn units onto those teams call
    // this first. Combined with `cheats on` (which makes ZK skip the
    // periodic check), this keeps the test world stable indefinitely.
    if (cmd.rfind("revive_team", 0) == 0 && (cmd.size() == 11 || cmd[11] == ' ')) {
        std::string arg = cmd.size() > 12 ? cmd.substr(12) : "all";
        int revived = 0;
        if (arg == "all") {
            for (int i = 0; i < teamHandler.ActiveTeams(); ++i) {
                CTeam* t = teamHandler.Team(i);
                if (t && t->isDead) { t->isDead = false; revived++; }
            }
        } else {
            int teamId = std::atoi(arg.c_str());
            if (teamId < 0 || teamId >= teamHandler.ActiveTeams())
                return "usage: revive_team <teamId|all>";
            CTeam* t = teamHandler.Team(teamId);
            if (!t) return "no such team";
            if (t->isDead) { t->isDead = false; revived = 1; }
        }
        return std::string("revived ") + std::to_string(revived) + " team(s)";
    }

    // kill <unitId> [selfDestruct=0] [reclaimed=0]
    if (cmd.rfind("kill ", 0) == 0) {
        std::istringstream is(cmd.substr(5));
        int unitId = 0, selfD = 0, reclaim = 0;
        is >> unitId >> selfD >> reclaim;
        if (unitId <= 0) return "usage: kill <unitId> [selfDestruct=0] [reclaimed=0]";
        std::ostringstream lua;
        lua << "Spring.DestroyUnit(" << unitId << ", "
            << (selfD ? "true" : "false") << ", "
            << (reclaim ? "true" : "false") << ")\n"
            << "return 'killed ' .. " << unitId;
        return runOnLuaRules(lua.str());
    }

    // damage <unitId> <amount> [paralyze=0]
    if (cmd.rfind("damage ", 0) == 0) {
        std::istringstream is(cmd.substr(7));
        int unitId = 0, paralyze = 0;
        float amount = 0;
        is >> unitId >> amount >> paralyze;
        if (unitId <= 0 || amount <= 0) {
            return "usage: damage <unitId> <amount> [paralyze=0]";
        }
        std::ostringstream lua;
        lua << "Spring.AddUnitDamage(" << unitId << ", " << amount << ", "
            << paralyze << ", -1, -1)\n"
            << "local h = Spring.GetUnitHealth(" << unitId << ")\n"
            << "return 'unit " << unitId << " hp=' .. tostring(h)";
        return runOnLuaRules(lua.str());
    }

    // order <unitId> <cmdId> [param1] [param2] [param3] [param4] [opts=0]
    // Numeric-only order issuance; for symbolic names, use exec_lua with
    // CMD.MOVE etc. directly.
    if (cmd.rfind("order ", 0) == 0) {
        std::istringstream is(cmd.substr(6));
        int unitId = 0, cmdId = 0, opts = 0;
        std::vector<float> params;
        is >> unitId >> cmdId;
        if (unitId <= 0) return "usage: order <unitId> <cmdId> [params...] [opts=0]";
        // Read up to 4 params + opts. The rule: if exactly 5 numbers
        // remain after cmdId, the last is opts; otherwise everything is
        // params and opts defaults to 0.
        std::vector<float> rest;
        float v;
        while (is >> v) rest.push_back(v);
        if (rest.size() == 5) {
            params.assign(rest.begin(), rest.begin() + 4);
            opts = (int)rest[4];
        } else {
            params = rest;
        }
        std::ostringstream lua;
        lua << "Spring.GiveOrderToUnit(" << unitId << ", " << cmdId << ", {";
        for (size_t i = 0; i < params.size(); ++i) {
            if (i) lua << ", ";
            lua << params[i];
        }
        lua << "}, " << opts << ")\n"
            << "return 'order " << cmdId << " issued to " << unitId << "'";
        return runOnLuaRules(lua.str());
    }

    // clear [team=-1]    — destroys all units (or all on a single team).
    if (cmd.rfind("clear", 0) == 0) {
        int team = -1;
        if (cmd.size() > 6) team = std::atoi(cmd.c_str() + 6);
        std::ostringstream lua;
        if (team < 0) {
            lua << "local ids = Spring.GetAllUnits()\n";
        } else {
            lua << "local ids = Spring.GetTeamUnits(" << team << ")\n";
        }
        lua << "for _, id in ipairs(ids) do Spring.DestroyUnit(id, false, true) end\n"
            << "return 'cleared ' .. #ids .. ' unit(s)'";
        return runOnLuaRules(lua.str());
    }

    // stockpile <unitId> <count> [queued=0]  — insta-fill the unit's
    // stockpile weapon. The natural build cycle takes minutes per missile;
    // this skips it for test harness use. Sets `numStockpiled` directly so
    // CMD_MANUALFIRE / CMD_ATTACK works on the next tick.
    //
    // Spring.SetUnitStockpile silently no-ops when stockpileWeapon is null,
    // which is what made the Lua-only path flaky from `weapon-showcase`.
    // Here we walk weapons[] to find the stockpile weapon if it isn't
    // wired yet (it should be — CWeapon::Init() sets it during PostInit,
    // synchronous with CreateUnit — but defensive search is cheap).
    if (cmd.rfind("stockpile ", 0) == 0) {
        std::istringstream is(cmd.substr(10));
        int unitId = 0, count = 0, queued = 0;
        is >> unitId >> count >> queued;
        if (unitId <= 0 || count < 0) {
            return "usage: stockpile <unitId> <count> [queued=0]";
        }
        CUnit* u = unitHandler.GetUnit((unsigned)unitId);
        if (!u) return "no such unit";

        CWeapon* w = u->stockpileWeapon;
        if (w == nullptr) {
            for (CWeapon* candidate : u->weapons) {
                if (candidate && candidate->weaponDef && candidate->weaponDef->stockpile) {
                    w = candidate;
                    u->stockpileWeapon = candidate;
                    break;
                }
            }
        }
        if (w == nullptr) return "unit has no stockpile weapon";

        w->numStockpiled = count;
        w->numStockpileQued = std::max(0, queued);
        if (u->commandAI) u->commandAI->UpdateStockpileIcon();

        std::ostringstream ss;
        ss << "unit " << unitId
           << " stockpile=" << w->numStockpiled
           << " queued=" << w->numStockpileQued;
        return ss.str();
    }

    // unit_state <unitId>  — dump health/pos/team/weapons.
    if (cmd.rfind("unit_state ", 0) == 0) {
        int unitId = std::atoi(cmd.c_str() + 11);
        if (unitId <= 0) return "usage: unit_state <unitId>";
        const CUnit* u = unitHandler.GetUnit((unsigned)unitId);
        if (!u) return "no such unit";
        std::ostringstream ss;
        ss << "id=" << u->id
           << " def=" << u->unitDef->name
           << " team=" << u->team
           << " hp=" << u->health << "/" << u->maxHealth
           << " pos=(" << u->pos.x << "," << u->pos.y << "," << u->pos.z << ")"
           << " heading=" << u->heading
           << " weapons=" << u->weapons.size();
        for (size_t i = 0; i < u->weapons.size(); ++i) {
            const CWeapon* w = u->weapons[i];
            if (!w || !w->weaponDef) continue;
            ss << "\n  w" << i
               << " def=" << w->weaponDef->name
               << " range=" << w->range
               << " reloadFrame=" << w->reloadStatus
               << " hasTarget=" << (w->HaveTarget() ? "yes" : "no");
        }
        return ss.str();
    }

    // los [on|off|status]  — toggle globalLOS for every active ally team.
    // Equivalent to typing `/globalLOS 1` in stock Spring for each ally team.
    // No arg or "status" returns the current state (per-team).
    if (cmd.rfind("los", 0) == 0 && (cmd.size() == 3 || cmd[3] == ' ')) {
        std::string arg = cmd.size() > 4 ? cmd.substr(4) : "status";
        if (!losHandler) return "error: LosHandler not initialised";
        if (arg == "status") {
            std::ostringstream ss;
            for (int at = 0; at < teamHandler.ActiveAllyTeams(); ++at) {
                if (at > 0) ss << " ";
                ss << "ally" << at << "=" << (losHandler->GetGlobalLOS(at) ? "on" : "off");
            }
            return ss.str();
        }
        bool enable = (arg == "on" || arg == "true" || arg == "1");
        for (int at = 0; at < teamHandler.ActiveAllyTeams(); ++at)
            losHandler->SetGlobalLOS(at, enable);
        return std::string("globalLOS=") + (enable ? "on" : "off")
             + " (applied to " + std::to_string(teamHandler.ActiveAllyTeams()) + " ally team(s))";
    }

    // cheats [on|off|status]  — toggle gs->cheatEnabled and gs->godMode together.
    // godMode is set to 7 (all flags: god build / god control / god vision) when on.
    if (cmd.rfind("cheats", 0) == 0 && (cmd.size() == 6 || cmd[6] == ' ')) {
        std::string arg = cmd.size() > 7 ? cmd.substr(7) : "status";
        if (arg == "status") {
            std::ostringstream ss;
            ss << "cheatEnabled=" << (gs->cheatEnabled ? "on" : "off")
               << " godMode=" << gs->godMode;
            return ss.str();
        }
        bool enable = (arg == "on" || arg == "true" || arg == "1");
        gs->cheatEnabled = enable;
        gs->godMode = enable ? 7 : 0;
        return std::string("cheats=") + (enable ? "on" : "off");
    }

    // invulnerable <unitId> [on|off]  — short-circuits CUnit::DoDamage when on.
    // Default action when [on|off] is omitted is "on".
    if (cmd.rfind("invulnerable", 0) == 0 && (cmd.size() == 12 || cmd[12] == ' ')) {
        std::istringstream is(cmd.substr(12));
        int unitId = 0;
        std::string arg;
        is >> unitId >> arg;
        if (unitId <= 0) return "usage: invulnerable <unitId> [on|off]";
        CUnit* u = unitHandler.GetUnit((unsigned)unitId);
        if (!u) return "no such unit";
        if (arg.empty() || arg == "on" || arg == "true" || arg == "1") {
            u->invulnerable = true;
        } else if (arg == "off" || arg == "false" || arg == "0") {
            u->invulnerable = false;
        } else if (arg == "status") {
            // fall through to status return below
        } else {
            return "usage: invulnerable <unitId> [on|off|status]";
        }
        std::ostringstream ss;
        ss << "unit " << unitId << " invulnerable=" << (u->invulnerable ? "on" : "off");
        return ss.str();
    }

    // lua profile [on|off|reset|status|<topN>]  — server-side synced Lua
    // per-callin wall-time profiler (PLAN-performance.md Phase 4.1).
    //   on     enable accumulation     off    disable (keeps samples)
    //   reset  clear samples           status  one-line state
    //   <none> or <N>  ranked report (top N rows, default 25)
    if (cmd == "lua profile" || cmd.rfind("lua profile ", 0) == 0) {
        std::string arg = (cmd.size() > 12) ? cmd.substr(12) : "";
        // trim leading spaces
        while (!arg.empty() && arg.front() == ' ') arg.erase(arg.begin());

        if (arg == "on" || arg == "1" || arg == "true") {
            LuaCallInProfiler::SetEnabled(true);
            return "lua profile: on";
        }
        if (arg == "off" || arg == "0" || arg == "false") {
            LuaCallInProfiler::SetEnabled(false);
            return "lua profile: off (samples retained; `lua profile reset` to clear)";
        }
        if (arg == "reset" || arg == "clear") {
            LuaCallInProfiler::Reset();
            return "lua profile: samples cleared";
        }
        if (arg == "status") {
            return std::string("lua profile: ") + (LuaCallInProfiler::IsEnabled() ? "on" : "off");
        }
        // Empty or numeric → report (numeric overrides the row cap).
        int topN = 25;
        if (!arg.empty()) {
            int parsed = std::atoi(arg.c_str());
            if (parsed > 0) topN = parsed;
        }
        return LuaCallInProfiler::Report(topN);
    }

    // sim profile [on|off|reset|status]  — CSimulation::SimFrame()
    // per-phase wall-time profiler (PLAN-server-cpp-optimisation.md P0):
    // native sim vs unit-script tick vs synced Lua call-ins. Complements
    // `lua profile` (per handle+callin detail) with the coarse phase split.
    //   on     enable accumulation     off    disable (keeps samples)
    //   reset  clear samples           status  one-line state
    //   <none>  full phase-breakdown report
    if (cmd == "sim profile" || cmd.rfind("sim profile ", 0) == 0) {
        std::string arg = (cmd.size() > 12) ? cmd.substr(12) : "";
        while (!arg.empty() && arg.front() == ' ') arg.erase(arg.begin());

        if (arg == "on" || arg == "1" || arg == "true") {
            SimFrameProfiler::SetEnabled(true);
            return "sim profile: on";
        }
        if (arg == "off" || arg == "0" || arg == "false") {
            SimFrameProfiler::SetEnabled(false);
            return "sim profile: off (samples retained; `sim profile reset` to clear)";
        }
        if (arg == "reset" || arg == "clear") {
            SimFrameProfiler::Reset();
            return "sim profile: samples cleared";
        }
        if (arg == "status") {
            return std::string("sim profile: ") + (SimFrameProfiler::IsEnabled() ? "on" : "off");
        }
        return SimFrameProfiler::Report();
    }

    // combat_summary  — recent combat / sound / death queue depths.
    if (cmd == "combat_summary") {
        std::ostringstream ss;
        ss << "queued combat=" << combatEvents.Size()
           << " sounds=" << soundEvents.Size()
           << " (drained per-tick by server_main)";
        return ss.str();
    }

    return "unknown command: " + cmd;
}

} // namespace

LuaExecResult ExecuteLuaExecRequest(const LuaExecRequest& req) {
    LuaExecResult result;
    result.requestId = req.requestId;
    result.scope = req.scope;
    result.clientId = req.clientId;

    if (req.scope == "LuaRules") {
        if (!luaRules) {
            result.success = false;
            result.output = "LuaRules not loaded";
        } else {
            result.output = ExecuteInLuaState(
                luaRules->syncedLuaHandle.GetLuaState(), req.code);
            result.success = result.output.find("error:") != 0
                          && result.output.find("syntax error:") != 0
                          && result.output.find("runtime error:") != 0;
        }
    }
    else if (req.scope == "LuaGaia") {
        if (!luaGaia) {
            result.success = false;
            result.output = "LuaGaia not loaded";
        } else {
            result.output = ExecuteInLuaState(
                luaGaia->syncedLuaHandle.GetLuaState(), req.code);
            result.success = result.output.find("error:") != 0
                          && result.output.find("syntax error:") != 0
                          && result.output.find("runtime error:") != 0;
        }
    }
    else if (req.scope.rfind("LuaAI:", 0) == 0) {
        // AI exec not yet implemented — needs AIRuntimePool.ExecuteLua()
        result.success = false;
        result.output = "LuaAI exec not yet implemented";
    }
    else if (req.scope == "server") {
        result.output = ExecuteServerCommand(req.code);
        result.success = result.output.find("unknown command:") != 0;
    }
    else {
        result.success = false;
        result.output = "unknown scope: " + req.scope;
    }

    SLOG(SPRING_LOG_DEBUG, "[%s] exec: %s -> %s",
         req.scope.c_str(), req.code.c_str(), result.output.c_str());

    return result;
}

SyncedPredicateResult EvalSyncedPredicate(const std::string& expr,
                                          std::string& errOut) {
    if (!luaRules) {
        errOut = "LuaRules not loaded";
        return SyncedPredicateResult::Error;
    }
    lua_State* L = luaRules->syncedLuaHandle.GetLuaState();
    if (!L) {
        errOut = "synced Lua state is null";
        return SyncedPredicateResult::Error;
    }

    const int top = lua_gettop(L);
    // Wrap in `return (...)` so a bare expression like "GG.Balance.Done" yields
    // a value we can test. Restore the stack on every path so a per-30s poll
    // can't leak stack slots over a multi-hour run.
    const std::string chunk = "return (" + expr + ")";
    if (luaL_loadstring(L, chunk.c_str()) != LUA_OK) {
        const char* msg = lua_tostring(L, -1);
        errOut = msg ? msg : "syntax error";
        lua_settop(L, top);
        return SyncedPredicateResult::Error;
    }
    if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
        const char* msg = lua_tostring(L, -1);
        errOut = msg ? msg : "runtime error";
        lua_settop(L, top);
        return SyncedPredicateResult::Error;
    }
    const bool truthy = lua_toboolean(L, -1) != 0;
    lua_settop(L, top);
    return truthy ? SyncedPredicateResult::True : SyncedPredicateResult::False;
}

int64_t GetSyncedLuaHeapKb() {
    if (!luaRules)
        return 0;
    lua_State* L = luaRules->syncedLuaHandle.GetLuaState();
    if (!L)
        return 0;
    // LUA_GCCOUNT returns the heap size in Kbytes (read-only, no GC side effect).
    return static_cast<int64_t>(lua_gc(L, LUA_GCCOUNT, 0));
}
