-- scenarios/pelagic_counterlanding.lua — "Raven Watch — The Counter-Landing".
--
-- The mirror of scenarios/pelagic_landing.lua: same map, same prize, roles
-- flipped. The Union is the garrison holding Hollow Dell; the Compact is the
-- expedition that sailed from Storm Moor and came ashore on Quarry Bluff, on
-- the far side of the crossroads.
--
-- WHY A PAIR RATHER THAN A SECOND WAR. The Landing only ever exercises the
-- transport machinery in ONE direction across ONE stretch of coast. A pair
-- that flips who is ashore and who is arriving is what makes the arrival path
-- content rather than a demo: two different sea lanes, two different beaches,
-- two different defenders, on one heightmap that has already been measured.
-- Read pelagic_landing.lua first — its header carries the map facts (declared
-- split, INFANTRY/VEH connected across THIS theatre, HEAVY not connected at
-- all, so no HEAVY def is staged here either) and they are not repeated.
--
-- FILE-SCOPE NOTE: pure table literal, no VFS / Spring.* / require — see the
-- same note in pelagic_landing.lua and crossing_standoff.lua. A computed
-- global here does not fail loudly, it makes the war vanish from the lobby's
-- Create Game list.

return {
    version   = 1,
    name      = 'Raven Watch — The Counter-Landing',
    tutorial  = false,
    ephemeral = false,

    world = {
        map = 'pelagic_expanse',
        -- Only the garrison owns anything at the open. The Compact owns no
        -- region on this island: it does not live here, it landed here this
        -- morning, and Quarry Bluff under its feet is an OPEN tactical race
        -- below rather than a gift.
        regions = {
            { key = 'hollow_dell', team = 1 },
        },
    },

    -- The flag is on the other side this time. Only the Compact is
    -- `expeditionary` — it arrived by transport and can be trapped ashore, so
    -- `ms_stranded_0` and the `war_side_stranded` guard mean something for it.
    -- The Union is standing in its own dell and carries neither the flag nor a
    -- departure zone.
    --
    -- The Compact's `departure` (7196, 3132) is 33 elmos deep, is in the same
    -- ship-navigable body of water as its entry lane, and sits 953 elmos from
    -- its own parked landing ship — far enough that the frame-60 departure
    -- poll does not swallow the carrier where it is moored.
    sides = {
        { faction = 'compact', team = 0, expeditionary = true,
          departure = { x = 7196, z = 3132, radius = 450 } },
        { faction = 'union',   team = 1 },
    },

    briefing = {
        title    = 'The Counter-Landing',
        subtitle = 'Pelagic Expanse',
        story    = [[Hollow Dell is the Union's now. They took it from the sea and they have had time to dig.

So the Compact did the same thing from the other direction. The expedition sailed from Storm Moor overnight and put its ramps down on Quarry Bluff, on the blind side of the island, where the bluff is too steep for anything heavier than a rifle section to be waiting.

Between the two beachheads sits Raven Watch, the same crossroads, the same three unbroken minutes. This time you are the one walking uphill.]],
        tips     = {
            'You landed on a BLUFF, not a beach. Quarry Bluff is steep enough that it carries no buildings and no heavy armour — spread out and get off it before the Union artillery ranges you.',
            'Victory is the same: hold Raven Watch for 3 unbroken minutes, earliest decision at the 3-minute mark, and a contested crossroads resets the clock.',
            'The Union garrison is not going anywhere. Its static defence covers the mouth of the dell; its radar sees your waves coming. Kill the mast and the second wave lands unannounced.',
            'Your landing ship is your way home and it is moored off the bluff. The Union is scored on sinking it.',
            'The Union relief convoy comes by sea from the east at the 3-minute mark, into the same Hollow Dell anchorage the first invasion used.',
            'The air lane puts a section down on South Shelf, between the bluff and the crossroads — the only way to be above Raven Watch before the Union is.',
        },
        parTimeSec = 900,
    },

    units = {
        -- ============== COMPACT (team 0) — the Quarry Bluff beachhead =====
        -- Staged as arrived (§3.2). The bluff's usable ground is a 250-elmo
        -- shelf, so the spreads are tight for the same reason the Landing's
        -- beach spreads are: `count`/`spacing` centres its grid on the point.
        { def = 'ms_soldiers_s1', team = 0, x = 6660, z = 4110, facing = 'east', count = 4, spacing = 110,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_soldiers_s2', team = 0, x = 6700, z = 4240, facing = 'east', count = 2, spacing = 120,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_tanks_s2', team = 0, x = 6660, z = 4160, facing = 'east', count = 3, spacing = 100,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_artillery_s2', team = 0, x = 6640, z = 4180, facing = 'east', count = 2, spacing = 130,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_engineers_s1', team = 0, x = 6620, z = 4100, facing = 'east', count = 2, spacing = 110 },
        { def = 'ms_radar_s1', team = 0, x = 6720, z = 4160, facing = 'east' },
        -- Moored off the bluff in 27 elmos of water, where the first wave also
        -- drops: the hull the expedition came in, and the Union's `kill`.
        { def = 'ms_landing_ship', team = 0, x = 6572, z = 3852, facing = 'east' },
        { def = 'fable_airship', team = 0, x = 6650, z = 4200, facing = 'east' },

        -- ============== UNION (team 1) — the Hollow Dell garrison =========
        -- A garrison, not a column: the static defence and the mouth sections
        -- carry NO order on purpose, because a garrison that walks off to the
        -- prize is not a garrison. The field force is what goes forward.
        { def = 'ms_staticdefense_s2', team = 1, x = 8700, z = 4400, facing = 'east' },
        { def = 'ms_staticdefense_s2', team = 1, x = 8660, z = 4320, facing = 'east' },
        { def = 'ms_soldiers_s1', team = 1, x = 8690, z = 4490, facing = 'east', count = 3, spacing = 110 },
        { def = 'ms_tanks_s2', team = 1, x = 8560, z = 4400, facing = 'west', count = 3, spacing = 170,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_soldiers_s2', team = 1, x = 8360, z = 4424, facing = 'west', count = 4, spacing = 120,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_artillery_s2', team = 1, x = 8232, z = 4680, facing = 'west', count = 2, spacing = 160,
          orders = { { cmd = 'FIGHT', params = { 7824, 0, 5408 } } } },
        { def = 'ms_engineers_s1', team = 1, x = 8200, z = 4776, facing = 'west', count = 2, spacing = 110 },
        -- The mast that sees the Compact's waves coming — the Compact's `kill`.
        { def = 'ms_radar_s2', team = 1, x = 8296, z = 4712, facing = 'west' },

        -- ============== HOLLOW DELL VILLAGE (Gaia) =======================
        -- The same three buildings as the Landing, on the same pocket of flat
        -- ground — it is the same village, one war later, and it still
        -- declared for nobody. Only the army camped around it changed.
        { def = 'ms_habitat',     team = 'neutral', x = 8232, z = 4616, facing = 'south' },
        { def = 'ms_transit_hub', team = 'neutral', x = 8200, z = 4872, facing = 'south' },
    },

    civilians = {
        units = {
            { def = 'ms_civilians', x = 8392, z = 4392, facing = 'north', role = 'ambient' },
            { def = 'ms_civilians', x = 8232, z = 4936, facing = 'north', role = 'ambient' },
            { def = 'ms_civilians', x = 8296, z = 4488, facing = 'north', role = 'ambient' },
        },
    },

    arrivals = {
        -- The Compact's own lane, west to east: the northern strait at
        -- (6396, 3116), 16 elmos deep, down to the Quarry Bluff anchorage at
        -- (6572, 3852), 27 deep, with the nearest dry VEH ground 175 elmos
        -- away — inside the 450-elmo sea `dropRadius` UNLOAD_UNITS is given.
        { id       = 'compact_wave_1',
          team     = 0,
          kind     = 'sea',
          def      = 'ms_landing_ship',
          eta      = 2700,
          entry    = { x = 6396, z = 3116 },
          dropZone = { x = 6572, z = 3852 },
          cargo    = { { def = 'ms_tanks_s2', count = 1 },
                       { def = 'ms_soldiers_s1', count = 2 } },
          order    = { cmd = 'FIGHT', x = 7824, z = 5408 } },

        -- South Shelf (8100, 4200) is 2 elmos of dry ground in the same
        -- INFANTRY and VEH component as both beachheads, halfway to the
        -- crossroads. An air drop zone has to suit its CARGO, not its
        -- carrier — infantry set down in open water drowns.
        { id       = 'compact_wave_2',
          team     = 0,
          kind     = 'air',
          def      = 'fable_airship',
          eta      = 4200,
          entry    = { x = 6396, z = 3116 },
          dropZone = { x = 8100, z = 4200 },
          cargo    = { { def = 'ms_soldiers_s1', count = 2 } },
          order    = { cmd = 'FIGHT', x = 7824, z = 5408 } },

        -- The garrison's relief, east to west, down the same anchorage the
        -- Landing's invasion used. Same water, other owner.
        { id       = 'union_relief',
          team     = 1,
          kind     = 'sea',
          def      = 'ms_landing_ship',
          eta      = 5400,
          entry    = { x = 9900, z = 4300 },
          dropZone = { x = 8876, z = 4252 },
          cargo    = { { def = 'ms_tanks_s2', count = 1 },
                       { def = 'ms_soldiers_s1', count = 2 } },
          order    = { cmd = 'FIGHT', x = 7824, z = 5408 } },

        { id       = 'compact_wave_3',
          team     = 0,
          kind     = 'sea',
          def      = 'ms_landing_ship',
          eta      = 8100,
          entry    = { x = 6396, z = 3116 },
          dropZone = { x = 6572, z = 3852 },
          cargo    = { { def = 'ms_soldiers_s1', count = 2 },
                       { def = 'ms_soldiers_s2', count = 2 } },
          order    = { cmd = 'FIGHT', x = 7824, z = 5408 } },
    },

    objectives = {
        -- The same prize, the same sizing, the same reasons — see
        -- pelagic_landing.lua's objective header. Exactly one victory
        -- objective; open race; `notBefore` past the slower side's approach;
        -- a contested hold resets.
        { type = 'control', scope = 'strategic', forTeam = nil,
          region = 'raven_watch', reward = 300,
          victory = true,
          notBefore = 5400, holdFrames = 5400,
          expiresAtFrame = nil },

        -- The three regions NEITHER side starts owning. Quarry Bluff is in the
        -- list precisely because the Compact is standing on it without owning
        -- it: holding the ground you landed on against a counter-attack is a
        -- real race, and it is the Union's raid target if the Compact pushes
        -- everything forward.
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'quarry_bluff', reward = 110,
          expiresAtFrame = nil },
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'south_shelf', reward = 110,
          expiresAtFrame = nil },
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'east_crossing', reward = 110,
          expiresAtFrame = nil },

        -- Only the garrison has people to protect. THE ASYMMETRY IS THE POINT
        -- and it is not an omission: an expeditionary force has no civilians
        -- on an island it landed on this morning, and inventing some for
        -- symmetry would be set dressing pretending to be a stake. The
        -- Compact's equivalent stake is its own hull, below.
        { type = 'protect', scope = 'tactical', forTeam = 1,
          params = { targetUnitIDs = {}, quorum = 1 },
          _populateTargetsFrom = { x = 8296, z = 4616, r = 700, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 18000 },

        -- The Compact hunts the mast that sees its waves coming.
        { type = 'kill', scope = 'tactical', forTeam = 0,
          params = {},
          _populateUnitsFrom = { x = 8296, z = 4712, r = 400, into = 'targetUnitID',
                                 defs = { 'ms_radar_s2' }, team = 1 },
          reward = 150,
          expiresAtFrame = nil },

        -- The Union hunts the hull that is the Compact's way home. Sinking it
        -- does not end the war; it takes withdrawal off the table.
        { type = 'kill', scope = 'tactical', forTeam = 1,
          params = {},
          _populateUnitsFrom = { x = 6572, z = 3852, r = 400, into = 'targetUnitID',
                                 defs = { 'ms_landing_ship' }, team = 0 },
          reward = 150,
          expiresAtFrame = nil },
    },

    orders = {},
}
