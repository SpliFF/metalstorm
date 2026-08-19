-- tests/game_transports_spec.lua — the battle lifecycle gadget
-- (PLAN-metalstorm-transports.md §3.3/§3.4/§3.6/§3.7 as amended by §7).
-- Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/game_transports_spec.lua
-- (the busted-cwd trap: run from anywhere else and the scenario specs in this
-- directory fail with `cannot open <path>` — see §5 acceptance criterion 2.)
--
-- The two things worth knowing about what is asserted here:
--
--  * §7.1 repairs a LIVE defect. §3.7's `war_side_stranded` as originally
--    written fires on every shipped scenario (none stages a transport) and on
--    every defender forever. The `home defender` cases below are the guard
--    against that regression: a side without `expeditionary = true` must never
--    be stranded and must never be counted by the guard.
--  * §7.5's `routed` exists so that "withdrew one squad, then died" and
--    "withdrew the whole army" stop reading identically. The threshold cases
--    below pin both sides of 50% and the boundary itself.

package.path = './?.lua;' .. package.path

local mock = require('tests.transports_mock')

-- A two-side scenario: team 0 is home, team 1 arrived by transport.
local function scenario(overrides)
    local scn = {
        sides = {
            { faction = 'compact', team = 0 },
            { faction = 'union', team = 1, expeditionary = true,
              departure = { x = 1000, z = 1000, radius = 500 } },
        },
        units = {
            { def = 'ms_soldiers_s1', team = 0, x = 8000, z = 8000, count = 4 },
            { def = 'ms_soldiers_s1', team = 1, x = 9000, z = 9000, count = 4 },
        },
    }
    for k, v in pairs(overrides or {}) do scn[k] = v end
    return scn
end

local function arrival(overrides)
    local a = {
        id = 'union_wave_1', team = 1, kind = 'air',
        eta = 300,
        entry = { x = 500, z = 500 },
        dropZone = { x = 9000, z = 9000 },
        cargo = { { def = 'ms_soldiers_s1', count = 2 } },
        order = { cmd = 'FIGHT', x = 8000, z = 8000 },
    }
    for k, v in pairs(overrides or {}) do a[k] = v end
    return a
end

-- ============================================================
describe("§3.3 arrival validation", function()

    it("schedules a well-formed arrival and publishes zero invalid", function()
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        assert.are.equal(0, world.rp('war_arrival_invalid'))
        assert.is_true(GG.Transports.Committed(1) >= 6)   -- 4 staged + 2 inbound
    end)

    it("drops an arrival naming an unknown cargo def, and counts it", function()
        local world, g = mock.new(scenario({
            arrivals = { arrival({ cargo = { { def = 'ms_not_a_unit', count = 1 } } }) },
        }))
        g:GameStart()
        assert.are.equal(1, world.rp('war_arrival_invalid'))
        assert.is_true(world.echoed('unknown cargo def'))
    end)

    it("drops an arrival naming an unknown transport def", function()
        local world, g = mock.new(scenario({
            arrivals = { arrival({ def = 'ms_not_a_transport' }) },
        }))
        g:GameStart()
        assert.are.equal(1, world.rp('war_arrival_invalid'))
        assert.is_true(world.echoed('unknown transport def'))
    end)

    it("drops an arrival whose entry point is off the map", function()
        local world, g = mock.new(scenario({
            arrivals = { arrival({ entry = { x = mock.MAP_X + 500, z = 500 } }) },
        }))
        g:GameStart()
        assert.are.equal(1, world.rp('war_arrival_invalid'))
        assert.is_true(world.echoed('entry point is not on the map'))
    end)

    it("drops an arrival whose team cannot be resolved", function()
        local world, g = mock.new(scenario({
            arrivals = { arrival({ team = 'reavers' }) },
        }))
        g:GameStart()
        assert.are.equal(1, world.rp('war_arrival_invalid'))
    end)

    it("resolves a faction key against the scenario's sides", function()
        local world, g = mock.new(scenario({
            arrivals = { arrival({ team = 'union' }) },
        }))
        g:GameStart()
        assert.are.equal(0, world.rp('war_arrival_invalid'))
        world.run(g, 320)
        -- Spawned onto team 1, the team `union` maps to.
        local spawnedTeams = {}
        for _, a in ipairs(world.attaches) do
            spawnedTeams[world.units[a.cargoID].team] = true
        end
        assert.is_true(spawnedTeams[1])
    end)

    it("WARNs when an arrival declares no order (D20 finding 1)", function()
        -- Built by deletion, not by `arrival({ order = nil })`: a nil value in
        -- the overrides table is invisible to pairs(), so that spelling would
        -- silently assert nothing.
        local a = arrival()
        a.order = nil
        local world, g = mock.new(scenario({ arrivals = { a } }))
        g:GameStart()
        assert.are.equal(0, world.rp('war_arrival_invalid'))
        assert.is_true(world.echoed('declares no `order`'))
    end)
end)

-- ============================================================
describe("§7.7 heavy costs more slots than light", function()

    it("lets a capacity-4 airship lift two s1 squads (2 slots each)", function()
        local world, g = mock.new(scenario({
            arrivals = { arrival({ cargo = { { def = 'ms_soldiers_s1', count = 2 } } }) },
        }))
        g:GameStart()
        assert.are.equal(0, world.rp('war_arrival_invalid'))
    end)

    it("refuses three s1 squads on the same airship (6 slots > 4)", function()
        local world, g = mock.new(scenario({
            arrivals = { arrival({ cargo = { { def = 'ms_soldiers_s1', count = 3 } } }) },
        }))
        g:GameStart()
        assert.are.equal(1, world.rp('war_arrival_invalid'))
        assert.is_true(world.echoed('slot(s)'))
    end)

    it("charges a heavier item more, whatever its member count", function()
        -- One s3 item is 4 slots — it fills the capacity-4 landing ship on its
        -- own, where an s2 (3 slots) leaves room for nothing else either.
        -- Squads stay ONE cargo item; only the slot cost scales (§7.7).
        local ok = mock.new(scenario({
            arrivals = { arrival({ def = 'ms_landing_ship', kind = 'sea',
                                   cargo = { { def = 'ms_mech_s3', count = 1 } } }) },
        }))
        local gOK = _G.gadget
        gOK:GameStart()
        assert.are.equal(0, ok.rp('war_arrival_invalid'))

        local over = mock.new(scenario({
            arrivals = { arrival({ def = 'ms_landing_ship', kind = 'sea',
                                   cargo = { { def = 'ms_tank_s2', count = 2 } } }) },
        }))
        local gOver = _G.gadget
        gOver:GameStart()
        assert.are.equal(1, over.rp('war_arrival_invalid'))
    end)
end)

-- ============================================================
describe("§3.3 arrival execution", function()

    it("spawns nothing before the eta and the transport at it", function()
        local world, g = mock.new(scenario({ arrivals = { arrival({ eta = 300 }) } }))
        g:GameStart()
        world.run(g, 299)
        assert.are.equal(0, #world.attaches)
        world.run(g, 300)
        assert.are.equal(2, #world.attaches)     -- two cargo units attached
    end)

    it("attaches cargo onto the def's modelled transport_links pieces", function()
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        world.run(g, 300)
        assert.are.equal(1, world.attaches[1].piece)   -- link1
        assert.are.equal(2, world.attaches[2].piece)   -- link2
    end)

    it("orders the transport to the drop zone", function()
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        world.run(g, 300)
        local transportID = world.attaches[1].transportID
        local orders = world.ordersFor(transportID)
        assert.are.equal(CMD.MOVE, orders[1].cmdID)
        assert.are.equal(9000, orders[1].params[1])
    end)

    it("issues UNLOAD_UNITS (80, not 81) once the transport reaches the zone", function()
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        world.run(g, 300)
        local transportID = world.attaches[1].transportID
        world.moveTo(transportID, 9000, 9000)
        world.run(g, 400)
        local unloads = {}
        for _, o in ipairs(world.ordersFor(transportID)) do
            if o.cmdID == CMD.UNLOAD_UNITS then unloads[#unloads + 1] = o end
        end
        assert.are.equal(1, #unloads)
        assert.are.equal(80, CMD.UNLOAD_UNITS)   -- the T0 constant, pinned here too
    end)

    it("applies the declared order to the cargo after it is off (D20 check)", function()
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        world.run(g, 300)
        local transportID = world.attaches[1].transportID
        local cargoIDs = { world.attaches[1].cargoID, world.attaches[2].cargoID }
        world.moveTo(transportID, 9000, 9000)
        world.run(g, 400)
        -- The engine unloads; model that by clearing the manifest.
        for _, cid in ipairs(cargoIDs) do Spring.UnitDetach(cid) end
        world.run(g, 500)
        for _, cid in ipairs(cargoIDs) do
            local orders = world.ordersFor(cid)
            assert.are.equal(1, #orders)
            assert.are.equal(CMD.FIGHT, orders[1].cmdID)
            assert.are.equal(8000, orders[1].params[1])
        end
    end)

    it("says so loudly when the entry point is blocked, rather than silently not arriving", function()
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        world.createFails['fable_airship'] = true
        world.run(g, 300)
        assert.are.equal(0, #world.attaches)
        assert.is_true(world.echoed('the entry point is blocked'))
    end)

    it("cancels an arrival whose eta lands after the war ended (§3.3)", function()
        local world, g, gg = mock.new(scenario({ arrivals = { arrival({ eta = 300 }) } }))
        g:GameStart()
        gg.WarState = 'resolving'
        world.run(g, 300)
        assert.are.equal(0, #world.attaches)
        assert.is_true(world.echoed('cancelled — the war ended'))
    end)
end)

-- ============================================================
describe("§3.4 withdrawal", function()

    local function loadedTransportAt(world, g, x, z, cargoCount)
        local t = world.spawn(mock.AIRSHIP, 1, x, z)
        for _ = 1, (cargoCount or 0) do
            world.load(t, world.spawn(mock.SOLDIERS_S1, 1, x, z))
        end
        return t
    end

    it("removes a loaded transport and its cargo from the sim, with no wreck", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        local t = loadedTransportAt(world, g, 1000, 1000, 2)
        world.run(g, 120)
        assert.is_nil(world.units[t])
        assert.are.equal(3, #world.destroyed)              -- 2 cargo + the carrier
        for _, d in ipairs(world.destroyed) do
            assert.is_false(d.selfd)                        -- no death FX
            assert.is_true(d.reclaimed)                     -- no wreck
        end
    end)

    it("records the departure in the rulesParams the world ledger reads", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        loadedTransportAt(world, g, 1000, 1000, 2)
        world.run(g, 120)
        assert.are.equal(2, world.trp(1, 'ms_withdrawn_1_units'))
        assert.are.equal(1, world.trp(1, 'ms_withdrawn_1_transports'))
    end)

    it("lets an EMPTY transport depart, recorded under _transports only", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        loadedTransportAt(world, g, 1000, 1000, 0)
        world.run(g, 120)
        assert.are.equal(0, world.trp(1, 'ms_withdrawn_1_units'))
        assert.are.equal(1, world.trp(1, 'ms_withdrawn_1_transports'))
    end)

    it("leaves a transport outside the zone alone", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        local t = loadedTransportAt(world, g, 9000, 9000, 2)
        world.run(g, 300)
        assert.is_not_nil(world.units[t])
        assert.is_nil(world.trp(1, 'ms_withdrawn_1_transports'))
    end)

    it("does not depart anything before CHECK_FRAME (a staged edge transport survives)", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        local t = loadedTransportAt(world, g, 1000, 1000, 2)
        world.run(g, 30)
        assert.is_not_nil(world.units[t])
    end)

    it("defaults a side's departure zone to the nearest map edge, not its staging centroid", function()
        -- No `departure` on the side: the default must not sit on top of the
        -- staged army, or a staged transport departs on the first poll.
        local scn = scenario()
        scn.sides[2].departure = nil
        local world, g = mock.new(scn)
        g:GameStart()
        local t = world.spawn(mock.AIRSHIP, 1, 9000, 9000)   -- at the centroid
        world.run(g, 200)
        assert.is_not_nil(world.units[t])
        -- Nearest edge to the (9000, 9000) centroid on a 16384 map is EAST
        -- (7384 elmos away) — closer than west/north at 9000.
        world.moveTo(t, mock.MAP_X, 9000)                    -- driven to that edge
        world.run(g, 400)
        assert.is_nil(world.units[t])
    end)
end)

-- ============================================================
describe("§7.1 stranding is expeditionary only", function()

    it("strands an expeditionary side when its last transport dies", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        local t = world.spawn(mock.AIRSHIP, 1, 9000, 9000)
        g:UnitCreated(t, mock.AIRSHIP, 1)
        world.spawn(mock.SOLDIERS_S1, 1, 9000, 9000)
        world.kill(t, g)
        assert.are.equal(1, world.rp('ms_stranded_1'))
        assert.is_true(GG.Transports.IsStranded(1))
    end)

    it("does NOT strand a home defender with no transport (the §7.1 repair)", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        world.run(g, 60)
        assert.is_nil(world.rp('ms_stranded_0'))
        assert.is_false(GG.Transports.IsStranded(0))
    end)

    it("does not strand a side whose army already left the field", function()
        -- A side that deliberately loaded everything out and departed has no
        -- transport left either; it succeeded, it is not trapped.
        local world, g = mock.new(scenario({ units = {
            { def = 'ms_soldiers_s1', team = 0, x = 8000, z = 8000, count = 4 },
        } }))
        g:GameStart()
        local t = world.spawn(mock.AIRSHIP, 1, 9000, 9000)
        g:UnitCreated(t, mock.AIRSHIP, 1)
        world.kill(t, g)
        assert.is_not.equal(1, world.rp('ms_stranded_1'))
    end)

    it("does not strand a side that still has an arrival inbound", function()
        local world, g = mock.new(scenario({ arrivals = { arrival({ eta = 9000 }) } }))
        g:GameStart()
        local t = world.spawn(mock.AIRSHIP, 1, 9000, 9000)
        g:UnitCreated(t, mock.AIRSHIP, 1)
        world.spawn(mock.SOLDIERS_S1, 1, 9000, 9000)
        world.kill(t, g)
        assert.is_not.equal(1, world.rp('ms_stranded_1'))
    end)

    it("un-strands when a later arrival lands (the signal is not a latch)", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        local t = world.spawn(mock.AIRSHIP, 1, 9000, 9000)
        g:UnitCreated(t, mock.AIRSHIP, 1)
        world.spawn(mock.SOLDIERS_S1, 1, 9000, 9000)
        world.kill(t, g)
        assert.are.equal(1, world.rp('ms_stranded_1'))

        local t2 = world.spawn(mock.AIRSHIP, 1, 9000, 9000)
        g:UnitCreated(t2, mock.AIRSHIP, 1)
        assert.are.equal(0, world.rp('ms_stranded_1'))
    end)
end)

-- ============================================================
describe("§3.7 war_side_stranded guard", function()

    it("reads 0 on a scenario with NO transports at all (the §7.1 repair)", function()
        -- This is the case that matters most: no shipped scenario stages a
        -- transport, so before §7.1 this guard fired on every one of them.
        local scn = scenario()
        scn.sides[2].expeditionary = nil
        local world, g = mock.new(scn)
        g:GameStart()
        world.run(g, 60)
        assert.are.equal(0, world.rp('war_side_stranded'))
    end)

    it("fires per-side for an expeditionary side with no way home", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        world.run(g, 60)
        assert.are.equal(1, world.rp('war_side_stranded'))
        assert.is_true(world.echoed('expeditionary team(s) 1'))
    end)

    it("stays quiet when the expeditionary side staged a transport", function()
        local world, g = mock.new(scenario())
        world.spawn(mock.AIRSHIP, 1, 9000, 9000)
        g:GameStart()
        world.run(g, 60)
        assert.are.equal(0, world.rp('war_side_stranded'))
    end)

    it("stays quiet when the expeditionary side has an arrival scheduled", function()
        local world, g = mock.new(scenario({ arrivals = { arrival({ eta = 9000 }) } }))
        g:GameStart()
        world.run(g, 60)
        assert.are.equal(0, world.rp('war_side_stranded'))
    end)

    it("ignores a materialised-but-unoccupied filler team", function()
        local world, g = mock.new(scenario({
            sides = {
                { faction = 'compact', team = 0 },
                { faction = 'union', team = 1, expeditionary = true },
                { faction = 'ghost', team = 7, expeditionary = true },
            },
        }))
        world.setTeam(7, -1)          -- materialised, nobody's
        g:GameStart()
        world.run(g, 60)
        assert.are.equal(1, world.rp('war_side_stranded'))   -- team 1 only
    end)
end)

-- ============================================================
describe("§7.5 outcome vocabulary", function()

    --- Stage `committedCount` units on team 1, then depart `departedCount` of
    --- them and wipe the rest.
    local function playOut(committedCount, departedCount)
        local world, g = mock.new(scenario({
            units = {
                { def = 'ms_soldiers_s1', team = 0, x = 8000, z = 8000, count = 4 },
                { def = 'ms_soldiers_s1', team = 1, x = 9000, z = 9000,
                  count = committedCount },
            },
        }))
        g:GameStart()
        local staged = {}
        for _ = 1, committedCount do
            staged[#staged + 1] = world.spawn(mock.SOLDIERS_S1, 1, 9000, 9000)
        end
        if departedCount > 0 then
            local t = world.spawn(mock.AIRSHIP, 1, 1000, 1000)
            for i = 1, departedCount do
                world.moveTo(staged[i], 1000, 1000)
                world.load(t, staged[i])
                staged[i] = nil
            end
            world.run(g, 120)
        end
        for _, id in pairs(staged) do world.kill(id, g) end
        g:GameOver()
        return world
    end

    it("held — the side still has units on the field", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        world.spawn(mock.SOLDIERS_S1, 1, 9000, 9000)
        g:GameOver()
        assert.are.equal('held', world.trp(1, 'ms_outcome_1'))
    end)

    it("annihilated — no live units and no recorded departure", function()
        local world = playOut(4, 0)
        assert.are.equal('annihilated', world.trp(1, 'ms_outcome_1'))
    end)

    it("withdrew — the whole committed force got out", function()
        local world = playOut(4, 4)
        assert.are.equal('withdrew', world.trp(1, 'ms_outcome_1'))
    end)

    it("withdrew — exactly 50% got out (the threshold is inclusive)", function()
        local world = playOut(4, 2)
        assert.are.equal('withdrew', world.trp(1, 'ms_outcome_1'))
    end)

    it("routed — one squad got out of four", function()
        local world = playOut(4, 1)
        assert.are.equal('routed', world.trp(1, 'ms_outcome_1'))
    end)

    it("distinguishes routed from withdrew (the reason §7.5 exists)", function()
        assert.are_not.equal(playOut(4, 1).trp(1, 'ms_outcome_1'),
                             playOut(4, 4).trp(1, 'ms_outcome_1'))
    end)

    it("publishes an outcome for every live occupied team", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        world.spawn(mock.SOLDIERS_S1, 0, 8000, 8000)
        g:GameOver()
        assert.are.equal('held', world.trp(0, 'ms_outcome_0'))
        assert.are.equal('annihilated', world.trp(1, 'ms_outcome_1'))
    end)

    it("publishes nothing before GameOver (there is no outcome until an ending)", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        world.run(g, 200)
        assert.is_nil(world.trp(1, 'ms_outcome_1'))
        assert.is_nil(GG.Transports.Outcome(1))
    end)
end)

-- ============================================================
describe("committed force (§7.5's denominator)", function()

    it("counts staged mobile units plus scheduled arrival cargo", function()
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        assert.are.equal(6, GG.Transports.Committed(1))    -- 4 staged + 2 inbound
        assert.are.equal(6, world.trp(1, 'ms_committed_1'))
    end)

    it("excludes buildings — you do not extract a bunker", function()
        local _, g = mock.new(scenario({ units = {
            { def = 'ms_soldiers_s1', team = 1, x = 9000, z = 9000, count = 2 },
            { def = 'ms_staticdefense_s2', team = 1, x = 9000, z = 9100, count = 3 },
        } }))
        g:GameStart()
        assert.are.equal(2, GG.Transports.Committed(1))
    end)

    it("excludes the carriers themselves — they are the vehicle, not the force", function()
        local _, g = mock.new(scenario({ units = {
            { def = 'ms_soldiers_s1', team = 1, x = 9000, z = 9000, count = 2 },
            { def = 'fable_airship', team = 1, x = 9000, z = 9100, count = 1 },
        } }))
        g:GameStart()
        assert.are.equal(2, GG.Transports.Committed(1))
    end)
end)

-- ============================================================
describe("§3.3 programmatic seam", function()

    it("GG.Transports.ScheduleArrival returns the id and schedules it", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        local id = GG.Transports.ScheduleArrival(arrival({ id = 'world_layer_wave', eta = 300 }))
        assert.are.equal('world_layer_wave', id)
        world.run(g, 300)
        assert.are.equal(2, #world.attaches)
    end)

    it("returns nil + a reason for a bad spec instead of throwing", function()
        local _, g = mock.new(scenario())
        g:GameStart()
        local id, err = GG.Transports.ScheduleArrival(arrival({ def = 'nope' }))
        assert.is_nil(id)
        assert.is_truthy(err)
    end)

    it("refuses a duplicate arrival id", function()
        local _, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        local id, err = GG.Transports.ScheduleArrival(arrival())
        assert.is_nil(id)
        assert.is_truthy(err:find('duplicate', 1, true))
    end)

    it("reports a def's transport-ness off the §3.6 customparam", function()
        local _, g = mock.new(scenario())
        g:GameStart()
        assert.is_true(GG.Transports.IsTransport(mock.AIRSHIP))
        assert.is_true(GG.Transports.IsTransport(mock.LANDING_SHIP))
        assert.is_true(GG.Transports.IsTransport(mock.TROOP_CAR))
        assert.is_false(GG.Transports.IsTransport(mock.SOLDIERS_S1))
    end)
end)

-- ============================================================
describe("snapshot round-trip (PLAN-persistence 1d-b)", function()

    it("carries the ledger and the arrival schedule across a save/load", function()
        local world, g = mock.new(scenario({ arrivals = { arrival({ eta = 3000 }) } }))
        g:GameStart()
        local t = world.spawn(mock.AIRSHIP, 1, 1000, 1000)
        world.load(t, world.spawn(mock.SOLDIERS_S1, 1, 1000, 1000))
        world.run(g, 120)
        assert.are.equal(1, world.trp(1, 'ms_withdrawn_1_units'))

        local state = {}
        g:Save(state)
        g:Load(state)
        assert.are.equal(1, select(1, GG.Transports.Withdrawn(1)))
        assert.is_true(GG.Transports.IsExpeditionary(1))
        assert.are.equal(6, GG.Transports.Committed(1))

        -- The still-pending wave must still fly.
        world.run(g, 3000)
        assert.are.equal(2, #world.attaches)
    end)
end)

-- ============================================================
-- §7.10 / objectives §10.3 — the seam the objectives layer reads.
--
-- These accessors exist so that a transport-native escort objective
-- (objectives/escort.lua, objectives/generator.lua's transport rule) can be
-- built with NO map content at all: the departure zone, the live carriers and
-- the wave currently on the map are all facts this gadget already knows.
-- ============================================================
describe("§7.10 the objectives seam", function()

    it("publishes a side's departure zone under the unified name extractArea", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        -- Same circle §3.4 calls the departure zone, in the objectives' area
        -- shape (`r`, not `radius`) — one rectangle of ground, not two
        -- hand-copied coordinate pairs that can silently diverge.
        local area = GG.Transports.ExtractArea(1)
        assert.are.equal(1000, area.x)
        assert.are.equal(1000, area.z)
        assert.are.equal(500, area.r)
    end)

    it("has no extract area for a side that never got one", function()
        local scn = scenario()
        scn.units = {}                      -- no staged force -> no centroid -> no default
        scn.sides[2].departure = nil
        local world, g = mock.new(scn)
        g:GameStart()
        assert.is_nil(GG.Transports.ExtractArea(1))
    end)

    it("lists a team's live carriers, and only carriers", function()
        local world, g = mock.new(scenario())
        g:GameStart()
        local t1 = world.spawn(mock.AIRSHIP, 1, 9000, 9000)
        local t2 = world.spawn(mock.AIRSHIP, 1, 9100, 9000)
        world.spawn(mock.SOLDIERS_S1, 1, 9200, 9000)
        local live = GG.Transports.LiveTransports(1)
        table.sort(live)
        assert.are.same({ t1, t2 }, live)
        assert.are.equal(0, #GG.Transports.LiveTransports(0))
    end)

    it("reports the wave that is on the map right now, and forgets it once unloaded", function()
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        world.run(g, 330)                   -- past eta = 300
        local inbound = GG.Transports.InFlightArrivals()
        assert.are.equal(1, #inbound)
        assert.are.equal('union_wave_1', inbound[1].arrivalID)
        assert.are.equal(1, inbound[1].team)
        assert.are.equal(9000, inbound[1].dropZone.x)
        assert.is_not_nil(world.units[inbound[1].transportID])

        -- Fly it in and let it unload; the objective subject is then the cargo
        -- on the ground, not a wave in the air. (The engine does the unload;
        -- model it the way the §3.3 execution cases above do, by clearing the
        -- manifest once the UNLOAD_UNITS order has been issued.)
        world.moveTo(inbound[1].transportID, 9000, 9000)
        world.run(g, 600)
        for _, a in ipairs(world.attaches) do Spring.UnitDetach(a.cargoID) end
        world.run(g, 700)
        assert.are.equal(0, #GG.Transports.InFlightArrivals())
    end)

    it("does not report a wave that has not entered the map yet", function()
        -- §7.2: the schedule is fixed at staging and is not a player-facing
        -- object. An objective pointing at ground a wave will reach in four
        -- minutes is an objective pointing at nothing.
        local world, g = mock.new(scenario({ arrivals = { arrival({ eta = 9000 }) } }))
        g:GameStart()
        world.run(g, 300)
        assert.are.equal(0, #GG.Transports.InFlightArrivals())
    end)

    it("increments the withdrawal ledger BEFORE destroying the carrier", function()
        -- Load-bearing ordering. DestroyUnit runs UnitDestroyed synchronously
        -- in the other gadgets, and one observer is escort.lua's transport
        -- form asking this very counter "did that carrier leave, or was it
        -- killed?". Answer it after the fact and the side's own successful
        -- withdrawal reads as a failed escort.
        local world, g = mock.new(scenario())
        g:GameStart()
        local realDestroy = Spring.DestroyUnit
        local ledgerAtDestroy = {}
        Spring.DestroyUnit = function(id, selfd, reclaimed)
            ledgerAtDestroy[#ledgerAtDestroy + 1] = world.trp(1, 'ms_withdrawn_1_transports')
            return realDestroy(id, selfd, reclaimed)
        end

        local t = world.spawn(mock.AIRSHIP, 1, 1000, 1000)
        world.load(t, world.spawn(mock.SOLDIERS_S1, 1, 1000, 1000))
        world.run(g, 120)
        Spring.DestroyUnit = realDestroy

        assert.are.equal(2, #ledgerAtDestroy)          -- cargo, then the carrier
        for _, seen in ipairs(ledgerAtDestroy) do
            assert.are.equal(1, seen)
        end
    end)
end)

-- ============================================================
-- Regressions found by running an actual war (headless
-- `crossing_standoff`, 2026-08-19). Each of these shipped green under the
-- mock and was wrong on the board, which is why they are pinned by name.
-- ============================================================
describe("what a live war found", function()

    it("does not withdraw a carrier that is only passing through the zone", function()
        -- The strategos's region-scoped directives swept each side's parked
        -- carrier up with the force standing in its landing zone and flew it
        -- across the map. The route crossed the exit, and the side lost its
        -- only way home — empty, two minutes in, for a reason no player could
        -- have seen. §3.4 always said "ORDERED INTO its departure zone".
        local world, g = mock.new(scenario())
        g:GameStart()
        local t = world.spawn(mock.AIRSHIP, 1, 1000, 1000)
        world.setVelocity(t, 2.0, 0)                  -- cruising, not arriving
        world.run(g, 300)
        assert.is_not_nil(world.units[t])
        assert.is_nil(world.trp(1, 'ms_withdrawn_1_transports'))

        world.setVelocity(t, 0, 0)                    -- came to rest: that is a departure
        world.run(g, 400)
        assert.is_nil(world.units[t])
        assert.are.equal(1, world.trp(1, 'ms_withdrawn_1_transports'))
    end)

    it("says so when the engine refuses cargo the arrival declared", function()
        -- Spring.UnitAttach reports a refusal by doing nothing at all — no
        -- error, no return value, no log line. Metalstorm's whole roster was
        -- untransportable (gamedata/modrules.lua's transportability block, and
        -- INFANTRY's speedmodclass 2), so every wave delivered an empty
        -- transport and nothing anywhere said so.
        local world, g = mock.new(scenario({ arrivals = { arrival() } }))
        g:GameStart()
        local realAttach = Spring.UnitAttach
        Spring.UnitAttach = function() end            -- the engine, refusing
        world.run(g, 320)
        Spring.UnitAttach = realAttach
        assert.is_true(world.echoed('cargo unit(s) aboard'))
    end)

    it("keeps a wave whose cargo never boarded flying to its drop zone", function()
        -- "Empty" is not the same question as "arrived". Clearing the wave the
        -- moment nothing is aboard hands the carrier to the departure poll
        -- while it is still sitting on its own entry point — which, for a side
        -- whose entry is near its exit, withdraws the transport seconds after
        -- it arrived.
        local scn = scenario({ arrivals = { arrival({ entry = { x = 1000, z = 1000 } }) } })
        local world, g = mock.new(scn)
        g:GameStart()
        local realAttach = Spring.UnitAttach
        Spring.UnitAttach = function() end
        world.run(g, 400)
        Spring.UnitAttach = realAttach
        -- The entry point is inside team 1's departure zone (1000, 1000, r500)
        -- and the carrier is empty — but it has not reached the drop zone, so
        -- it is still a wave, not a withdrawal asset.
        assert.is_nil(world.trp(1, 'ms_withdrawn_1_transports'))
        local t = nil
        for id, u in pairs(world.units) do
            if u.defID == mock.AIRSHIP and u.team == 1 then t = id end
        end
        assert.is_not_nil(t)
    end)

    it("prices a slot the way the engine does, not the way the plan guessed", function()
        -- §7.7 asked for cost to rise with scale and it does — but the ENGINE
        -- charges `xsize / 2` per passenger, so an s1 squad costs 2 slots, not
        -- 1. A gadget-private slot model that disagrees approves waves the
        -- engine silently truncates: measured, a "2 of 2" wave put one squad
        -- aboard. The validator must predict the engine or it validates
        -- nothing.
        local world, g = mock.new(scenario({
            arrivals = { arrival({ cargo = { { def = 'ms_soldiers_s1', count = 2 } } }) },
        }))
        g:GameStart()
        -- Two s1 squads is 4 slots — exactly the airship's real capacity, and
        -- NOT the 2 the plan's scale-tier numbering predicted.
        assert.are.equal(0, world.rp('war_arrival_invalid'))
        assert.are.equal(2, GG.Transports.SlotCost('ms_soldiers_s1'))
    end)
end)
