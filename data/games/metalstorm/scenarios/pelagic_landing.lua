-- scenarios/pelagic_landing.lua — "Hollow Dell — The Landing".
--
-- The amphibious showcase, and the second offerable war beside
-- scenarios/crossing_standoff.lua. Where the Standoff is two armies walking
-- into each other across one landmass, this is the case the battle-flow lane
-- (docs/reviews/2026-09-10/battle-flow.md) exists to make playable: a force
-- that ARRIVES ACROSS WATER, unloads OFFSHORE, and has to get inland before
-- the defender closes the door.
--
-- WHY THIS MAP. `pelagic_expanse` is a 16384-elmo archipelago (terragen seed
-- 47, 34% land, 9 islands) that ships mapdata/regions.lua — a 123-region
-- NAMED graph, so game_regions.lua selects the graph provider and every key
-- below is copied from that file, not invented.
--
-- IT IS A DECLARED-SPLIT MAP, and that is the point.
-- `tools/mapgen/regions_from_map.py data/maps/pelagic_expanse --verify` reads
-- its eight start positions in SIX disconnected VEH components. Under
-- PLAN-maps.md §2k that is legal player content rather than a defect — the
-- crossing is a transport problem — and the map's `mapinfo.lua` must say so.
-- It did not: it declared `reachability = "connected"`, which is stale and
-- silences the gate. Corrected to `"split"` alongside this file (see
-- docs/scenarios.md — the map itself is gitignored content, so the correction
-- lives in the working copy and in terragen's emitter, not in this commit).
--
-- WHAT THAT MEANS FOR THE ROSTER BELOW, measured rather than assumed
-- (regions_from_map.MOVE_CLASSES over this map's own heightmap):
--
--   * THIS THEATRE — ash_ridge, quarry_bluff, south_shelf, raven_watch,
--     east_crossing, hollow_dell — is ONE component for INFANTRY (45 deg
--     maxslope / 12 elmo ford) and ONE component for VEH (32 deg / 20 elmo).
--     Both armies can reach the prize on foot and on wheels. The war can end.
--   * It is NOT one component for HEAVY (24 deg / 30 elmo): raven_watch,
--     east_crossing, hollow_dell and the ash_ridge causeway are not HEAVY-
--     passable at all. So this war stages NO HEAVY def — no ms_tanks_s3/s4,
--     no ms_artillery_s3/s4, no fable_heavy, no ms_engineers_s4. A heavy
--     column here is the Meridian failure with a different seed: an army
--     ordered at a prize its movement class cannot reach, standing still for
--     the whole match. §13 of the same review says game_start.lua's default
--     force has this bug on split maps; a scenario that stages its own roster
--     does not get to make the same mistake.
--
-- FILE-SCOPE NOTE (the same one crossing_standoff.lua carries, and it is not
-- decoration): ScenarioDiscovery::LoadOne parses this with a bare lua_State —
-- no VFS, no Spring.*, no require. A computed global at file scope does not
-- fail loudly; it makes the scenario silently VANISH from the lobby's Create
-- Game list. Keep this a pure table literal. Edits are invisible until the
-- lobby restarts or POST /api/admin/scenarios/resync runs (the debug MCP's
-- `write_scenario` does one for you) — the lobby snapshots scenarios at
-- startup.
--
-- Its mirror is scenarios/pelagic_counterlanding.lua: the same map, the same
-- prize, the roles flipped.

return {
    version   = 1,
    name      = 'Hollow Dell — The Landing',
    tutorial  = false,
    ephemeral = false,

    world = {
        map = 'pelagic_expanse',
        -- Each side opens owning only the ground it is standing on. The prize
        -- and the three regions between the two forces start uncontrolled.
        regions = {
            { key = 'ash_ridge',   team = 0 },   -- the compact's home island
            { key = 'hollow_dell', team = 1 },   -- the union's beachhead
        },
    },

    -- ASYMMETRIC BY DESIGN, unlike the Standoff. Only the union is
    -- `expeditionary` (PLAN-metalstorm-transports.md §7.1) — that flag gates
    -- `ms_stranded_<team>` and the `war_side_stranded` guard, which only mean
    -- anything for a force that arrived by transport and can therefore be
    -- trapped ashore. The compact is standing in its own town; flagging a home
    -- defender fires the stranding guard on people in their own kitchen,
    -- forever, so it carries neither the flag nor a `departure`.
    --
    -- The union's `departure` is §3.4's withdrawal zone and, under §7.10, the
    -- same circle objectives/escort.lua calls `extractArea`. It is OPEN SEA
    -- (9660, 5292 reads 25 elmos deep and is in the same ship-navigable body
    -- of water as the entry lane below — checked by flood fill, not by eye:
    -- a SHIP needs 12 elmos under it, so a "withdrawal zone" over a sand bar
    -- is a zone no ship can ever enter). It sits 962 elmos from the parked
    -- landing ship: a departure circle drawn over your own staged carrier
    -- deletes it on the first poll after frame 60, which reads as a crash.
    sides = {
        { faction = 'compact', team = 0 },
        { faction = 'union',   team = 1, expeditionary = true,
          departure = { x = 9660, z = 5292, radius = 450 } },
    },

    briefing = {
        title    = 'The Landing',
        subtitle = 'Pelagic Expanse',
        story    = [[The Union came the only way anyone comes to the Expanse: by sea. Landing ships put the first wave ashore in Hollow Dell before dawn, and the ramps are still down.

Ash Ridge knew they were coming and could not stop them at the water. What Ash Ridge can still do is hold the high ground behind the beach. Raven Watch is the crossroads every track on this island funnels through — the Union cannot get off the Dell without it, and the Compact cannot push them back into the sea without it either.

The second wave is already at sea. So is the third.]],
        tips     = {
            'You are fighting on an ARCHIPELAGO. Armour and infantry can both reach Raven Watch from either side, but heavy armour cannot cross this island at all — nothing heavier than ms_tanks_s2 is in either order of battle, on purpose.',
            'Victory is holding Raven Watch for 3 unbroken minutes, and it cannot be decided before the 3-minute mark. A contested crossroads resets the hold clock: you have to hold it against somebody.',
            'Union reinforcements arrive BY SEA. A landing ship stops offshore — it cannot beach — and unloads onto the sand within 450 elmos. Cover the water: a wave killed in transit is a wave that never lands.',
            'The Union\'s landing ship is still on the beach and it is the way home. Protect it, load it, and sail it to the departure zone yourself — withdrawal is a mechanic, not a menu.',
            'The Compact relief convoy comes ashore on Quarry Bluff at the 3-minute mark, behind the Union\'s right flank.',
            'Hollow Dell village declared for nobody. Both sides are scored on keeping their own civilians alive, and a raid on the other side\'s people denies them the reward.',
        },
        parTimeSec = 900,
    },

    units = {
        -- ============== COMPACT (team 0) — Ash Ridge ======================
        -- The opening FIGHT for every mobile entry on BOTH sides is the same
        -- point: (7824, 5408), the centroid of the `raven_watch` polygon. Not
        -- each side's near edge of it — two armies ordered to their own edge
        -- "arrive" in the same region and out of weapon range of each other,
        -- which is how a war gets decided with no shot fired (endtoend D20's
        -- fire-7 finding).
        { def = 'ms_tanks_s2', team = 0, x = 5900, z = 3600, facing = 'south', count = 3, spacing = 270,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_soldiers_s2', team = 0, x = 5772, z = 3340, facing = 'south', count = 4, spacing = 130,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_artillery_s2', team = 0, x = 5628, z = 3468, facing = 'south', count = 2, spacing = 270,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        -- The causeway garrison STAYS. No order, deliberately: this is the
        -- door the union has to come through if it goes around the north, and
        -- a garrison that walks off to the prize is not a garrison.
        { def = 'ms_soldiers_s1', team = 0, x = 6076, z = 3956, facing = 'south', count = 3, spacing = 110 },
        { def = 'ms_staticdefense_s2', team = 0, x = 6124, z = 3876, facing = 'south' },
        { def = 'ms_staticdefense_s2', team = 0, x = 6012, z = 3876, facing = 'south' },
        -- Engineers and the sensor mast stay home; they are not part of the
        -- push. The mast is also the union's `kill` objective below.
        { def = 'ms_engineers_s1', team = 0, x = 5540, z = 3212, facing = 'south', count = 2, spacing = 120 },
        { def = 'ms_radar_s2', team = 0, x = 5476, z = 2988, facing = 'south' },

        -- Ash Ridge town. These are the COMPACT'S OWN buildings (team 0), not
        -- set dressing: it is their town. All three defs are canattack=false
        -- (units/buildings_civilian.lua), so §7.6's content rule — nothing
        -- that shoots on a team the lobby cannot seat — is satisfied by the
        -- defs rather than by the team choice.
        { def = 'ms_meeting_hall', team = 0, x = 5284, z = 3020, facing = 'south' },
        { def = 'ms_habitat',      team = 0, x = 5156, z = 2956, facing = 'south' },
        { def = 'ms_depot',        team = 0, x = 5220, z = 3212, facing = 'south' },

        -- ============== UNION (team 1) — the Hollow Dell beachhead ========
        -- STAGED AS ARRIVED (§3.2), not a frame-0 drive-in: serially unloading
        -- an army at the top of the match buys theatre and costs the opening
        -- pacing D20 spent seven fires fixing. The ramps are down; the war
        -- starts with the first wave already on the sand.
        -- The beach is 300 elmos of usable sand between the surf and the
        -- scarp, so every spread below is sized to FIT it: the tank trio at
        -- 170 (270, the Standoff's armour spacing, puts its left file in the
        -- water) and the squads at 110-130. `count`/`spacing` lays a
        -- square-ish grid CENTRED on the point, not anchored at it
        -- (game_scenario.lua gridOffsets) — a 3-wide trio therefore reaches
        -- half a spacing to EACH side, which is the arithmetic that put the
        -- first draft of this line offshore.
        { def = 'ms_soldiers_s1', team = 1, x = 8690, z = 4350, facing = 'west', count = 4, spacing = 110,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_soldiers_s2', team = 1, x = 8700, z = 4480, facing = 'west', count = 2, spacing = 130,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_tanks_s2', team = 1, x = 8560, z = 4400, facing = 'west', count = 3, spacing = 170,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        -- The batteries are already off the sand, on the shelf behind it:
        -- artillery outranges tanks, and the beach is the one place on this
        -- map where being outranged has no flank to use.
        { def = 'ms_artillery_s2', team = 1, x = 8330, z = 4460, facing = 'west', count = 2, spacing = 160,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_engineers_s1', team = 1, x = 8790, z = 4430, facing = 'west', count = 2, spacing = 120 },
        { def = 'ms_radar_s1', team = 1, x = 8800, z = 4560, facing = 'west' },

        -- The hull that brought them, still where it grounded — 25 elmos of
        -- water under it, which is what a SHIP needs (moveinfo.tdf
        -- minwaterdepth 12) and what a beached one would not have. No order: a
        -- carrier that sails off on its own is a carrier the player cannot
        -- use, and it is the compact's `kill` objective below.
        { def = 'ms_landing_ship', team = 1, x = 9300, z = 4400, facing = 'west' },
        -- The air lift that came with it, set down on the dell.
        { def = 'fable_airship', team = 1, x = 8660, z = 4300, facing = 'west' },

        -- ============== HOLLOW DELL VILLAGE (Gaia) =======================
        -- `team = 'neutral'` resolves to the Gaia team at stage time (the Gaia
        -- id is playerTeamCount, which depends on the room roster and is
        -- therefore not knowable when this file is written).
        --
        -- Buildings come through `units`, never through the `civilians` block:
        -- that block registers everything role='ambient', and
        -- civilians/routines.lua then issues CMD_MOVE at every ambient entry
        -- every tick — enrolling immobile buildings in a move loop they can
        -- never satisfy.
        --
        -- The village sits INLAND of the beachhead (the flat pocket at
        -- 8200-8300 / 4600-4800 is the only ground in hollow_dell that takes a
        -- 12x12 footprint), off the beach-to-Raven-Watch axis, so a
        -- FIGHT-ordered column does not divert into it.
        { def = 'ms_habitat',      team = 'neutral', x = 8232, z = 4712, facing = 'south' },
        { def = 'ms_depot',        team = 'neutral', x = 8264, z = 4616, facing = 'south' },
        { def = 'ms_transit_hub',  team = 'neutral', x = 8200, z = 4776, facing = 'south' },
    },

    -- The populations the two `protect` objectives are scored on. These MUST
    -- come through `civilians` rather than `units`: `_populateTargetsFrom`'s
    -- `role` filter reads GG.Civilians' registry, and a role lives only there,
    -- never on a unitdef (game_scenario.lua:493-518).
    --
    -- Every one is >= 220 elmos from its settlement's building centres:
    -- ms_habitat's 12x12 footprint blocks ground out to a 96-elmo half-extent
    -- per axis, and a unit spawned inside a structure's blocked yardmap is
    -- trapped permanently — GiveOrderToUnit "succeeds" and the unit never
    -- moves.
    civilians = {
        units = {
            { def = 'ms_civilians', x = 4964, z = 3084, facing = 'south', role = 'ambient' },  -- Ash Ridge
            { def = 'ms_civilians', x = 5284, z = 2764, facing = 'south', role = 'ambient' },  -- Ash Ridge
            { def = 'ms_civilians', x = 8392, z = 4392, facing = 'north', role = 'ambient' },  -- Hollow Dell
            { def = 'ms_civilians', x = 8232, z = 4936, facing = 'north', role = 'ambient' },  -- Hollow Dell
        },
    },

    -- ========================================================================
    -- ARRIVALS (PLAN-metalstorm-transports.md §3.3, staged by
    -- game_transports.lua). Since the 2026-08-19 ruling removed production
    -- from battle maps, an arrival is the ONLY way force enters after the
    -- opening, and there is deliberately no in-battle way to ask for one
    -- (§7.2) — the schedule is fixed when the scenario materialises.
    --
    -- THE SEA GEOMETRY IS NOT DECORATIVE and is validated at load
    -- (game_transports.lua `terrainProblem`, added by this lane's review):
    --
    --   * `entry` and `dropZone` must BOTH be under at least the carrier's
    --     `minWaterDepth` (SHIP = 12). A dry entry is refused by CreateUnit
    --     with nil and no log line; an inland drop zone never "arrives" and
    --     re-issues its unload every 300 frames for the rest of the war.
    --   * The drop zone is therefore NECESSARILY OFFSHORE, so it has to be
    --     within `dropRadius` (sea default 450) of dry ground or UNLOAD_UNITS
    --     finds nowhere to put anybody. Both lanes below were picked by
    --     flood-filling the ship-navigable water from the entry and then
    --     measuring to the nearest beach: 200 elmos for the union lane,
    --     275 for the compact's.
    --
    -- `eta` is §7.8's projection: the world layer resolves transit and hands
    -- the battle one frame number, at the §7.4 clock's 24x ratio (one world
    -- hour ~ 4500 frames). Wave 1 at 2700 lands while the opening fight is
    -- still forming; wave 2 at 8100 lands only if the war is still running,
    -- because an eta past the ending is cancelled rather than spawned.
    --
    -- Capacity is real and checked at load. ms_landing_ship carries 8 slots
    -- and a passenger costs its `footprintx`: ms_tanks_s2 is 3, ms_soldiers_s1
    -- is 2, so 3 + 2 + 2 = 7 of 8. fable_airship carries 4: two s1 squads is
    -- exactly full.
    arrivals = {
        { id       = 'union_wave_1',
          team     = 1,
          kind     = 'sea',
          def      = 'ms_landing_ship',
          eta      = 2700,
          entry    = { x = 9900, z = 4300 },     -- 21 elmos deep, open sea
          dropZone = { x = 8876, z = 4252 },     -- 19 deep; beach 200 elmos west
          cargo    = { { def = 'ms_tanks_s2', count = 1 },
                       { def = 'ms_soldiers_s1', count = 2 } },
          order    = { cmd = 'FIGHT', x = 7824, z = 5408 } },

        -- The air lane sets down INLAND, on the east_crossing saddle
        -- (8640, 5344 reads 56 elmos of dry ground) rather than on the beach:
        -- an air drop zone has to suit the CARGO, not the carrier, and it is
        -- the union's one chance to put infantry above the crossroads instead
        -- of below it.
        { id       = 'union_wave_2',
          team     = 1,
          kind     = 'air',
          def      = 'fable_airship',
          eta      = 4200,
          entry    = { x = 9900, z = 6000 },
          dropZone = { x = 8640, z = 5344 },
          cargo    = { { def = 'ms_soldiers_s1', count = 2 } },
          order    = { cmd = 'FIGHT', x = 7824, z = 5408 } },

        -- The compact's relief convoy, and the reason this war is not a
        -- one-sided transport demo: it comes ashore on Quarry Bluff, behind
        -- the union's right flank, on the same validated sea machinery.
        { id       = 'compact_relief',
          team     = 0,
          kind     = 'sea',
          def      = 'ms_landing_ship',
          eta      = 5400,
          entry    = { x = 6396, z = 3116 },     -- the northern strait
          dropZone = { x = 6572, z = 3852 },     -- 27 deep; beach 275 elmos SE
          cargo    = { { def = 'ms_tanks_s2', count = 1 },
                       { def = 'ms_soldiers_s1', count = 2 } },
          order    = { cmd = 'FIGHT', x = 7824, z = 5408 } },

        { id       = 'union_wave_3',
          team     = 1,
          kind     = 'sea',
          def      = 'ms_landing_ship',
          eta      = 8100,
          entry    = { x = 9900, z = 4300 },
          dropZone = { x = 8876, z = 4252 },
          cargo    = { { def = 'ms_soldiers_s1', count = 2 },
                       { def = 'ms_soldiers_s2', count = 2 } },
          order    = { cmd = 'FIGHT', x = 7824, z = 5408 } },
    },

    objectives = {
        -- ===== THE VICTORY OBJECTIVE ====================================
        -- `victory = true` is the only terminal condition game_gameover.lua
        -- watches, and ScenarioDiscovery::DefaultForMap skips a scenario
        -- without one outright: zero makes the war unendable, two make the
        -- ending ambiguous. It is an OPEN race (forTeam nil) because an
        -- objective scoped to a team the launch did not supply throws
        -- "Bad teamID" out of the Objectives gadget's callin, gadgetHandler
        -- removes the gadget, and nothing is evaluated for the rest of the
        -- match.
        --
        -- SIZING. Raven Watch is the chokepoint crossroads between the two
        -- forces — 2100 elmos from the union beachhead, 3500 from the compact
        -- staging line, and in the same INFANTRY and VEH component as both.
        -- `notBefore = 5400` (3 min) puts the earliest possible completion
        -- after the slower side can physically be there, so "the war ended
        -- before the sides could meet" is unrepresentable rather than merely
        -- unlikely. `holdFrames = 5400` is DEFAULT_VICTORY_HOLD_FRAMES and a
        -- contested region resets the hold, so winning means holding the
        -- crossroads against somebody. Floor on the war: 10800 frames / 6 min.
        { type = 'control', scope = 'strategic', forTeam = nil,
          region = 'raven_watch', reward = 300,
          victory = true,
          notBefore = 5400, holdFrames = 5400,
          expiresAtFrame = nil },

        -- ===== TACTICAL: the ground between ============================
        -- Open races on the three regions NEITHER side starts owning. A
        -- control objective on a region a side already holds completes on the
        -- first tick, which is a reward for having been dealt it.
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'south_shelf', reward = 110,
          expiresAtFrame = nil },
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'east_crossing', reward = 110,
          expiresAtFrame = nil },
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'quarry_bluff', reward = 110,
          expiresAtFrame = nil },

        -- ===== TACTICAL: keep your own people alive ====================
        -- targetUnitIDs is populated at the frame-30 civilian sweep from the
        -- area below; the objective is SKIPPED with a log line, not staged
        -- empty, if the sweep finds nobody (an empty array fails init).
        { type = 'protect', scope = 'tactical', forTeam = 0,
          params = { targetUnitIDs = {}, quorum = 1 },
          _populateTargetsFrom = { x = 5156, z = 2956, r = 700, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 18000 },

        { type = 'protect', scope = 'tactical', forTeam = 1,
          params = { targetUnitIDs = {}, quorum = 1 },
          _populateTargetsFrom = { x = 8232, z = 4712, r = 700, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 18000 },

        -- ===== TACTICAL: the two HVTs ==================================
        -- §3.6's high-value targets, one each, and the only asymmetric pair in
        -- the file. `_populateUnitsFrom` with `into = 'targetUnitID'` resolves
        -- the NEAREST match to the marker centre, so two candidates in radius
        -- resolve the same way every run rather than by engine iteration
        -- order; a marker that finds nobody skips the objective rather than
        -- creating a broken one.
        --
        -- The union hunts the mast that sees its waves coming.
        { type = 'kill', scope = 'tactical', forTeam = 1,
          params = {},
          _populateUnitsFrom = { x = 5476, z = 2988, r = 400, into = 'targetUnitID',
                                 defs = { 'ms_radar_s2' }, team = 0 },
          reward = 150,
          expiresAtFrame = nil },

        -- The compact hunts the hull that is the union's way home. Killing it
        -- does not end the war; it takes withdrawal off the table, which is
        -- §3.4's whole point.
        { type = 'kill', scope = 'tactical', forTeam = 0,
          params = {},
          _populateUnitsFrom = { x = 9300, z = 4400, r = 400, into = 'targetUnitID',
                                 defs = { 'ms_landing_ship' }, team = 1 },
          reward = 150,
          expiresAtFrame = nil },
    },

    -- Top-level `orders` is warned-and-ignored by the loader; opening orders
    -- belong in the per-unit `orders` field above, and that is where they are.
    orders = {},
}
