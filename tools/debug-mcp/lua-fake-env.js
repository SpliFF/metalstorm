// lua-fake-env.js — a fake synced `Spring` for testing lua-snippets.js under
// fengari. Not a test file; imported by *.test.js.
//
// The fixture: two teams. Team 1 seats human `shannon` (player 0) and AI
// virtual player 1 (`strategos`), team 2 seats AI player 2 alone. Team 1 has
// the params the gadgets publish; team 2 has none, so "missing" is non-empty.

import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

export const FAKE_SPRING = String.raw`
FAKE = { params = {}, gameParams = {}, received = {} }
FAKE.params[1] = {
  team_active_humans = 1, team_leader = 0, ai_profile = 'aggressive', ai_profile_1 = 'caretaker',
  authority_pool = 640, authority_player_1 = 25.5, authority_player_1_own_pool_only = 1,
  ai_slate_kinds = 'defend,assault', ai_slate_home = 'basin_a',
  guidance_1_stance = 'balanced', guidance_1_roe = 'free', guidance_1_intent_count = 2,
  guidance_1_change = 3,
}
FAKE.params[2] = {}
FAKE.gameParams = {
  region_basin_a_name = 'Basin A', region_basin_a_team = 1,
  region_north_gate_name = 'North Gate', region_north_gate_team = -1,
  objective_count = 2, objective_1_type = 'hold', objective_1_state = 'active',
  objective_2_type = 'capture', objective_2_state = 'complete',
}
local players = {
  [0] = { name = 'shannon', active = true, spec = false, team = 1, ally = 0, opts = {} },
  [1] = { name = 'strategos', active = true, spec = false, team = 1, ally = 0, opts = { isAI = '1' } },
  [2] = { name = 'strategos2', active = true, spec = false, team = 2, ally = 1, opts = { isAI = '1' } },
}
UnitDefs = { [10] = { customParams = { ms_class = 'armour' } }, [11] = { customParams = { ms_class = 'infantry' } } }
Spring = {
  GetGameFrame = function() return 1234 end,
  GetPlayerList = function(team) local out = {} for pid = 0, 2 do if team == nil or players[pid].team == team then out[#out+1] = pid end end return out end,
  GetPlayerInfo = function(pid, withOpts)
    local p = players[pid]
    if not p then return nil end
    return p.name, p.active, p.spec, p.team, p.ally, 0, 0, '', 0, false, (withOpts ~= false) and p.opts or nil, false
  end,
  GetTeamList = function() return { 1, 2 } end,
  GetTeamInfo = function(tid) return tid, 0, false, false, (tid == 1) and 'compact' or 'reavers', (tid == 1) and 0 or 1 end,
  GetTeamRulesParam = function(tid, key) local t = FAKE.params[tid] if not t then error('bad team') end return t[key] end,
  GetTeamRulesParams = function(tid) return FAKE.params[tid] end,
  GetGameRulesParams = function() return FAKE.gameParams end,
  GetTeamUnits = function(tid) if tid == 1 then return { 100, 101, 102 } end return {} end,
  GetUnitDefID = function(uid) if uid == 102 then return 11 end return 10 end,
  GetDirectives = function(tid)
    if tid ~= 1 then return {} end
    return { { id = 7, type = 'Assault', group = 3, priority = 5, shape = 'point', params = { 100, 0, 200 },
               requestedStrength = 2, assignedStrength = 2, assigned = 2, active = true,
               createdAtFrame = 10, expiresAtFrame = 0, conditions = {} } }
  end,
  GetOrgGroups = function(tid)
    if tid ~= 1 then return {} end
    return { { id = 3, echelon = 'platoon', parentId = 0, name = '3rd Tanks', members = { 100, 101 }, currentDirectiveId = 7, createdAtFrame = 1 },
             { id = 4, echelon = 'platoon', parentId = 0, name = 'Reserve', members = {}, currentDirectiveId = 0, createdAtFrame = 1 } }
  end,
}
GG = { AIGuidance = {
  Get = function(tid) return { stance = 'balanced', roe = 'free', funding = { rateCap = 200 }, region_paint = { basin_a = 'priority' }, asset_locks = {}, delegated = {}, veto = {} } end,
  PendingCount = function() return 0 end,
} }
gadgetHandler = { RecvLuaMsg = function(self, msg, pid)
  FAKE.received[#FAKE.received + 1] = { msg = msg, pid = pid }
  if msg:find('^cmd=guidance%.') then FAKE.params[1].guidance_1_change = FAKE.params[1].guidance_1_change + 1 end
end }
`;

/** Run Lua source that `return`s a string; returns {ok, value|error}. */
export function runLua(source) {
    const L = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(L);
        const buf = to_luastring(source);
        if (lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring('@snippet')) !== lua.LUA_OK)
            return { ok: false, error: to_jsstring(lua.lua_tostring(L, -1)) };
        if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK)
            return { ok: false, error: to_jsstring(lua.lua_tostring(L, -1)) };
        const t = lua.lua_type(L, -1);
        if (t === lua.LUA_TSTRING) return { ok: true, value: to_jsstring(lua.lua_tostring(L, -1)) };
        return { ok: true, value: null };
    } finally {
        lua.lua_close(L);
    }
}

/** An `io.execLua` fake that runs the snippet against the fake Spring. */
export function fakeExecLua(prelude = FAKE_SPRING) {
    const calls = [];
    const execLua = async (scope, code, roomId) => {
        calls.push({ scope, code, roomId });
        const r = runLua(prelude + '\n' + code);
        return r.ok ? { success: true, output: r.value ?? '' } : { success: false, output: r.error };
    };
    return { execLua, calls };
}
