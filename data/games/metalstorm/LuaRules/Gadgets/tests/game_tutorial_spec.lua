-- tests/game_tutorial_spec.lua — drives the real game_tutorial.lua headless
-- against a fake Spring/GG world, one wait kind at a time.
--
-- Run from the GAME root (the gadget VFS.Includes tick.lua and parley/wire.lua
-- by game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_tutorial_spec.lua
--
-- What is pinned here is the CONTRACT the coach widget and the scenario
-- authors depend on: the gadget is a no-op outside a tutorial, every wait
-- kind advances on exactly its own condition and nothing else, the wire
-- refuses the wrong team / the wrong beat, skip/restart/stop behave, beat
-- objectives are real GG.Objectives, and the published rulesParams carry a
-- resolved "Show me" point. It also asserts the periodic gate is frame-skip
-- safe (a skipped multiple must not lose the poll — D15).

local GADGET = './LuaRules/Gadgets/game_tutorial.lua'

local function newWorld(opts)
    opts = opts or {}
    local world = {
        frame = 0,
        rp = {},                 -- published game rules params
        echoes = {},
        units = {},              -- unitID -> { team, def, x, z }
        regionOwner = {},        -- key -> team
        regionAt = opts.regionAt or function(x, z) return 'nowhere' end,
        players = { [1] = 0, [2] = 1 },   -- playerID -> team
        created = {},            -- objective defs handed to GG.Objectives.Create
        objectives = {},         -- id -> { state }
        failed = {},
        withdrawn = {},
        guidance = {},
        hooks = { complete = {}, charge = {}, award = {}, propose = {} },
        scenario = opts.scenario,
    }
    local nextObjective = 40

    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        Echo = function(m) world.echoes[#world.echoes + 1] = tostring(m) end,
        SetGameRulesParam = function(k, v) world.rp[k] = v end,
        GetGameRulesParam = function(k) return world.rp[k] end,
        GetPlayerInfo = function(pid) return 'p' .. pid, true, false, world.players[pid] end,
        GetTeamUnits = function(teamID)
            local out = {}
            for id, u in pairs(world.units) do if u.team == teamID then out[#out + 1] = id end end
            table.sort(out)
            return out
        end,
        GetUnitPosition = function(id) local u = world.units[id]; return u.x, 0, u.z end,
        GetUnitDefID = function(id) return world.units[id].def end,
    }
    _G.UnitDefs = { [1] = { name = 'ms_soldiers_s1' }, [2] = { name = 'ms_tanks_s2' } }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    _G.VFS = { Include = function(p) return dofile('./' .. p) end }
    _G.GG = {
        Scenario = { name = 'tutorial_test', data = world.scenario },
        Objectives = {
            OnComplete = function(fn) table.insert(world.hooks.complete, fn) end,
            Create = function(def)
                world.created[#world.created + 1] = def
                if def.type == 'reject' then return nil end
                nextObjective = nextObjective + 1
                world.objectives[nextObjective] = { id = nextObjective, state = 'active', def = def }
                return nextObjective
            end,
            Get = function(id) return world.objectives[id] end,
            Fail = function(id)
                world.failed[#world.failed + 1] = id
                if world.objectives[id] then world.objectives[id].state = 'failed' end
            end,
        },
        Regions = {
            KeyAt = function(x, z) return world.regionAt(x, z) end,
            ControllingTeam = function(k) return world.regionOwner[k] end,
            Area = function(k)
                if k == 'grey_flat' then return 2688, 6272, 900 end
                return nil
            end,
        },
        Authority = {
            OnCharge = function(fn) table.insert(world.hooks.charge, fn) end,
            OnAward = function(fn) table.insert(world.hooks.award, fn) end,
        },
        Transports = { Withdrawn = function(t) return world.withdrawn[t] or 0 end },
        Parley = { OnPropose = function(fn) table.insert(world.hooks.propose, fn) end },
        AIGuidance = { Get = function(t) return world.guidance[t] or {} end },
    }

    dofile(GADGET)
    local g = _G.gadget
    g:Initialize()

    -- helpers ---------------------------------------------------------
    function world.start() world.frame = 0; g:GameStart() end
    function world.run(frames)
        for _ = 1, frames do world.frame = world.frame + 1; g:GameFrame(world.frame) end
    end
    function world.send(pid, cmd, fields)
        local Wire = dofile('./LuaRules/Gadgets/parley/wire.lua')
        g:RecvLuaMsg(Wire.encode(cmd, fields), pid)
    end
    function world.completeObjective(id)
        world.objectives[id].state = 'complete'
        for _, fn in ipairs(world.hooks.complete) do fn(world.objectives[id], 0) end
    end
    function world.charge(team) for _, fn in ipairs(world.hooks.charge) do fn(1, team, 10) end end
    function world.award(team) for _, fn in ipairs(world.hooks.award) do fn(1, team, 10) end end
    function world.propose(fromTeam) for _, fn in ipairs(world.hooks.propose) do fn({ fromTeam = fromTeam }) end end
    function world.addUnit(id, team, def, x, z) world.units[id] = { team = team, def = def, x = x, z = z } end
    function world.beat() return world.rp.tutorial_beat_id end
    return world, g
end

local function beat(id, wait, extra)
    local b = { id = id, title = 'T ' .. id, text = 'text ' .. id, wait = wait }
    for k, v in pairs(extra or {}) do b[k] = v end
    return b
end

local function tutorialScenario(beats, extra)
    local scn = { version = 1, tutorial = true, sides = { { faction = 'compact', team = 0 } }, beats = beats }
    for k, v in pairs(extra or {}) do scn[k] = v end
    return scn
end

describe('game_tutorial.lua', function()

    it('is a no-op for a scenario that is not a tutorial', function()
        local w = newWorld({ scenario = { version = 1, tutorial = false, beats = { beat('a', { kind = 'ack' }) } } })
        w.start()
        w.run(100)
        assert.is_nil(w.rp.tutorial_state)
        assert.is_nil(w.rp.tutorial_beat_id)
        assert.equals(0, #w.created)
    end)

    it('is a no-op with a warning when a tutorial declares no beats', function()
        local w = newWorld({ scenario = tutorialScenario({}) })
        w.start()
        assert.is_nil(w.rp.tutorial_state)
        local warned = false
        for _, e in ipairs(w.echoes) do if e:find('no usable `beats`', 1, true) then warned = true end end
        assert.is_true(warned)
    end)

    it('publishes the first beat at GameStart, for the first side\'s team', function()
        local w = newWorld({ scenario = tutorialScenario({
            beat('welcome', { kind = 'ack' }, { show = { region = 'grey_flat' } }),
            beat('second', { kind = 'ack' }),
        }) })
        w.start()
        assert.equals(1, w.rp.tutorial_active)
        assert.equals(0, w.rp.tutorial_team)
        assert.equals('running', w.rp.tutorial_state)
        assert.equals(1, w.rp.tutorial_beat)
        assert.equals(2, w.rp.tutorial_beat_count)
        assert.equals('welcome', w.rp.tutorial_beat_id)
        assert.equals('T welcome', w.rp.tutorial_title)
        assert.equals('text welcome', w.rp.tutorial_text)
        assert.equals('ack', w.rp.tutorial_wait)
        -- "Show me" is resolved sim-side to a point the widget can travel to.
        assert.equals(2688, w.rp.tutorial_show_x)
        assert.equals(6272, w.rp.tutorial_show_z)
        assert.is_nil(w.rp.tutorial_show_panel)
        assert.is_number(w.rp.tutorial_rev)
    end)

    it('drops malformed beats with a log line instead of erroring', function()
        local w = newWorld({ scenario = tutorialScenario({
            beat('ok', { kind = 'ack' }),
            beat('bad-kind', { kind = 'teleport' }),
            { id = 'no-title', text = 'x', wait = { kind = 'ack' } },
            beat('ok', { kind = 'ack' }),                       -- duplicate id
            beat('victory-beat', { kind = 'ack' }, { objective = { type = 'control', region = 'r', victory = true } }),
        }) })
        w.start()
        assert.equals(1, w.rp.tutorial_beat_count)
        local dropped = 0
        for _, e in ipairs(w.echoes) do if e:find('dropped', 1, true) then dropped = dropped + 1 end end
        assert.equals(4, dropped)
    end)

    describe('wait kinds', function()
        it('ack: advances only on the player\'s ack for the CURRENT beat', function()
            local w = newWorld({ scenario = tutorialScenario({ beat('a', { kind = 'ack' }), beat('b', { kind = 'ack' }) }) })
            w.start()
            w.run(200)
            assert.equals('a', w.beat())                 -- time alone never advances an ack
            w.send(1, 'tutorial.ack', { beat = 'b' })    -- wrong beat
            assert.equals('a', w.beat())
            w.send(1, 'tutorial.ack', { beat = 'a' })
            assert.equals('b', w.beat())
        end)

        it('client: the widget\'s ack finishes it; the sim never does', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('sel', { kind = 'client', check = 'selection' }), beat('z', { kind = 'ack' }) }) })
            w.start()
            assert.equals('selection', w.rp.tutorial_check)
            w.run(600)
            assert.equals('sel', w.beat())
            w.send(1, 'tutorial.ack', { beat = 'sel' })
            assert.equals('z', w.beat())
            assert.is_nil(w.rp.tutorial_check)
        end)

        it('presence: a team unit standing in the region', function()
            local w = newWorld({
                regionAt = function(x, z) return x > 1792 and 'grey_flat' or 'amber_row' end,
                scenario = tutorialScenario({ beat('move', { kind = 'presence', region = 'grey_flat' }), beat('z', { kind = 'ack' }) }),
            })
            w.addUnit(10, 0, 2, 900, 6200)     -- ours, still home
            w.addUnit(11, 1, 2, 2700, 6200)    -- someone else's, in the region
            w.start()
            w.run(120)
            assert.equals('move', w.beat())
            w.units[10].x = 2700
            w.run(30)
            assert.equals('z', w.beat())
        end)

        it('region: the team controls the region', function()
            local w = newWorld({ scenario = tutorialScenario({ beat('take', { kind = 'region', region = 'grey_flat' }), beat('z', { kind = 'ack' }) }) })
            w.start()
            w.regionOwner.grey_flat = 1
            w.run(60)
            assert.equals('take', w.beat())
            w.regionOwner.grey_flat = 0
            w.run(30)
            assert.equals('z', w.beat())
        end)

        it('objective: posts a real objective when the beat starts and advances when it completes', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('hold', { kind = 'objective' },
                     { objective = { type = 'control', region = 'grey_flat', reward = 60, holdFrames = 900 } }),
                beat('z', { kind = 'ack' }) }) })
            w.start()
            assert.equals(1, #w.created)
            local def = w.created[1]
            assert.equals('control', def.type)
            assert.equals('grey_flat', def.params.regionKey)   -- flat `region` folded like scenarios
            assert.equals(900, def.params.holdFrames)
            assert.equals(0, def.forTeam)                       -- defaults to the learning team
            assert.equals(60, def.reward)
            assert.is_nil(def.victory)
            assert.equals(41, w.rp.tutorial_objective)
            w.completeObjective(41)
            assert.equals('z', w.beat())
        end)

        it('objective: a rejected objective leaves the beat skippable, not stuck in an error', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('hold', { kind = 'objective' }, { objective = { type = 'reject' } }),
                beat('z', { kind = 'ack' }) }) })
            w.start()
            assert.is_nil(w.rp.tutorial_objective)
            w.send(1, 'tutorial.skip', { beat = 'hold' })
            assert.equals('z', w.beat())
        end)

        it('objective: a failed beat objective is re-posted on the next poll', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('hold', { kind = 'objective' }, { objective = { type = 'control', region = 'grey_flat' } }),
                beat('z', { kind = 'ack' }) }) })
            w.start()
            w.objectives[41].state = 'expired'
            w.run(30)
            assert.equals(2, #w.created)
            assert.equals(42, w.rp.tutorial_objective)
        end)

        it('charge / award: count only the learning team\'s events since the beat started', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('a', { kind = 'ack' }),
                beat('spend', { kind = 'charge', min = 2 }),
                beat('earn', { kind = 'award' }),
                beat('z', { kind = 'ack' }) }) })
            w.start()
            w.charge(0); w.charge(0)                       -- before the beat: not counted
            w.send(1, 'tutorial.ack', { beat = 'a' })
            w.charge(1); w.charge(0)
            w.run(30)
            assert.equals('spend', w.beat())
            w.charge(0)
            w.run(30)
            assert.equals('earn', w.beat())
            w.award(1)
            w.run(30)
            assert.equals('earn', w.beat())
            w.award(0)
            w.run(30)
            assert.equals('z', w.beat())
        end)

        it('withdrawn / units / parley / guidance / frames', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('leave', { kind = 'withdrawn' }),
                beat('wave', { kind = 'units', def = 'ms_soldiers_s1', min = 2 }),
                beat('talk', { kind = 'parley' }),
                beat('delegate', { kind = 'guidance', field = 'delegated' }),
                beat('pause', { kind = 'frames', frames = 90 }),
                beat('z', { kind = 'ack' }) }) })
            w.start()
            w.run(30); assert.equals('leave', w.beat())
            w.withdrawn[0] = 1
            w.run(30); assert.equals('wave', w.beat())
            w.addUnit(20, 0, 1, 0, 0); w.addUnit(21, 1, 1, 0, 0)
            w.run(30); assert.equals('wave', w.beat())      -- one of ours, one theirs
            w.addUnit(22, 0, 1, 0, 0)
            w.run(30); assert.equals('talk', w.beat())
            w.propose(1)
            w.run(30); assert.equals('talk', w.beat())
            w.propose(0)
            w.run(30); assert.equals('delegate', w.beat())
            w.guidance[0] = { delegated = {} }
            w.run(30); assert.equals('delegate', w.beat())  -- empty table is not "set"
            w.guidance[0] = { delegated = { [12] = true } }
            w.run(30); assert.equals('pause', w.beat())
            w.run(60); assert.equals('pause', w.beat())
            w.run(60); assert.equals('z', w.beat())
        end)
    end)

    it('finishes after the last beat and clears the beat fields', function()
        local w = newWorld({ scenario = tutorialScenario({ beat('only', { kind = 'ack' }) }) })
        w.start()
        w.send(1, 'tutorial.ack', { beat = 'only' })
        assert.equals('done', w.rp.tutorial_state)
        assert.is_nil(w.rp.tutorial_beat_id)
        assert.is_nil(w.rp.tutorial_title)
        assert.equals(1, w.rp.tutorial_active)
    end)

    it('marks a beat stuck after timeoutFrames without advancing it', function()
        local w = newWorld({ scenario = tutorialScenario({
            beat('slow', { kind = 'region', region = 'grey_flat' }, { timeoutFrames = 300 }), beat('z', { kind = 'ack' }) }) })
        w.start()
        w.run(270)
        assert.is_nil(w.rp.tutorial_hint)
        w.run(60)
        assert.equals('stuck', w.rp.tutorial_hint)
        assert.equals('slow', w.beat())
    end)

    describe('wire', function()
        it('refuses every command from a player on another team', function()
            local w = newWorld({ scenario = tutorialScenario({ beat('a', { kind = 'ack' }), beat('b', { kind = 'ack' }) }) })
            w.start()
            w.send(2, 'tutorial.ack', { beat = 'a' })
            w.send(2, 'tutorial.skip', { beat = 'a' })
            w.send(2, 'tutorial.stop')
            assert.equals('a', w.beat())
            assert.equals('running', w.rp.tutorial_state)
        end)

        it('ignores messages that are not tutorial.* verbs', function()
            local w = newWorld({ scenario = tutorialScenario({ beat('a', { kind = 'ack' }) }) })
            w.start()
            w.send(1, 'guidance.stance', { value = 'hold' })
            w.send(1, 'ack', { beat = 'a' })
            assert.equals('a', w.beat())
        end)

        it('skip fails the beat\'s live objective and moves on', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('hold', { kind = 'objective' }, { objective = { type = 'control', region = 'grey_flat' } }),
                beat('z', { kind = 'ack' }) }) })
            w.start()
            w.send(1, 'tutorial.skip', { beat = 'hold' })
            assert.same({ 41 }, w.failed)
            assert.equals('z', w.beat())
            assert.is_nil(w.rp.tutorial_objective)
        end)

        it('restart goes back to beat 1 with fresh counters', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('a', { kind = 'ack' }), beat('spend', { kind = 'charge' }), beat('z', { kind = 'ack' }) }) })
            w.start()
            w.send(1, 'tutorial.ack', { beat = 'a' })
            w.charge(0)
            w.send(1, 'tutorial.restart')
            assert.equals('a', w.beat())
            assert.equals('running', w.rp.tutorial_state)
            w.send(1, 'tutorial.ack', { beat = 'a' })
            w.run(30)
            assert.equals('spend', w.beat())               -- the earlier charge did not carry over
        end)

        it('stop hides the coach for the session and stops evaluating', function()
            local w = newWorld({ scenario = tutorialScenario({
                beat('take', { kind = 'region', region = 'grey_flat' }), beat('z', { kind = 'ack' }) }) })
            w.start()
            w.send(1, 'tutorial.stop')
            assert.equals('stopped', w.rp.tutorial_state)
            assert.is_nil(w.rp.tutorial_beat_id)
            w.regionOwner.grey_flat = 0
            w.run(60)
            assert.equals('stopped', w.rp.tutorial_state)
            -- restart brings it back
            w.send(1, 'tutorial.restart')
            assert.equals('running', w.rp.tutorial_state)
            assert.equals('take', w.beat())
        end)
    end)

    it('polls on a frame-skip-safe gate (a skipped multiple does not lose the tick)', function()
        local w = newWorld({ scenario = tutorialScenario({ beat('take', { kind = 'region', region = 'grey_flat' }), beat('z', { kind = 'ack' }) }) })
        w.start()
        w.regionOwner.grey_flat = 0
        -- Jump straight past the first poll frame (30) without ever calling
        -- GameFrame on it — the shape of `sim fell behind, skipped N ticks`.
        w.frame = 31
        w.gadget = _G.gadget
        _G.gadget:GameFrame(31)
        assert.equals('z', w.beat())
    end)

    it('never gates on frame % PERIOD', function()
        for line in io.lines(GADGET) do
            local code = line:gsub('%-%-.*$', '')          -- comments may mention the rule
            assert.is_nil(code:find('frame %% '), 'game_tutorial.lua must use tick.lua, not a modulo gate: ' .. line)
        end
    end)
end)
