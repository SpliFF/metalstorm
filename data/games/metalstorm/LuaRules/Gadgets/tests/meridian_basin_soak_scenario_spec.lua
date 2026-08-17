-- meridian_basin_soak_scenario_spec.lua — the growth ladder's endless war.
--
-- PLAN-long-uptime.md §11.5 T4-3 / task 4b. The soak ladder measures growth
-- per simulated day and bounds its arms by wall clock; the showcase war it
-- used to stage is won at frame ~12 180, after which the arm measures a
-- frozen world (§11.1/§11.2). `scenarios/meridian_basin_soak.lua` is the same
-- content with no terminal objective.
--
-- Like its neighbour crossing_standoff_scenario_spec.lua, this is NOT a
-- transcription of the file. Two properties are asserted, and each one is a
-- way the ladder has already been wrong: (1) the war has no terminal
-- condition, so an arm runs to its wall ceiling; (2) it is the SAME content
-- as `meridian_basin.lua` apart from that, so the ladder measures the growth
-- surfaces of a war we ship rather than of a stripped fixture — the previous
-- fixture staged no scenario at all and produced `damage=0 deaths=0`.
--
-- Run from the GAME root:
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/meridian_basin_soak_scenario_spec.lua
-- From `LuaRules/Gadgets` it reports errors that are a wrong cwd ("cannot
-- open scenarios/..."), not real failures.

local SOAK     = 'scenarios/meridian_basin_soak.lua'
local SHOWCASE = 'scenarios/meridian_basin.lua'

-- Deep structural equality, order-sensitive for arrays. Returns true/false
-- plus a path to the first difference so a failure names the field.
local function deepDiff(a, b, path)
    path = path or ''
    if type(a) ~= type(b) then
        return path .. ' (type ' .. type(a) .. ' vs ' .. type(b) .. ')'
    end
    if type(a) ~= 'table' then
        if a ~= b then
            return path .. ' (' .. tostring(a) .. ' vs ' .. tostring(b) .. ')'
        end
        return nil
    end
    local seen = {}
    for k, v in pairs(a) do
        seen[k] = true
        local d = deepDiff(v, b[k], path .. '.' .. tostring(k))
        if d then return d end
    end
    for k in pairs(b) do
        if not seen[k] then return path .. '.' .. tostring(k) .. ' (missing on the left)' end
    end
    return nil
end

describe("Meridian Basin — Endless Soak", function()
    local soak, showcase

    before_each(function()
        soak     = dofile(SOAK)
        showcase = dofile(SHOWCASE)
    end)

    it("is a pure table literal the lobby's bare lua_State can parse", function()
        -- ScenarioDiscovery::LoadOne has no VFS, no Spring.*, no require. A
        -- scenario that needs any of them does not fail loudly — it silently
        -- vanishes from discovery, and a ladder arm would then stage nothing
        -- and measure an empty world, which is §11.1 all over again.
        assert.is_table(soak)
        assert.equals(1, soak.version)
        assert.is_string(soak.name)
    end)

    it("declares NO victory objective, so the war has no terminal condition", function()
        -- The whole reason the file exists. game_gameover.lua counts these:
        -- zero means `war_can_end = 0`, a loud frame-60 warning, and a war
        -- that runs until the arm's wall ceiling stops it.
        local victories = 0
        for _, o in ipairs(soak.objectives) do
            if o.victory then victories = victories + 1 end
        end
        assert.equals(0, victories)
        -- ...and the showcase war it is derived from still has exactly one,
        -- so this assertion keeps meaning something.
        local showcaseVictories = 0
        for _, o in ipairs(showcase.objectives) do
            if o.victory then showcaseVictories = showcaseVictories + 1 end
        end
        assert.equals(1, showcaseVictories)
    end)

    it("is never offered to a player", function()
        -- An endless war is a legitimate shape (game_gameover.lua's header)
        -- but it is not a thing to hand someone from the Create Game picker.
        -- `retired` is what the lobby enforces on the create route;
        -- DefaultForMap additionally skips it for being non-terminal.
        assert.is_true(soak.retired)
        assert.is_false(soak.tutorial)
    end)

    it("stages the same content as the showcase war, minus the victory flag", function()
        -- The drift guard. The ladder's numbers are only interesting if the
        -- world it measures is the world we ship, and the two files are
        -- separate literals precisely because ScenarioDiscovery's bare
        -- lua_State cannot include one from the other. So the parity is
        -- checked here instead of assumed.
        for _, field in ipairs({ 'world', 'sides', 'ai', 'units', 'civilians', 'convoys' }) do
            local d = deepDiff(soak[field], showcase[field], field)
            assert.is_nil(d, 'soak scenario diverges from meridian_basin at ' .. tostring(d))
        end
    end)

    it("keeps every objective of the showcase war, with victory stripped", function()
        -- Same count, same shapes: the opening protects/escorts/extracts are
        -- the objective churn of the arm's first ramp, and the strategic
        -- basin hold is kept (without `victory`) because deleting it would
        -- have removed the reason both armies march.
        assert.equals(#showcase.objectives, #soak.objectives)
        for i, o in ipairs(soak.objectives) do
            local ref = showcase.objectives[i]
            assert.equals(ref.type, o.type)
            assert.equals(ref.scope, o.scope)
            assert.equals(ref.region, o.region)
            assert.equals(ref.reward, o.reward)
            assert.equals(ref.expiresAtFrame, o.expiresAtFrame)
            assert.is_nil(o.victory)
        end
    end)

    it("keeps the two client-free churn sources the ladder's slopes are made of", function()
        -- Convoys respawn from mapdata/civilians.lua every intervalSec, and
        -- the Reaver slate keeps raiding the two market termini. Both run
        -- with zero clients attached, which is the only kind of run a
        -- headless ladder has. Losing either would leave the arm sloping on
        -- its opening ramp alone.
        assert.equals(2, #soak.convoys)
        for _, c in ipairs(soak.convoys) do
            assert.is_true((c.intervalSec or 0) > 0)
        end

        assert.equals(1, #soak.ai)
        local reavers = soak.ai[1]
        assert.equals(8, reavers.team)
        local kinds = {}
        for _, k in ipairs(reavers.slate.kinds) do kinds[k] = true end
        assert.is_true(kinds.raid)
        assert.equals(2, #reavers.slate.targets)
        -- The stipend is what funds the raids; without it the NPC spends its
        -- JOIN_GRANT in the opening minute and the churn stops.
        assert.is_true((reavers.stipend.amount or 0) > 0)
        assert.is_true((reavers.stipend.periodSec or 0) > 0)
    end)
end)
