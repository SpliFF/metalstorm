-- roles.lua — the three deployment roles (PLAN-metalstorm-ai.md §5).
--
-- "One brain, three configs." The planner and picture are identical across
-- roles; what changes is POLICY: where goals come from, which pool pays,
-- whether human-touched force is off-limits, and how often it thinks. Keeping
-- this in one table (rather than three code paths) is what makes the roles a
-- config choice, not a fork.
--
-- Role fields consumed elsewhere:
--   explicitMode    'full' | 'none'         — read objectives off the board?
--   implicitKinds   set | nil (nil = all)   — which standing needs may fire (slate)
--   delegationFirst bool                     — bounty ×3 / delegated ×5 (planner)
--   idleOnly        bool                     — only assign idle/unassigned force (§5.1)
--   teamAuthorityFallback bool               — may drain the team pool? (co-cmdr: NO)
--   readsGuidance   bool                     — obey the guidance store (interaction §6)
--   lodFloor/lodCeil int                     — the LOD band this role may range over (§5)
--   tickFramesBase  int                      — LOD-0 strategic cadence (Lod.periodFor scales it)
--   tickFrames      int                      — cadence at the role's LOD floor (its alert rate)
--   caretakerUpgrade bool                    — silently become full-side when humans leave (§5.1)
--   scriptedSlate   fn(picture, out, role, profile) -> bool | nil
--                                            — NPC fixed slate (raid/defend/toll); returns
--                                              true when it actually drove the slate

local Scripted = require('scripted')

local Roles = {}

-- Static policy per role. tickFramesBase/tickFrames are filled in by resolve().
local DEFS = {
    full_side = {
        id = 'full_side',
        explicitMode = 'full',
        implicitKinds = nil,              -- all: DEFEND/SCOUT/EXPAND/BUILD/RESERVE
        delegationFirst = false,
        idleOnly = false,
        teamAuthorityFallback = true,     -- own pool + team fallback like any player
        readsGuidance = false,
        lodFloor = 0, lodCeil = 1,        -- LOD 0–1 always (plan §5)
        caretakerUpgrade = false,
    },

    co_commander = {
        id = 'co_commander',
        explicitMode = 'full',
        implicitKinds = nil,              -- may propose all, but delegation-weighted
        delegationFirst = true,           -- humans steer via bounties/hints/delegation
        idleOnly = true,                  -- never touches human-directed groups (§5.1)
        teamAuthorityFallback = false,    -- OWN POOL ONLY — never drains team savings
        readsGuidance = true,             -- guidance store is BINDING (interaction §6.2)
        lodFloor = 0, lodCeil = 0,        -- LOD 0 always
        caretakerUpgrade = true,          -- upgrade to full slate when humans leave
    },

    npc = {
        id = 'npc',
        explicitMode = 'none',            -- scripted; ignores the general board
        implicitKinds = { DEFEND = true, SCOUT = true, RESERVE = true }, -- no EXPAND/BUILD
        delegationFirst = false,
        idleOnly = false,
        teamAuthorityFallback = false,    -- small scripted stipend, not objective income
        readsGuidance = false,
        lodFloor = 0, lodCeil = 3,        -- LOD by player proximity; dormant when far
        caretakerUpgrade = false,
        -- The scripted slate BEHAVIOUR ships with the plugin; a scenario
        -- supplies its parameters (home/targets/route) through team rulesParams
        -- → picture.script → scripted.lua's builders. With no scenario behind
        -- it, Scripted.build returns false and the role falls back to its
        -- implicitKinds slate above — a plain defensive minor faction.
        scriptedSlate = Scripted.build,
    },
}

--- Resolve a role id into a concrete role table (a copy, so per-instance
-- fields like teamId don't leak across AIs sharing a worker). `config`
-- supplies the base cadence; NPCs think slower at their LOD ceiling.
function Roles.resolve(roleId, config)
    local def = DEFS[roleId] or DEFS.full_side
    local role = {}
    for k, v in pairs(def) do role[k] = v end

    -- Cadence is now DYNAMIC (lod.lua): tickFramesBase is the LOD-0 rate and
    -- main.lua rescales it every tick by the live tier. `tickFrames` stays as
    -- the role's ALERT rate (its LOD floor) so anything reading it — and the
    -- very first tick, before a Picture exists to evaluate a tier from — gets
    -- the fastest cadence the role is allowed, never a dormant one.
    local base = config and config.STRATEGIC_TICK_FRAMES or 150
    local mult = ((config and config.LOD_TICK_MULT) or {})[def.lodFloor] or 1
    role.tickFramesBase = base
    role.tickFrames = base * mult
    role.teamId = nil            -- injected at boot (needs AI.getTeamId — see main)
    return role
end

--- List known role ids (for tests / diagnostics).
function Roles.ids()
    return { 'full_side', 'co_commander', 'npc' }
end

return Roles
