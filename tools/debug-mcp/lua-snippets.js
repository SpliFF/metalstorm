// lua-snippets.js — the synced-Lua programs the AI / NL tools run through
// `exec_lua` (LuaRules scope), as pure string builders.
//
// Every snippet returns ONE JSON string, produced by the small encoder in
// LUA_JSON below — the exec channel hands back a plain string and the synced
// state ships no JSON library. Written against Lua 5.1 semantics (the
// engine's lineage) and tested under fengari (5.3) with a fake `Spring`
// (lua-fake-env.js), so the same source runs in both.
//
// The names these snippets read are the contract with the gadgets:
//   game_teams.lua      team params  team_active_humans, team_leader,
//                                    ai_profile_<pid>; modoption ai_profile_player<pid>
//   game_ai_caretaker   team param   ai_profile
//   game_authority.lua  team params  authority_pool, authority_player_<pid>,
//                                    authority_player_<pid>_own_pool_only
//   strategos/picture   team params  ai_slate_kinds/home/targets/route/reach
//   game_ai_guidance    team params  guidance_<team>_* (stance, roe, paint_*,
//                                    lock_keys, delegated_keys, veto_keys,
//                                    intent_count, funding_rateCap, _change)
//   engine              Spring.GetDirectives(team), Spring.GetOrgGroups(team)
//   game_regions.lua    game params  region_<key>_name/_x/_z/_team/_contested
//   game_objectives.lua game params  objective_count, objective_<id>_type/_state
//
// There is NO `ai_health` rulesParam in this tree (grepped 2026-09-10);
// `ai_health` composes the above and reports which names were found.

import { luaLongString } from './guidance-wire.js';

export const LUA_JSON = String.raw`
local function J(v, depth)
  depth = depth or 0
  if depth > 12 then return '"<deep>"' end
  local t = type(v)
  if v == nil then return 'null' end
  if t == 'boolean' then return v and 'true' or 'false' end
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return 'null' end
    if math.floor(v) == v and math.abs(v) < 1e15 then return string.format('%d', v) end
    return string.format('%.14g', v)
  end
  if t == 'string' then
    local s = v:gsub('[%c"\\]', function(c)
      if c == '"' then return '\\"' elseif c == '\\' then return '\\\\'
      elseif c == '\n' then return '\\n' elseif c == '\r' then return '\\r' elseif c == '\t' then return '\\t'
      else return string.format('\\u%04x', c:byte()) end
    end)
    return '"' .. s .. '"'
  end
  if t == 'table' then
    local n = #v
    local isArray = n > 0
    if isArray then
      for k in pairs(v) do if type(k) ~= 'number' then isArray = false break end end
    end
    if isArray then
      local out = {}
      for i = 1, n do out[i] = J(v[i], depth + 1) end
      return '[' .. table.concat(out, ',') .. ']'
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local out = {}
    for _, k in ipairs(keys) do
      local val = v[k]
      if val == nil then val = v[tonumber(k)] end
      out[#out + 1] = J(k, depth + 1) .. ':' .. J(val, depth + 1)
    end
    return '{' .. table.concat(out, ',') .. '}'
  end
  return '"<' .. t .. '>"'
end
`;

/** Shared roster helpers. */
export const LUA_ROSTER = String.raw`
local function playerRows(teamFilter)
  local out = {}
  for _, pid in ipairs(Spring.GetPlayerList() or {}) do
    local name, active, spec, team, ally, _, _, _, _, _, opts = Spring.GetPlayerInfo(pid, true)
    if name and (teamFilter == nil or team == teamFilter) then
      out[#out + 1] = {
        id = pid, name = name, active = active and true or false,
        spectator = spec and true or false, team = team, allyTeam = ally,
        isAI = (type(opts) == 'table' and opts.isAI == '1') or false,
      }
    end
  end
  return out
end
local function teamParam(team, key)
  local ok, v = pcall(Spring.GetTeamRulesParam, team, key)
  if ok then return v end
  return nil
end
local function teamParams(team)
  local ok, v = pcall(Spring.GetTeamRulesParams, team)
  if ok and type(v) == 'table' then return v end
  return {}
end
local function teamIds(filter)
  local out = {}
  for _, tid in ipairs(Spring.GetTeamList() or {}) do
    if filter == nil or tid == filter then out[#out + 1] = tid end
  end
  return out
end
`;

const luaNum = (v) => (v === undefined || v === null ? 'nil' : String(Number(v)));

/** ai_list: every team's players, AI virtual players annotated. */
export function aiListLua(team) {
    return LUA_JSON + LUA_ROSTER + String.raw`
local TEAMFILTER = ${luaNum(team)}
local teams = {}
for _, tid in ipairs(teamIds(TEAMFILTER)) do
  local players = playerRows(tid)
  local ais = {}
  for _, p in ipairs(players) do
    if p.isAI then
      p.profile = teamParam(tid, 'ai_profile_' .. p.id) or teamParam(tid, 'ai_profile')
      p.pool = teamParam(tid, 'authority_player_' .. p.id)
      p.ownPoolOnly = teamParam(tid, 'authority_player_' .. p.id .. '_own_pool_only')
      ais[#ais + 1] = p
    end
  end
  local _, _, isDead, _, side, allyTeam = Spring.GetTeamInfo(tid)
  teams[#teams + 1] = {
    team = tid, allyTeam = allyTeam, side = side, dead = isDead and true or false,
    activeHumans = teamParam(tid, 'team_active_humans'),
    leader = teamParam(tid, 'team_leader'),
    teamProfile = teamParam(tid, 'ai_profile'),
    pool = teamParam(tid, 'authority_pool'),
    ais = ais, players = players,
  }
end
return J({ frame = Spring.GetGameFrame(), teams = teams })
`;
}

/** ai_directives: engine directives + org groups per team. */
export function aiDirectivesLua(team, includeGroups = true) {
    return LUA_JSON + LUA_ROSTER + String.raw`
local TEAMFILTER = ${luaNum(team)}
local INCLUDE_GROUPS = ${includeGroups ? 'true' : 'false'}
if type(Spring.GetDirectives) ~= 'function' then
  return J({ error = 'this engine has no Spring.GetDirectives (macro-orders not compiled in)' })
end
local teams = {}
for _, tid in ipairs(teamIds(TEAMFILTER)) do
  local row = { team = tid, directives = Spring.GetDirectives(tid) or {} }
  if INCLUDE_GROUPS and type(Spring.GetOrgGroups) == 'function' then
    row.groups = Spring.GetOrgGroups(tid) or {}
  end
  teams[#teams + 1] = row
end
return J({ frame = Spring.GetGameFrame(), teams = teams })
`;
}

/** The team-level and per-AI param names ai_health feature-detects. */
export const AI_HEALTH_TEAM_PARAMS = [
    'ai_profile', 'team_active_humans', 'team_leader', 'authority_pool',
    'ai_slate_kinds', 'ai_slate_home', 'ai_slate_targets', 'ai_slate_route', 'ai_slate_reach',
];
export const AI_HEALTH_PLAYER_PARAMS = ['ai_profile_<pid>', 'authority_player_<pid>', 'authority_player_<pid>_own_pool_only'];

/** ai_health: vitals for every team that seats an AI (or the given team). */
export function aiHealthLua(team) {
    const teamKeys = AI_HEALTH_TEAM_PARAMS.map((k) => `'${k}'`).join(', ');
    return LUA_JSON + LUA_ROSTER + String.raw`
local TEAMFILTER = ${luaNum(team)}
local TEAM_KEYS = { ${teamKeys} }
local teams = {}
for _, tid in ipairs(teamIds(TEAMFILTER)) do
  local ais = {}
  for _, p in ipairs(playerRows(tid)) do if p.isAI then ais[#ais + 1] = p end end
  if TEAMFILTER ~= nil or #ais > 0 then
    local found, missing = {}, {}
    for _, k in ipairs(TEAM_KEYS) do
      local v = teamParam(tid, k)
      if v ~= nil then found[k] = v else missing[#missing + 1] = k end
    end
    for _, p in ipairs(ais) do
      for _, suffix in ipairs({ '', '_own_pool_only' }) do
        local k = 'authority_player_' .. p.id .. suffix
        local v = teamParam(tid, k)
        if v ~= nil then found[k] = v else missing[#missing + 1] = k end
      end
      local k = 'ai_profile_' .. p.id
      local v = teamParam(tid, k)
      if v ~= nil then found[k] = v else missing[#missing + 1] = k end
    end
    local guidance = { params = 0 }
    for k, v in pairs(teamParams(tid)) do
      if type(k) == 'string' and k:sub(1, 9) == 'guidance_' then
        guidance.params = guidance.params + 1
        local field = k:match('^guidance_[^_]+_(.+)$')
        if field == 'stance' or field == 'roe' or field == 'funding_rateCap' or field == 'intent_count'
           or field == 'paint_keys' or field == 'lock_keys' or field == 'delegated_keys'
           or field == 'veto_keys' or field == 'change' then
          guidance[field] = v
        end
      end
    end
    if GG and GG.AIGuidance and type(GG.AIGuidance.Get) == 'function' then
      local ok, s = pcall(GG.AIGuidance.Get, tid)
      if ok and type(s) == 'table' then
        local function count(t) local n = 0 for _ in pairs(t or {}) do n = n + 1 end return n end
        guidance.store = {
          stance = s.stance, roe = s.roe, rateCap = s.funding and s.funding.rateCap,
          painted = count(s.region_paint), locks = count(s.asset_locks),
          delegated = count(s.delegated), vetoed = count(s.veto),
        }
      end
      if type(GG.AIGuidance.PendingCount) == 'function' then
        local ok2, n = pcall(GG.AIGuidance.PendingCount)
        if ok2 then guidance.pendingIntent = n end
      end
    end
    local directives = { available = type(Spring.GetDirectives) == 'function' }
    if directives.available then
      local list = Spring.GetDirectives(tid) or {}
      directives.total = #list
      local active = 0
      for _, d in ipairs(list) do if d.active then active = active + 1 end end
      directives.active = active
    end
    local groups = { available = type(Spring.GetOrgGroups) == 'function' }
    if groups.available then
      local list = Spring.GetOrgGroups(tid) or {}
      groups.total = #list
      local tasked = 0
      for _, g in ipairs(list) do if (g.currentDirectiveId or 0) ~= 0 then tasked = tasked + 1 end end
      groups.tasked = tasked
    end
    teams[#teams + 1] = {
      team = tid, ais = ais, params = { found = found, missing = missing },
      guidance = guidance, directives = directives, groups = groups,
    }
  end
end
return J({ frame = Spring.GetGameFrame(), teams = teams })
`;
}

/**
 * ai_guidance: deliver one wire message to game_ai_guidance.lua exactly as a
 * client would — through gadgetHandler:RecvLuaMsg — as a member of `team`
 * (the gadget derives the team from the SENDER, so the sender must be seated
 * on it; a human is preferred, any member is accepted).
 */
export function guidanceSendLua(wire, { playerId, team } = {}) {
    return LUA_JSON + LUA_ROSTER + String.raw`
local msg = ${luaLongString(wire)}
local playerID = ${luaNum(playerId)}
local team = ${luaNum(team)}
if playerID == nil then
  if team == nil then return J({ error = 'need team or playerId' }) end
  local rows = playerRows(team)
  for _, p in ipairs(rows) do
    if playerID == nil and not p.isAI and not p.spectator then playerID = p.id end
  end
  if playerID == nil and rows[1] then playerID = rows[1].id end
  if playerID == nil then return J({ error = 'no player seated on team ' .. tostring(team) }) end
else
  local _, _, _, t = Spring.GetPlayerInfo(playerID, false)
  if t == nil then return J({ error = 'no such player ' .. tostring(playerID) }) end
  if team ~= nil and t ~= team then
    return J({ error = 'player ' .. tostring(playerID) .. ' is on team ' .. tostring(t) .. ', not ' .. tostring(team) })
  end
  team = t
end
local function changeSeq()
  for k, v in pairs(teamParams(team)) do
    if type(k) == 'string' and k:match('^guidance_.*_change$') then return v end
  end
  return nil
end
if not (gadgetHandler and gadgetHandler.RecvLuaMsg) then
  return J({ error = 'no gadgetHandler:RecvLuaMsg in this LuaRules state' })
end
local before = changeSeq()
gadgetHandler:RecvLuaMsg(msg, playerID)
local after = changeSeq()
local store = nil
if GG and GG.AIGuidance and type(GG.AIGuidance.Get) == 'function' then
  local ok, s = pcall(GG.AIGuidance.Get, team)
  if ok then store = s end
end
return J({
  sent = msg, playerId = playerID, team = team,
  changeSeqBefore = before, changeSeqAfter = after,
  applied = (after ~= nil and after ~= before),
  store = store,
})
`;
}

/**
 * nl_command: the §2 context payload built from the SIM instead of the
 * browser — places (regions), org groups, enemies, objectives, the team's
 * own class counts, authority. No selection, no focus (the caller may pass
 * one), no panels.
 */
export function nlContextLua(team) {
    return LUA_JSON + LUA_ROSTER + String.raw`
local team = ${luaNum(team)}
if team == nil then return J({ error = 'need team' }) end
local ok, gp = pcall(Spring.GetGameRulesParams)
if not ok or type(gp) ~= 'table' then gp = {} end
local places = {}
for k, v in pairs(gp) do
  if type(k) == 'string' then
    local key = k:match('^region_(.+)_name$')
    if key then places[#places + 1] = { n = tostring(v), t = 'region', key = key } end
  end
end
table.sort(places, function(a, b) return a.n < b.n end)
local groups = {}
if type(Spring.GetOrgGroups) == 'function' then
  for _, g in ipairs(Spring.GetOrgGroups(team) or {}) do
    groups[#groups + 1] = {
      n = g.name or ('group ' .. tostring(g.id)), sz = #(g.members or {}),
      state = ((g.currentDirectiveId or 0) ~= 0) and 'tasked' or 'idle',
    }
  end
end
local objectives = {}
local count = tonumber(gp.objective_count) or 0
for i = 1, count do
  local p = 'objective_' .. i .. '_'
  if gp[p .. 'type'] ~= nil then
    objectives[#objectives + 1] = tostring(gp[p .. 'type']) .. ' (' .. tostring(gp[p .. 'state'] or '?') .. ')'
  end
end
local counts = {}
for _, uid in ipairs(Spring.GetTeamUnits(team) or {}) do
  local ud = UnitDefs and UnitDefs[Spring.GetUnitDefID(uid)]
  local cls = ud and ud.customParams and ud.customParams.ms_class
  if cls then counts[cls] = (counts[cls] or 0) + 1 end
end
local classes = {}
for k in pairs(counts) do classes[#classes + 1] = k end
table.sort(classes)
local enemies = {}
local _, _, _, _, _, myAlly = Spring.GetTeamInfo(team)
for _, tid in ipairs(Spring.GetTeamList() or {}) do
  local _, _, isDead, _, side, ally = Spring.GetTeamInfo(tid)
  if tid ~= team and ally ~= myAlly and not isDead and side and side ~= '' then
    enemies[#enemies + 1] = { n = tostring(side) }
  end
end
local self_ = { selection = 0, counts = counts }
local pool = tonumber(teamParam(team, 'authority_pool'))
if pool then self_.authority = pool end
return J({
  places = places, groups = groups, enemies = enemies, objectives = objectives,
  classes = classes, panels = {}, self = self_,
})
`;
}
