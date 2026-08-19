-- crossing_standoff_scenario_spec.lua — the showcase war's invariants.
--
-- Replaces meridian_basin_scenario_spec.lua, retired with its scenario on
-- 2026-08-06 (PLAN-metalstorm-wars.md §7.6 — Meridian Basin is not a playable
-- map; its start positions sit in three disconnected components of the VEH and
-- HEAVY passability masks).
--
-- Deliberately NOT a transcription of the scenario file. The old spec asserted
-- things like "civilians.units[1].x == 2920", which only ever restated the
-- content back at itself and would have to be edited in lockstep with any
-- change to it — so it could not fail for a reason worth knowing. What is
-- asserted here instead is the set of properties that, when they broke, each
-- produced a war that could not be played: they are endtoend D19 and D20 and
-- §7.6's content rule, written down as checks.
--
-- Run from the GAME root, like its predecessor:
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/crossing_standoff_scenario_spec.lua
-- From `LuaRules/Gadgets` it reports errors that are a wrong cwd ("cannot open
-- scenarios/..."), not real failures.

local SCENARIO = 'scenarios/crossing_standoff.lua'

-- Defs that cannot shoot: the civilian-building family plus unarmed civilians
-- (units/buildings_civilian.lua sets canattack=false for all three; civilians
-- scale 1 is canattack=false, and ms_militia — scale 2 — is NOT, which is
-- exactly the distinction this list exists to hold).
local UNARMED_NEUTRAL_DEFS = {
    ms_habitat = true, ms_depot = true, ms_transit_hub = true, ms_civilians = true,
}

describe("Scorched Crossing — The Standoff", function()
    local scn

    before_each(function()
        scn = dofile(SCENARIO)
    end)

    it("is a pure table literal the lobby's bare lua_State can parse", function()
        -- ScenarioDiscovery::LoadOne has no VFS, no Spring.*, no require. A
        -- scenario that needs any of them does not fail loudly — it silently
        -- vanishes from the Create Game list. dofile() with none of those
        -- globals present is the same test the lobby applies.
        assert.is_table(scn)
        assert.equals(1, scn.version)
        assert.is_string(scn.name)
    end)

    it("targets a map whose armies can reach each other", function()
        -- The whole point of the lane. The reachability itself is graded by
        -- tools/mapgen/regions_from_map.py --verify against the map's
        -- heightmap; data/maps is gitignored so it cannot be graded here.
        -- What IS enforced here is that the map is not one of the two known
        -- unplayable ones, so a future edit cannot quietly point back at them.
        assert.equals('scorched_crossing_v2.4', scn.world.map)
        assert.not_equals('meridian_basin', scn.world.map)
        assert.not_equals('skerry_reach', scn.world.map)
    end)

    it("declares exactly one victory objective", function()
        -- game_gameover.lua watches for exactly this, and
        -- ScenarioDiscovery::DefaultForMap skips a scenario without one — so
        -- zero makes the war unendable and two makes the ending ambiguous.
        local victories = 0
        for _, o in ipairs(scn.objectives) do
            if o.victory then victories = victories + 1 end
        end
        assert.equals(1, victories)
    end)

    it("cannot be won before the two armies can meet", function()
        -- endtoend D20: the war used to be decided by whoever walked into the
        -- middle first. `notBefore` is what makes "the war ended before the
        -- sides met" unrepresentable rather than merely unlikely, and the hold
        -- resets when the region is contested, so winning means holding the
        -- prize against someone.
        local victory
        for _, o in ipairs(scn.objectives) do
            if o.victory then victory = o end
        end
        assert.is_number(victory.notBefore)
        assert.is_number(victory.holdFrames)
        -- scenariogen measured the worst-case approach on this map at 3411
        -- frames for the slowest staged class.
        assert.is_true(victory.notBefore >= 3411)
        assert.is_nil(victory.expiresAtFrame)   -- the prize does not lapse
    end)

    it("stages an army for every declared side, on consecutive teams from 0", function()
        -- endtoend D19: a side the scenario stages nothing for is a room slot
        -- that starts with no units, and the room seats an opponent onto it.
        -- Consecutive-from-0 keeps the engine from materialising unoccupied
        -- gap teams between the sides.
        local staged = {}
        for _, u in ipairs(scn.units) do
            if type(u.team) == 'number' then staged[u.team] = true end
        end
        for i, side in ipairs(scn.sides) do
            assert.equals(i - 1, side.team)
            assert.is_true(staged[side.team],
                'side ' .. side.faction .. ' (team ' .. side.team .. ') stages no units')
        end
    end)

    it("gives every mobile unit an opening order, on both sides", function()
        -- D20's finding 1 verbatim: nine of thirteen staged units had no
        -- orders and stood on their spawn tile for the whole war. The frame-60
        -- `war_units_unordered` guard does NOT catch this — it fires only when
        -- a team has ZERO ordered units, so a partly-ordered army reads clean.
        -- Hence the check lives here.
        local IMMOBILE = { ms_radar_s1 = true }
        local STAY_HOME = {
            ms_engineers_s1 = true,   -- deliberately not in the push
            -- The carrier is staged-as-arrived (transports §3.2) and stays
            -- PARKED. An opening order on it would be exactly backwards:
            -- there is deliberately no auto-withdraw macro (§3.4, "withdrawal
            -- is a mechanic, not a menu"), so the player loads it, protects it
            -- and flies it to the departure zone. Sending it toward the basin
            -- on frame 0 would fly the side's only way home into the fight.
            fable_airship = true,
        }
        local ordered, unordered = 0, {}
        for _, u in ipairs(scn.units) do
            if type(u.team) == 'number' and not IMMOBILE[u.def] and not STAY_HOME[u.def] then
                if u.orders and #u.orders > 0 then ordered = ordered + 1
                else unordered[#unordered + 1] = u.def .. '@team' .. u.team end
            end
        end
        assert.is_true(ordered > 0)
        assert.same({}, unordered)
    end)

    it("sends both sides to the SAME point, not to their own edge of it", function()
        -- Two armies ordered to their own near edge of the prize "arrive" in
        -- the same region and out of weapon range of each other — the longest
        -- weapon in this roster reaches 1100 elmos, and Meridian's two sides
        -- were sent to points 1184 apart.
        local targets = {}
        for _, u in ipairs(scn.units) do
            if type(u.team) == 'number' and u.orders then
                for _, o in ipairs(u.orders) do
                    targets[o.params[1] .. ',' .. o.params[3]] = true
                end
            end
        end
        local n = 0
        for _ in pairs(targets) do n = n + 1 end
        assert.equals(1, n)
    end)

    it("puts nothing that shoots on a team the lobby cannot seat", function()
        -- PLAN-metalstorm-wars.md §7.6. `team = 'neutral'` resolves to Gaia,
        -- whose index the engine derives from the ROOM roster, and Gaia is its
        -- own ally team with no allies — hostile, not neutral. Armed set
        -- dressing therefore shoots both players and, measured, decided a war
        -- (scenariogen §12.4: a Gaia howitzer destroyed one side's entire
        -- infantry 2740 elmos short of the objective).
        for _, u in ipairs(scn.units) do
            if u.team == 'neutral' then
                assert.is_true(UNARMED_NEUTRAL_DEFS[u.def] == true,
                    'neutral cluster stages ' .. u.def .. ', which is not on the unarmed list')
            end
        end
        -- ...and the same rule is why there is no NPC faction to begin with.
        assert.is_nil(scn.ai)
    end)

    it("scopes the victory objective to no team", function()
        -- An objective scoped to a team the launch did not supply throws
        -- "Bad teamID" out of the Objectives gadget's callin; gadgetHandler
        -- then removes the gadget and nothing is evaluated for the rest of the
        -- match — victory objective included.
        for _, o in ipairs(scn.objectives) do
            if o.victory or o.scope == 'strategic' then assert.is_nil(o.forTeam) end
        end
    end)

    it("backs each protect objective with civilians the sweep can actually find", function()
        -- `_populateTargetsFrom`'s role filter reads the GG.Civilians registry,
        -- and a role lives ONLY there — never on a unitdef. So a protect
        -- objective asking for role='ambient' is satisfiable only by entries in
        -- the `civilians` block, not by ms_civilians staged through `units`.
        -- An objective whose sweep finds nothing is skipped, not staged empty.
        local ambient = {}
        for _, c in ipairs(scn.civilians.units) do
            if c.role == 'ambient' then ambient[#ambient + 1] = c end
        end
        assert.is_true(#ambient > 0)

        local protects = 0
        for _, o in ipairs(scn.objectives) do
            if o.type == 'protect' then
                protects = protects + 1
                local a = o._populateTargetsFrom
                assert.is_table(a)
                assert.equals('ambient', a.role)
                local found = 0
                for _, c in ipairs(ambient) do
                    local dx, dz = c.x - a.x, c.z - a.z
                    if math.sqrt(dx * dx + dz * dz) <= a.r then found = found + 1 end
                end
                assert.is_true(found >= (o.params.quorum or 1),
                    'protect objective at ' .. a.x .. ',' .. a.z ..
                    ' has ' .. found .. ' ambient civilians in radius ' .. a.r)
            end
        end
        assert.equals(#scn.sides, protects)   -- one per playable side
    end)

    it("addresses regions by the map's generated graph keys", function()
        -- scorched_crossing_v2.4 ships mapdata/regions.lua, so game_regions.lua
        -- selects the named graph provider. These are GENERATED names — no key
        -- is shared with Meridian's hand-authored graph, which is most of why
        -- §7.6 rejected porting the old scenario as a rename. A key that is not
        -- in the graph is a hard validation error at GameStart, not a warning.
        local KEYS = {
            fallow_gate = true, osprey_fen = true, vesper_drift = true, iron_bend = true,
            copper_rise = true, marrow_watch = true, thorn_crossing = true, ash_verge = true,
            storm_sound = true, kestrel_forge = true, raven_basin = true, east_span = true,
            amber_row = true, grey_flat = true, pale_vale = true, wither_hollow = true,
        }
        for _, r in ipairs(scn.world.regions) do
            assert.is_true(KEYS[r.key] == true, 'unknown region key: ' .. tostring(r.key))
        end
        for _, o in ipairs(scn.objectives) do
            if o.region then
                assert.is_true(KEYS[o.region] == true, 'unknown region key: ' .. tostring(o.region))
            end
        end
    end)

    it("opens with each side owning only its own landing zone", function()
        -- The prize starts uncontrolled: everything between the two armies is
        -- neutral ground they have to walk into.
        local owned = {}
        for _, r in ipairs(scn.world.regions) do owned[r.key] = r.team end
        assert.equals(#scn.sides, (function()
            local n = 0; for _ in pairs(owned) do n = n + 1 end; return n
        end)())
        for _, o in ipairs(scn.objectives) do
            if o.victory then assert.is_nil(owned[o.region]) end
        end
    end)
end)

-- ============================================================
-- Transports (PLAN-metalstorm-transports.md §3.2/§3.3/§7.1). Before this,
-- NO shipped scenario staged a transport, so every mechanism
-- game_transports.lua implements was unreachable in a real war.
-- ============================================================
describe("Scorched Crossing — transports", function()
    local scn

    before_each(function()
        scn = dofile(SCENARIO)
    end)

    it("stages a carrier for each side, parked, as part of its declared force", function()
        local carriers = {}
        for _, u in ipairs(scn.units) do
            if u.def == 'fable_airship' then carriers[u.team] = u end
        end
        assert.is_not_nil(carriers[0])
        assert.is_not_nil(carriers[1])
        -- §3.2: staged-as-arrived, not a frame-0 drive-in.
        assert.is_nil(carriers[0].orders)
        assert.is_nil(carriers[1].orders)
    end)

    it("flags both sides expeditionary — this army was SENT here (§7.1)", function()
        for _, side in ipairs(scn.sides) do
            assert.is_true(side.expeditionary,
                'side ' .. side.faction .. ' landed here and must be expeditionary')
        end
    end)

    it("gives each side a departure zone clear of its own parked carrier", function()
        -- A departure zone drawn over your own staged transport deletes it on
        -- the first poll after frame 60.
        local carriers = {}
        for _, u in ipairs(scn.units) do
            if u.def == 'fable_airship' then carriers[u.team] = u end
        end
        for _, side in ipairs(scn.sides) do
            local d = side.departure
            assert.is_not_nil(d, 'side ' .. side.faction .. ' has no departure zone')
            local c = carriers[side.team]
            local dx, dz = c.x - d.x, c.z - d.z
            assert.is_true(math.sqrt(dx * dx + dz * dz) > d.radius,
                'the parked carrier of team ' .. side.team .. ' sits in its own exit')
        end
    end)

    it("authors a mirrored arrival wave per side, after the victory notBefore", function()
        assert.are.equal(2, #scn.arrivals)
        local notBefore
        for _, o in ipairs(scn.objectives) do
            if o.victory then notBefore = o.notBefore end
        end
        local byTeam = {}
        for _, a in ipairs(scn.arrivals) do
            byTeam[a.team] = a
            -- §3.3: an arrival with no order unloads into silence (D20's
            -- finding 1 — a unit nobody ordered never moves).
            assert.is_not_nil(a.order, a.id .. ' declares no order')
            -- §7.8: an eta before the war can even be decided is a wave that
            -- reinforces a decision already made.
            assert.is_true(a.eta > notBefore, a.id .. ' arrives before the war can start')
        end
        assert.is_not_nil(byTeam[0])
        assert.is_not_nil(byTeam[1])
        assert.are.equal(byTeam[0].eta, byTeam[1].eta)   -- symmetric war, symmetric waves
    end)

    it("keeps every wave inside its carrier's slot capacity (§7.7)", function()
        -- fable_airship carries 2 slots; an s1 squad costs 1 (scale tier).
        -- game_transports validates this at load and DROPS an overweight wave
        -- whole rather than half-staging it, so an over-packed scenario loses
        -- its reinforcements silently as far as the player is concerned.
        local SLOTS = { fable_airship = 2 }
        local COST = { ms_soldiers_s1 = 1, ms_tanks_s2 = 2, ms_tanks_s3 = 3 }
        for _, a in ipairs(scn.arrivals) do
            local used = 0
            for _, c in ipairs(a.cargo) do
                assert.is_not_nil(COST[c.def], 'unpriced cargo def ' .. c.def)
                used = used + COST[c.def] * (c.count or 1)
            end
            assert.is_true(used <= SLOTS[a.def], a.id .. ' is over capacity')
        end
    end)

    it("enters and lands every wave on the map", function()
        -- The map is 8960 square: this file's header fixes `raven_basin` at
        -- the dead centre, (4480, 4480). game_transports validates the same
        -- thing at load against the live Game.mapSizeX and drops an off-map
        -- wave whole; this catches it before a war is launched to find out.
        local W = 8960
        for _, a in ipairs(scn.arrivals) do
            for _, p in ipairs({ a.entry, a.dropZone }) do
                assert.is_true(p.x >= 0 and p.x <= W and p.z >= 0 and p.z <= W,
                    a.id .. ' has an off-map point')
            end
        end
    end)
end)
