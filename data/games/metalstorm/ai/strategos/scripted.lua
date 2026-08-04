-- scripted.lua — NPC-faction scripted slates (PLAN-metalstorm-ai.md §5).  PURE.
--
-- The NPC column of the §5 role table says the goal source is a "scripted slate
-- subset (raid / defend home region / toll a route) — no EXPAND/BUILD unless
-- scenario says". This module is those three builders.
--
-- THE SPLIT — why behaviour is here and parameters are not:
-- a scenario cannot inject Lua into the AI VM (it is a separate Lua state
-- behind a sandboxed plugin-scoped loader — see AIScriptContext's l_require).
-- So the BEHAVIOUR ships with the plugin (this file) and the PARAMETERS ship
-- with the scenario: game_scenario.lua's `ai` section publishes them as team
-- rulesParams, picture.lua reads them back into `picture.script`, and the
-- builders below turn them into goals. Authoring an NPC faction is therefore a
-- data edit in a scenario file, not a code change here.
--
-- picture.script shape (picture.lua readScript / game_scenario.lua stageAI):
--   { kinds   = { 'garrison', 'raid', 'toll' },  -- which builders run
--     home    = 'east_pass',                     -- the region to hold
--     targets = { 'north_market', ... },         -- raid targets
--     route   = { 'still_mere', ... },           -- corridors to deny
--     reach   = 2 }                              -- raid radius, in graph HOPS
--
-- THE STRATEGIC FLOOR STILL HOLDS: every goal below is a region-scoped macro
-- directive. There is no "raid unit X" — a raider's target is a place, and the
-- engine decomposition picks the fights (plan §1).

local Graph = require('graph')

local Scripted = {}

--- The home region is the faction, not just a valuable square: weight it above
-- its raw graph value so garrison outranks an opportunistic raid when both
-- compete for the same package. A tunable, not design law.
Scripted.HOME_VALUE_MULT = 2.0

--- Default raid radius (graph hops from home) when the scenario names none.
Scripted.DEFAULT_REACH = 2

local Builders = {}

--- garrison — hold the home region. Emitted as kind='DEFEND' deliberately: the
-- planner treats DEFEND as the always-affordable posture floor (§8 E2, exempt
-- from the force floor and from the budget), which is exactly right for an NPC
-- on a scripted stipend — it can always afford to sit on its own ground.
function Builders.garrison(picture, script, role, profile, out)   -- luacheck: ignore profile
    local key = script.home
    local r = key and (picture.regions or {})[key]
    if not r then return end
    out[#out + 1] = {
        kind = 'DEFEND', id = 'npc:garrison:' .. key, source = 'scripted',
        region = key, echelon = 'army',
        directive = r.contested and 'DEFEND_FRONT' or 'DEFEND',
        value = (r.value or 1) * Scripted.HOME_VALUE_MULT,
        meta = { reason = 'npc-home' },
    }
end

--- raid — hit named target regions within `reach` hops of home. ASSAULT, never
-- TAKE_AND_HOLD: a raider hurts a place and leaves; holding ground is what
-- EXPAND would do, and §5 forbids EXPAND for NPCs.
--
-- Deliberately NOT filtered on "does it look weak": whether a raid is worth
-- launching is the planner's pSuccess/greedy job (§3.2), and duplicating that
-- judgement here would give the NPC a second, divergent opinion. The slate's
-- only say is WHICH places are on the menu and how far the band ranges.
function Builders.raid(picture, script, role, profile, out)       -- luacheck: ignore profile
    local regions = picture.regions or {}
    local targets = script.targets or {}
    if #targets == 0 then return end

    local reach = script.reach or Scripted.DEFAULT_REACH
    -- Hop distances from home. No home (or a home the map doesn't have) means
    -- no reach limit to apply — the named targets are the whole constraint.
    local dist = script.home and Graph.hops(regions, { [script.home] = true }) or nil

    for _, key in ipairs(targets) do
        local r = regions[key]
        -- Skip ground we already hold: a raider does not raid itself.
        if r and r.owner ~= role.teamId then
            local hops = dist and dist[key]
            -- Unreachable from home (dist has no entry) is NOT in reach — an
            -- island target across water is honestly out of a ground band's
            -- range. A missing `dist` (no home authored) skips the check.
            local inReach = (dist == nil) or (hops ~= nil and hops <= reach)
            if inReach then
                out[#out + 1] = {
                    kind = 'RAID', id = 'npc:raid:' .. key, source = 'scripted',
                    region = key, echelon = 'platoon', directive = 'ASSAULT',
                    value = (r.value or 1),
                    meta = { reason = 'npc-raid', hops = hops },
                }
            end
        end
    end
end

--- toll — sit on a transit corridor and deny it. OVERWATCH holds the ground
-- and engages what crosses, which is what "tolling a route" means when the
-- command floor is a macro directive: you cannot script a tollbooth, you park
-- a band on the causeway.
function Builders.toll(picture, script, role, profile, out)       -- luacheck: ignore role, profile
    for _, key in ipairs(script.route or {}) do
        local r = (picture.regions or {})[key]
        if r then
            out[#out + 1] = {
                kind = 'TOLL', id = 'npc:toll:' .. key, source = 'scripted',
                region = key, echelon = 'platoon', directive = 'OVERWATCH',
                value = (r.value or 1),
                meta = { reason = 'npc-toll' },
            }
        end
    end
end

--- Known builder names, for validation + diagnostics (game_scenario.lua
-- validates the scenario's `kinds` list against the same vocabulary, so an
-- authoring typo fails loudly at load instead of silently producing an NPC
-- that never does anything).
Scripted.KINDS = { 'garrison', 'raid', 'toll' }

function Scripted.isKind(name)
    return Builders[name] ~= nil
end

--- Slate hook: `role.scriptedSlate(picture, out, role, profile)`.
-- Returns true when a scenario-authored script actually drove the slate — that
-- return value is what tells slate.build to SKIP the generated standing needs
-- (§5: an NPC's goals are scripted, it does not opportunistically expand).
-- Returns false when no script is published, which leaves the role on its
-- normal implicit slate rather than leaving it goal-less: an npc profile with
-- no scenario behind it is a plain defensive minor faction, not a statue.
function Scripted.build(picture, out, role, profile)
    local script = picture and picture.script
    if type(script) ~= 'table' then return false end

    local ran = false
    for _, kind in ipairs(script.kinds or {}) do
        local builder = Builders[kind]
        if builder then
            builder(picture, script, role, profile, out)
            ran = true
        end
    end
    return ran
end

return Scripted
