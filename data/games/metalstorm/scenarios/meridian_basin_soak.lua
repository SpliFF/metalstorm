-- scenarios/meridian_basin_soak.lua — the growth ladder's ENDLESS war
-- (PLAN-long-uptime.md §11.5 T4-3, task 4b).
--
-- WHY THIS FILE EXISTS. The soak ladder measures growth *per simulated day*
-- and bounds its arms by wall clock. `meridian_basin.lua` cannot serve it:
-- that war is a showcase with a deliberately reachable victory (wars §7.5,
-- endtoend D20), and it is won at frame ~12 180 — the same frame twice. After
-- that the sim freezes, the `frame % stateHashEvery` sample gate never fires
-- again, and an arm burns 24 of its 25 wall-minutes on a stationary world
-- still reporting `status=wall-ceiling`. Three of the first baseline's four
-- arms died that way (§11.2), which is why every knob in `soak-matrix.json`
-- looked identical (§11.5 T4-5): the matrix was changing how fast the war was
-- *won*, not how it *grew*.
--
-- THE ONE DIFFERENCE FROM `meridian_basin.lua`: no objective in this file
-- carries `victory = true`. Everything else — region ownership, both sides'
-- staging, the Basin Reavers and their slate, the named resource sites, the
-- ambient civilians, the convoy schedule — is the same content, and
-- `meridian_basin_soak_scenario_spec.lua` asserts that field by field so the
-- two cannot drift apart. That is the point: the ladder must measure the
-- growth surfaces of the war we actually ship, not of a stripped fixture. The
-- previous ladder fixture staged NO scenario at all and measured an 8-unit,
-- `damage=0 deaths=0` world for three simulated hours (§11.1).
--
-- WHAT MAKES IT ENDLESS, and it is not just the missing objective:
--   * game_gameover.lua treats "no victory objective" as a legitimate,
--     supported shape — it warns loudly at frame 60 (`war_can_end = 0`) and
--     never winds the war down. That warning is EXPECTED in a soak log and is
--     the cheapest confirmation the arm is running the right scenario.
--   * The engine's last-team-standing fallback is gated off for Metalstorm
--     (ShouldRunEliminationFallback, rts/Server/GameOverState.h), so an arm
--     does not end even if one side is wiped.
--   * The churn keeps running without a client: `mapdata/civilians.lua`
--     respawns both convoys every 300 s (civilians/convoy.lua reschedules on
--     every spawn), the Reaver slate keeps raiding the two market termini,
--     and objectives/generator.lua keeps issuing systemic objectives for as
--     long as there is a contested world to scan. Those are the three sources
--     the growth report's slopes are made of.
--
-- WHAT IT STILL CANNOT EXERCISE (do not re-derive this): S1 key interning and
-- S6 standing orders are client-gated — `StateStreamer::BroadcastRulesParams`
-- returns at `GetClientCount() == 0` before the interning block — so
-- `param_keys` and `standing_orders` read 0 in ANY headless arm regardless of
-- length (§11.5 T4-2). They belong to ladder 3 or to the scripted wire client.
--
-- `retired = true`: this is a fixture, not a player choice. Retired means
-- shipped, loadable and never offered — the lobby never defaults a room to it
-- and `/api/rooms` refuses it by id, while the `?direct=` manifest path and
-- the `scenario` modoption (which is how the ladder stages it) still work.
-- The `terminal` half of DefaultForMap already excludes it for having no
-- victory objective; `retired` is belt-and-braces so that an endless war can
-- never reach a player through the Create Game picker by accident.

return {
    version   = 1,
    name      = 'Meridian Basin — Endless Soak',
    tutorial  = false,
    retired   = true,            -- fixture, never offered; see the header
    ephemeral = false,           -- persistent war (hibernates when empty)

    world = {
        -- Identical to meridian_basin.lua: home + valley rows owned, the
        -- contested band (ridge rows, the three river passes, the lakes)
        -- neutral at kickoff. Contested ground is what the systemic control
        -- rule scans, so flattening this would flatten the churn.
        regions = {
            -- north (team 0)
            { key = "cinder_forge",  team = 0 },
            { key = "ash_habitat",   team = 0 },
            { key = "northgate",     team = 0 },
            { key = "granary_vale",  team = 0 },
            { key = "northwatch",    team = 0 },
            { key = "north_market",  team = 0 },

            -- south (team 4)
            { key = "slag_forge",    team = 4 },
            { key = "shale_habitat", team = 4 },
            { key = "southgate",     team = 4 },
            { key = "sorghum_vale",  team = 4 },
            { key = "southwatch",    team = 4 },
            { key = "south_market",  team = 4 },
        },
        map     = 'meridian_basin',
    },

    sides = {
        { faction = 'compact', team = 0 },
        { faction = 'compact', team = 1 },
        { faction = 'compact', team = 2 },
        { faction = 'compact', team = 3 },
        { faction = 'union',   team = 4 },
        { faction = 'union',   team = 5 },
        { faction = 'union',   team = 6 },
        { faction = 'union',   team = 7 },
        { faction = 'reavers', team = 8 },
    },

    -- The Basin Reavers, unchanged. This is one of the two churn sources that
    -- keeps running with no client attached (the other is the convoy
    -- schedule): the slate's raid builder keeps sending bands at the two
    -- market termini for as long as the stipend funds them.
    ai = {
        {
            team    = 8,
            profile = 'npc_raider',
            slate   = {
                kinds   = { 'garrison', 'raid', 'toll' },
                home    = 'east_pass',
                targets = { 'north_market', 'south_market' },
                route   = { 'still_mere' },
                reach   = 2,
            },
            stipend = { amount = 35, periodSec = 60 },
        },
    },

    -- Staging is byte-for-byte meridian_basin.lua's, including the opening
    -- FIGHT postures on the basin centroid (8192, 8192). Deliberately kept
    -- even though this map's armour cannot cross to it (§7.6, the retirement
    -- reason): the ladder wants a war that keeps *moving*, and an army that
    -- never resolves its posture is exactly that.
    units = {
        { def = 'ms_tanks_s2', team = 0, x = 6600, z = 1200, facing = 'south', count = 4, spacing = 150,
          orders = { { cmd = 'FIGHT', params = { 8192, 0, 8192 } } } },
        { def = 'ms_soldiers_s1', team = 0, x = 6400, z = 1400, facing = 'south', count = 6, spacing = 100,
          orders = { { cmd = 'FIGHT', params = { 8192, 0, 8192 } } } },
        { def = 'ms_engineers_s1', team = 0, x = 6200, z = 1200, facing = 'south', count = 2, spacing = 120 },
        { def = 'ms_radar_s1', team = 0, x = 13184, z = 1200, facing = 'south', count = 1 },
        { def = 'ms_scout_buggy', team = 0, x = 6900, z = 1400, facing = 'south', count = 2, spacing = 130,
          orders = { { cmd = 'FIGHT', params = { 8192, 0, 8192 } } } },
        { def = 'ms_supply_truck', team = 0, x = 5900, z = 1400, facing = 'south', count = 1 },

        { def = 'ms_tanks_s2', team = 4, x = 6600, z = 15184, facing = 'north', count = 4, spacing = 150,
          orders = { { cmd = 'FIGHT', params = { 8192, 0, 8192 } } } },
        { def = 'ms_soldiers_s1', team = 4, x = 6400, z = 14984, facing = 'north', count = 6, spacing = 100,
          orders = { { cmd = 'FIGHT', params = { 8192, 0, 8192 } } } },
        { def = 'ms_engineers_s1', team = 4, x = 6200, z = 15184, facing = 'north', count = 2, spacing = 120 },
        { def = 'ms_radar_s1', team = 4, x = 13184, z = 15184, facing = 'north', count = 1 },
        { def = 'ms_scout_buggy', team = 4, x = 6900, z = 14984, facing = 'north', count = 2, spacing = 130,
          orders = { { cmd = 'FIGHT', params = { 8192, 0, 8192 } } } },
        { def = 'ms_supply_truck', team = 4, x = 5900, z = 14984, facing = 'north', count = 1 },

        { def = 'ms_soldiers_s1', team = 8, x = 11584, z = 8192, facing = 'north', count = 6, spacing = 110 },
        { def = 'ms_tanks_s1',    team = 8, x = 11800, z = 8400, facing = 'north', count = 3, spacing = 140 },
        { def = 'ms_technical',   team = 8, x = 11400, z = 8420, facing = 'north', count = 3, spacing = 130 },

        { def = 'ms_grain_silo',  team = 'neutral', x = 8000, z = 3900, facing = 'south',
          name = 'Granary Vale Silos' },
        { def = 'ms_grain_silo',  team = 'neutral', x = 8000, z = 12484, facing = 'north',
          name = 'Sorghum Vale Silos' },
        { def = 'ms_tank_farm',   team = 'neutral', x = 12605, z = 4232, facing = 'south',
          name = 'North Market Tank Farm' },
        { def = 'ms_timber_yard', team = 'neutral', x = 12649, z = 11992, facing = 'north',
          name = 'South Market Timber Yard' },
    },

    civilians = {
        units = {
            { def = 'ms_civilians', x = 2920, z = 3900, facing = 'south', role = 'ambient' }, -- ash_habitat
            { def = 'ms_civilians', x = 2920, z = 12484, facing = 'north', role = 'ambient' }, -- shale_habitat
        },
    },

    -- The opening objective set MINUS the strategic victory hold. Everything
    -- here is the same story beat as the showcase war's — the protects and
    -- escorts give the opening ramp its objective churn, the two ridge-pass
    -- controls never expire — and none of them is terminal, so
    -- GG.Objectives.VictoryObjectiveCount() is 0 and game_gameover.lua's
    -- frame-60 check publishes `war_can_end = 0` and leaves the war alone.
    --
    -- The strategic control of `meridian_basin` is kept, WITHOUT `victory`:
    -- dropping it entirely would have removed the map's focal point and with
    -- it the reason both armies march, which is a content change, not a
    -- termination change. It resolves once, pays its reward and stops.
    objectives = {
        { type = 'control', scope = 'strategic', forTeam = nil, region = 'meridian_basin', reward = 300,
          notBefore = 3600,
          expiresAtFrame = nil },

        { type = 'protect', scope = 'tactical', forTeam = 0,
          params = {
              targetUnitIDs = {},
              quorum = 1,
          },
          _populateTargetsFrom = { x = 2700, z = 3900, r = 600, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 9000 },

        { type = 'protect', scope = 'tactical', forTeam = 4,
          params = {
              targetUnitIDs = {},
              quorum = 1,
          },
          _populateTargetsFrom = { x = 2700, z = 12484, r = 600, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 9000 },

        { type = 'escort', scope = 'tactical', forTeam = 0,
          params = {
              payloadUnitIDs = {},
              destArea = { x = 13492, z = 3900, r = 400 },
              quorum = 1,
          },
          _populatePayloadFrom = { route = 'convoy_north' },
          reward = 100,
          expiresAtFrame = 18000 },

        { type = 'escort', scope = 'tactical', forTeam = 4,
          params = {
              payloadUnitIDs = {},
              destArea = { x = 13492, z = 12484, r = 400 },
              quorum = 1,
          },
          _populatePayloadFrom = { route = 'convoy_south' },
          reward = 100,
          expiresAtFrame = 18000 },

        { type = 'control', scope = 'tactical', forTeam = nil, region = 'west_pass', reward = 110,
          expiresAtFrame = nil },
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'east_pass', reward = 110,
          expiresAtFrame = nil },

        { type = 'extract', scope = 'tactical', forTeam = 0,
          params = {
              payloadUnitIDs = {},
              pickupArea = { x = 2700, z = 3900, r = 500 },
              extractArea = { x = 6600, z = 1200, r = 400 },
              holdFrames = 300,
              threshold = 5000,
              quorum = 1,
          },
          _populatePayloadFrom = { x = 2700, z = 3900, r = 600, role = 'ambient' },
          reward = 150,
          expiresAtFrame = 27000 },

        { type = 'extract', scope = 'tactical', forTeam = 4,
          params = {
              payloadUnitIDs = {},
              pickupArea = { x = 2700, z = 12484, r = 500 },
              extractArea = { x = 6600, z = 15184, r = 400 },
              holdFrames = 300,
              threshold = 5000,
              quorum = 1,
          },
          _populatePayloadFrom = { x = 2700, z = 12484, r = 600, role = 'ambient' },
          reward = 150,
          expiresAtFrame = 27000 },
    },

    orders = {},

    -- Informational mirror of mapdata/civilians.lua, same as the showcase
    -- war's. The authoritative respawn interval lives there, and it is what
    -- keeps this war's escort traffic running for the length of an arm.
    convoys = {
        { id = 'convoy_north', side = 'north', from = 'ash_habitat', to = 'north_market',
          via = { 'granary_vale' }, intervalSec = 300 },
        { id = 'convoy_south', side = 'south', from = 'shale_habitat', to = 'south_market',
          via = { 'sorghum_vale' }, intervalSec = 300 },
    },
}
