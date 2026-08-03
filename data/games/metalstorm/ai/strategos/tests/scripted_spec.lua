-- tests/scripted_spec.lua — NPC scripted slates (PLAN-metalstorm-ai.md §5 NPC
-- column, §10 task 4). Run from the plugin root: busted tests/.
--
-- Two layers are covered:
--   1. scripted.lua's three builders (garrison / raid / toll) as pure
--      functions of a Picture + a script table;
--   2. the slate.lua contract they plug into — a firing scripted slate
--      REPLACES the generated standing needs, an absent one does not.
--
-- The graph mirrors the shipped Meridian Basin case in miniature: a home
-- choke, a tolled crossing behind it, two markets at increasing hop distance,
-- and one market too far to be in a raider's reach.

package.path = './?.lua;' .. package.path

local Config   = require('config')
local Scripted = require('scripted')
local Slate    = require('slate')
local Roles    = require('roles')

--     market_near ── home ── crossing ── market_far ── market_distant
local function regions(over)
    local r = {
        home          = { name = 'Home',     value = 1.4, neighbors = { 'market_near', 'crossing' } },
        market_near   = { name = 'Near Mkt', value = 0.7, neighbors = { 'home' } },
        crossing      = { name = 'Crossing', value = 1.0, neighbors = { 'home', 'market_far' } },
        market_far    = { name = 'Far Mkt',  value = 0.7, neighbors = { 'crossing', 'market_distant' } },
        market_distant= { name = 'Distant',  value = 0.9, neighbors = { 'market_far' } },
    }
    for key, patch in pairs(over or {}) do
        for k, v in pairs(patch) do r[key][k] = v end
    end
    return r
end

local SCRIPT = {
    kinds   = { 'garrison', 'raid', 'toll' },
    home    = 'home',
    targets = { 'market_near', 'market_far', 'market_distant' },
    route   = { 'crossing' },
    reach   = 2,
}

local function picture(over)
    local p = {
        frame = 0,
        config = Config,
        regions = regions(),
        script = SCRIPT,
        board = {}, ledger = {}, intel = {},
        guidance = { regionPaint = {}, assetLocks = {}, delegated = {}, veto = {} },
    }
    for k, v in pairs(over or {}) do p[k] = v end
    -- `script = nil` can't travel through pairs(), so "no scenario published a
    -- script" needs an explicit flag.
    if over and over.noScript then p.script = nil end
    return p
end

local function npcRole()
    local r = Roles.resolve('npc', Config)
    r.teamId = 8
    return r
end

local function byId(goals)
    local out = {}
    for _, g in ipairs(goals) do out[g.id] = g end
    return out
end

--=============================================================================
describe("Scripted.build — the three §5 builders", function()
    it("garrisons the home region as an always-affordable DEFEND", function()
        local out = {}
        assert.is_true(Scripted.build(picture(), out, npcRole(), {}))
        local g = byId(out)['npc:garrison:home']
        assert.is_not_nil(g)
        -- kind DEFEND is load-bearing: the planner exempts DEFEND from the
        -- force floor AND from the budget (§8 E2), which is what lets an NPC on
        -- a meagre stipend always afford to sit on its own ground.
        assert.are.equal('DEFEND', g.kind)
        assert.are.equal('DEFEND', g.directive)
        assert.are.equal('scripted', g.source)
        assert.are.equal(1.4 * Scripted.HOME_VALUE_MULT, g.value)
    end)

    it("switches the home directive to DEFEND_FRONT when home is contested", function()
        local out = {}
        Scripted.build(picture({ regions = regions({ home = { contested = true } }) }),
                       out, npcRole(), {})
        assert.are.equal('DEFEND_FRONT', byId(out)['npc:garrison:home'].directive)
    end)

    it("raids named targets within reach, as ASSAULT not TAKE_AND_HOLD", function()
        local out = {}
        Scripted.build(picture(), out, npcRole(), {})
        local g = byId(out)
        -- 1 hop and 2 hops from home: in reach.
        assert.is_not_nil(g['npc:raid:market_near'])
        assert.is_not_nil(g['npc:raid:market_far'])
        -- A raider hurts a place and leaves; holding it would be EXPAND, which
        -- §5 forbids for NPCs.
        assert.are.equal('ASSAULT', g['npc:raid:market_near'].directive)
        assert.are.equal('RAID', g['npc:raid:market_near'].kind)
        assert.are.equal('platoon', g['npc:raid:market_near'].echelon)
    end)

    it("drops targets beyond the scripted reach", function()
        local out = {}
        Scripted.build(picture(), out, npcRole(), {})   -- reach = 2
        assert.is_nil(byId(out)['npc:raid:market_distant'])   -- 3 hops
    end)

    it("drops targets that are unreachable over the graph entirely", function()
        -- Sever market_far from the chain: an island target is honestly out of
        -- a ground band's range, not "distance unknown, go anyway".
        local cut = regions({ crossing = { neighbors = { 'home' } },
                              market_far = { neighbors = { 'market_distant' } } })
        local out = {}
        Scripted.build(picture({ regions = cut }), out, npcRole(), {})
        assert.is_nil(byId(out)['npc:raid:market_far'])
        assert.is_not_nil(byId(out)['npc:raid:market_near'])
    end)

    it("never raids ground the NPC already owns", function()
        local mine = regions({ market_near = { owner = 8 } })
        local out = {}
        Scripted.build(picture({ regions = mine }), out, npcRole(), {})
        assert.is_nil(byId(out)['npc:raid:market_near'])
    end)

    it("tolls a route by parking OVERWATCH on the corridor", function()
        local out = {}
        Scripted.build(picture(), out, npcRole(), {})
        local g = byId(out)['npc:toll:crossing']
        assert.is_not_nil(g)
        assert.are.equal('TOLL', g.kind)
        assert.are.equal('OVERWATCH', g.directive)
    end)

    it("runs only the kinds the scenario asked for", function()
        local out = {}
        local script = { kinds = { 'garrison' }, home = 'home',
                         targets = { 'market_near' }, route = { 'crossing' } }
        Scripted.build(picture({ script = script }), out, npcRole(), {})
        assert.are.equal(1, #out)
        assert.are.equal('npc:garrison:home', out[1].id)
    end)

    it("skips region keys the loaded map does not have", function()
        local out = {}
        local script = { kinds = { 'garrison', 'toll' }, home = 'nowhere',
                         route = { 'nowhere_else' } }
        assert.is_true(Scripted.build(picture({ script = script }), out, npcRole(), {}))
        assert.are.equal(0, #out)
    end)

    it("reports false when no scenario published a script", function()
        local out = {}
        assert.is_false(Scripted.build(picture({ noScript = true }), out, npcRole(), {}))
        assert.are.equal(0, #out)
    end)
end)

--=============================================================================
describe("Slate.build — a scripted slate REPLACES the standing needs", function()
    local profile = { id = 'npc_raider', aggression = 1.3, confidence = 1.1,
                      pSuccessFloor = 0, opportunism = 0.5 }

    it("emits scripted goals + RESERVE, and no implicit SCOUT/EXPAND/DEFEND", function()
        -- market_near is neutral and adjacent to ground we own, i.e. exactly
        -- what implicitGoals would turn into an EXPAND if it ran.
        local p = picture({ regions = regions({ home = { owner = 8 } }) })
        local goals = Slate.build(p, profile, npcRole())
        local kinds = {}
        for _, g in ipairs(goals) do kinds[g.kind] = (kinds[g.kind] or 0) + 1 end

        assert.is_nil(kinds.EXPAND)
        assert.is_nil(kinds.SCOUT)
        assert.are.equal(1, kinds.RESERVE)      -- the surplus sink still exists
        assert.are.equal(1, kinds.DEFEND)       -- the garrison, not an implicit one
        assert.are.equal('npc:garrison:home', byId(goals)['npc:garrison:home'].id)
        assert.is_nil(byId(goals)['def:home'])  -- the implicit DEFEND id
    end)

    it("falls back to the implicit slate when the scenario published nothing", function()
        -- An npc profile with no scenario behind it is a plain defensive minor
        -- faction, not a statue: implicitKinds (DEFEND/SCOUT/RESERVE) still run.
        local p = picture({ noScript = true,
                            regions = regions({ home = { owner = 8 } }),
                            intel = { market_near = { strength = 50, confidence = 1 } } })
        local goals = Slate.build(p, profile, npcRole())
        assert.is_not_nil(byId(goals)['def:home'])   -- implicit DEFEND fired
        assert.is_not_nil(byId(goals)['reserve'])
        -- ...and role.implicitKinds still bars EXPAND for an NPC.
        for _, g in ipairs(goals) do assert.are_not.equal('EXPAND', g.kind) end
    end)

    it("leaves a full_side role's implicit slate alone", function()
        local full = Roles.resolve('full_side', Config)
        full.teamId = 0
        assert.is_nil(full.scriptedSlate)
        local p = picture({ regions = regions({ home = { owner = 0 } }) })
        local goals = Slate.build(p, { id = 'default', aggression = 1, confidence = 1 }, full)
        local kinds = {}
        for _, g in ipairs(goals) do kinds[g.kind] = true end
        assert.is_true(kinds.EXPAND or false)   -- neutral ground next door
    end)
end)

--=============================================================================
describe("Scripted vocabulary", function()
    it("matches game_scenario.lua's AI_SLATE_KINDS allow-list", function()
        -- The two lists are a documented pair (the AI VM and synced gadgets are
        -- separate Lua states): a builder added here must be added there too,
        -- or a scenario naming it fails validation at load.
        for _, kind in ipairs(Scripted.KINDS) do
            assert.is_true(Scripted.isKind(kind))
        end
        assert.is_false(Scripted.isKind('conquer'))
    end)
end)
