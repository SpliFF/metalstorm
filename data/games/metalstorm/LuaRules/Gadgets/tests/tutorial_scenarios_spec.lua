-- tests/tutorial_scenarios_spec.lua — the two solo Missions' invariants:
-- tutorial_01 (a battle-shaped tutorial) and recon_01 (a Mission that is not a
-- battle). Each file is a pure literal, declares one victory objective, and
-- every beat survives game_tutorial.lua's validator (a dropped beat is a card
-- the player never sees). Path-robust: passes from the game root or the
-- plugin root.

local ROOT = (debug.getinfo(1, 'S').source:match('^@(.*)tests/tutorial_scenarios_spec%.lua$') or '') .. '../../'

local UNARMED = { ms_scout_buggy = true, fable_airship = true, ms_radar_s1 = true, ms_engineers_s1 = true }

--- Load the real director against a stub world and return its published params.
local function directorParams(scn)
    local rp, echoes = {}, {}
    _G.Spring = {
        GetGameFrame = function() return 0 end,
        Echo = function(m) echoes[#echoes + 1] = tostring(m) end,
        SetGameRulesParam = function(k, v) rp[k] = v end,
        GetGameRulesParam = function(k) return rp[k] end,
        GetTeamUnits = function() return {} end,
    }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    _G.VFS = { Include = function(p) return dofile(ROOT .. p) end }
    _G.GG = {
        Scenario = { name = scn.name, data = scn },
        Objectives = { OnComplete = function() end, Create = function() return 1 end, Get = function() end, Fail = function() end },
        Regions = { Area = function() return 1, 1, 1 end, KeyAt = function() return nil end },
    }
    dofile(ROOT .. 'LuaRules/Gadgets/game_tutorial.lua')
    _G.gadget:Initialize()
    _G.gadget:GameStart()
    return rp, echoes
end

local function victories(scn)
    local n = 0
    for _, o in ipairs(scn.objectives) do if o.victory then n = n + 1 end end
    return n
end

for _, id in ipairs({ 'tutorial_01', 'recon_01' }) do
    describe(id, function()
        local scn
        before_each(function() scn = dofile(ROOT .. 'scenarios/' .. id .. '.lua') end)

        it('is a pure-literal solo tutorial with one victory objective', function()
            assert.equals(1, scn.version)
            assert.is_true(scn.tutorial)
            assert.is_true(scn.solo)
            assert.equals('scorched_crossing_v2.4', scn.world.map)
            assert.equals(1, victories(scn))
            assert.equals(0, scn.sides[1].team)          -- the Recruit hosts side 1
        end)

        it('every beat survives the director', function()
            local rp, echoes = directorParams(scn)
            assert.equals('running', rp.tutorial_state)
            assert.equals(#scn.beats, rp.tutorial_beat_count)
            for _, e in ipairs(echoes) do assert.is_nil(e:find('dropped', 1, true), e) end
            assert.equals(scn.beats[1].id, rp.tutorial_beat_id)
        end)
    end)
end

describe('recon_01 is not a battle', function()
    local scn = dofile(ROOT .. 'scenarios/recon_01.lua')

    it('stages nothing that can shoot and ends on an agreement', function()
        for _, u in ipairs(scn.units) do assert.is_true(UNARMED[u.def], u.def) end
        local v
        for _, o in ipairs(scn.objectives) do if o.victory then v = o end end
        assert.equals('parley', v.type)
        assert.equals('intel', v.params.kind)
        local last = scn.beats[#scn.beats]
        assert.equals('pact', last.wait.kind)
        assert.equals(v.params.withTeam, last.parley.toTeam)
    end)
end)
