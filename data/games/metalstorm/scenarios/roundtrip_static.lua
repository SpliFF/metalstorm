-- scenarios/roundtrip_static.lua — the STATIC world the strict snapshot
-- round-trip bar needs (PLAN-persistence.md §8, Q-P2/Q-P5).
--
-- `--snapshot-roundtrip <F>:<N> --roundtrip-strict` asserts that a restored
-- world's next N ticks are bit-for-bit the ticks it replaced. That bar is only
-- meaningful on a fixture with NOTHING under a move order: Q-P2 decision D
-- forces `inCommand` false on restore, so any unit executing a command
-- re-enters it and re-plans, and the resulting drift is declared behaviour
-- (Q-P5), not a capture gap. docs/debugging-tools.md asked for such a fixture
-- from the day the flag shipped; until 2026-08-14 none existed, and the
-- standing check was run on `soak-ladder` — a war whose civilians and convoys
-- are already moving at frame 2, so the bar could not pass there and had not
-- been passing since long before it was recorded as passing.
--
-- So: real content, a real def load, real gadgets and 40 real units, and not
-- one order between them. Nothing here may ever be given an `orders` block,
-- a `civilians` population or a `convoys` schedule — each of those is a unit
-- under a move order, and one of them is enough to make the strict bar
-- unpassable again. What the fixture is FOR is state that has nothing to do
-- with movement: the RNG position and its draw order (Q-P4), the wind phase
-- (the 450-frame cycle), `activeUnits` ordering, gadget Lua tables, the
-- authority ledger — all of which a moving world hides behind its own drift.
--
-- Run it (60 frames in, 20 ticks per arm — the standing regression check):
--   build/debug/spring-server \
--     --headless-run tools/headless-batch/fixtures/roundtrip-static.json \
--     --port 19133 --db /tmp/rt.sqlite --max-wall-min 8 \
--     --snapshot-roundtrip 60:20 --roundtrip-strict
--
-- green_flat_x34_v3 ships no mapdata/regions.lua, so game_regions.lua falls
-- back to the 2048-elmo grid and the region keys below are grid keys
-- (GG.Regions.KeyAt) — the same model scenario_smoke_test.lua documents.
--
-- `retired = true` keeps a test fixture out of the Create Game picker while
-- leaving the `scenario` modoption and the direct manifest path working; it
-- carries no `victory` objective, so it is non-terminal and can never become
-- a map's default war either. Both guards are asserted in
-- tests/test_scenario_discovery.cpp.

return {
    version   = 1,
    name      = 'Snapshot Round-Trip (static world)',
    tutorial  = false,
    ephemeral = true,            -- a fixture, not a persistent war
    retired   = true,            -- never offered in the create route

    world = {
        map     = 'green_flat_x34_v3',
        regions = {
            { key = '2:2', team = 0 },
            { key = '6:6', team = 1 },
        },
    },

    sides = {
        { faction = 'compact', team = 0 },
        { faction = 'union',   team = 1 },
    },

    -- Two garrisons, facing away from each other and out of every weapon's
    -- range (the bastions are ~12 300 elmos apart): a unit that acquires a
    -- target turns, and a turn is a transform difference the strict bar would
    -- report as a capture gap.
    units = {
        { def = 'ms_tanks_s2',     team = 0, x = 4352, z = 4352, facing = 'west',  count = 4, spacing = 150 },
        { def = 'ms_soldiers_s1',  team = 0, x = 4352, z = 4700, facing = 'west',  count = 6, spacing = 120 },
        { def = 'ms_engineers_s2', team = 0, x = 4050, z = 4352, facing = 'west',  count = 2, spacing = 150 },
        { def = 'ms_radar_s1',     team = 0, x = 4050, z = 4700, facing = 'west',  count = 1 },

        { def = 'ms_tanks_s2',     team = 1, x = 13056, z = 13056, facing = 'east', count = 4, spacing = 150 },
        { def = 'ms_soldiers_s1',  team = 1, x = 13056, z = 12700, facing = 'east', count = 6, spacing = 120 },
        { def = 'ms_engineers_s2', team = 1, x = 13350, z = 13056, facing = 'east', count = 2, spacing = 150 },
        { def = 'ms_radar_s1',     team = 1, x = 13350, z = 12700, facing = 'east', count = 1 },
    },

    -- A pair of control objectives over the two home regions: they pay out
    -- without anyone moving, which is the point — the authority ledger and the
    -- objective gadgets' own Lua tables are live synced state under the walk,
    -- and this is the only fixture that exercises them without movement noise.
    objectives = {
        { type = 'control', scope = 'tactical', forTeam = 0, region = '2:2', reward = 60 },
        { type = 'control', scope = 'tactical', forTeam = 1, region = '6:6', reward = 60 },
    },

    orders    = {},   -- MUST stay empty: see the file note
    convoys   = {},   -- MUST stay empty: see the file note
    civilians = { units = {} },   -- MUST stay empty: see the file note
}
