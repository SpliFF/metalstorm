-- Support buildings — the staging-post kit (PLAN-metalstorm-model-integration §M2).
--
-- The small/medium military and infrastructure structures a force plants when
-- it holds ground: command post, lookout, relay, workshop, dump, waterworks,
-- rail/water terminals, airship mast, perimeter. Distinct from
-- units/buildings_military.lua, which is the five big FACTORY-class
-- structures (nexus/foundry/garrison/airbase/shipyard) — those are campaign
-- commitments, these are what a column puts up in an afternoon, so buildtimes
-- here are minutes rather than hours.
--
-- Hand-written (not units/_builder.lua): one-off structures wired to ONE
-- shipped forge model each, not a 4-scale class curve. Shape follows
-- units/buildings_military.lua. Provenance: the Generated rows in ../ASSETS.md.
--
-- FOOTPRINTS are derived from the shipped glTF bounds under the authored
-- convention `footprint metres = footprintx * 2` (DESIGN-MODEL-BUILDING.md §4),
-- rounded to the nearest square; elevated overhang (a crane jib, a mast head)
-- is deliberately NOT covered — only ground contact is. The separate §12
-- metre→elmo render-scale question (models draw 1 unit = 1 elmo while a
-- footprint square is 16 elmos) is unresolved upstream and is not settled here;
-- following the authored convention keeps these defs consistent with every
-- existing building def, which is what matters for this step.
--
-- Natives are SCRIPT-LESS: no sim-side unit script turns a piece. The authored
-- `idle` clips (flag wave, searchlight sweep, dish spin, crane bob…) play
-- CLIENT-side — see client/src/core/clip-auto-policy.ts, which since §M2
-- engages an idle cycle for immobile units that can never trip the
-- movement-driven start.
local function building(t)
    t.category   = t.category or 'LAND BUILDING'
    t.isbuilding = true
    t.canmove    = false
    t.maxvelocity = 0          -- immobile units MUST be speed 0 (see _builder.lua)
    t.canattack  = t.canattack or false
    t.canstop    = true
    t.customparams = t.customparams or {}
    t.customparams.ms_class = t.customparams.ms_class or 'buildings'
    t.customparams.building_family = 'support'
    t.customparams.generator = 'Claude Fable 5 (tools/forge)'
    return t
end

return {
    -- 12x8 m prefab hall + rooftop command module, antenna mast to 7.6 m,
    -- sandbag skirt. Pieces body + flag; `idle` waves the flag.
    ms_command_post = building{
        name = 'Command Post',
        description = 'Forward command prefab — antenna mast, sandbag skirt',
        objectname = 'ms_command_post',
        maxdamage = 4000, mass = 6000,
        footprintx = 6, footprintz = 4,
        sightdistance = 700,
        radardistance = 900,
        buildtime = 60000,             -- ~10 min at workertime 100
    },

    -- 10 m guard tower on braced legs; enclosed cab, searchlight. Pieces
    -- body + light; `idle` sweeps the searchlight ±55° over 12 s (emissive
    -- lens — one of the §M2 night-lighting checks).
    ms_watchtower = building{
        name = 'Watchtower',
        description = 'Guard tower — braced legs, sweeping searchlight',
        objectname = 'ms_watchtower',
        maxdamage = 1500, mass = 1200,
        footprintx = 2, footprintz = 2,
        sightdistance = 950,           -- the whole point of it
        buildtime = 20000,             -- ~3 min
    },

    -- Guyed relay mast with a steerable dish. Pieces body + dish; `idle`
    -- rotates the dish.
    ms_comms_relay = building{
        name = 'Comms Relay',
        description = 'Guyed relay mast — steerable dish, long radar reach',
        objectname = 'ms_comms_relay',
        maxdamage = 1200, mass = 1500,
        footprintx = 3, footprintz = 3,
        sightdistance = 350,
        radardistance = 2400,
        buildtime = 30000,
    },

    -- Open-sided repair shed with a gantry. Pieces body + crane; `idle` runs
    -- the gantry. Repairs and assists — it has NO buildoptions on purpose:
    -- a workshop maintains what the factories make, it does not make units.
    ms_field_workshop = building{
        name = 'Field Workshop',
        description = 'Repair shed — travelling gantry, no production line',
        objectname = 'ms_field_workshop',
        maxdamage = 5000, mass = 9000,
        footprintx = 7, footprintz = 5,
        sightdistance = 350,
        buildtime = 90000,
        builder = true, canbeassisted = true,
        workertime = 80, builddistance = 300,
        canrepair = true, canreclaim = true, canassist = true,
    },

    -- Low crate/drum/fuel stack under tarpaulins. Pieces body + tarp; `idle`
    -- ripples the tarp. Only 1.6 m tall — the flattest thing in the roster.
    ms_supply_dump = building{
        name = 'Supply Dump',
        description = 'Open supply stack — crates, drums, tarpaulins',
        objectname = 'ms_supply_dump',
        maxdamage = 2000, mass = 3000,
        footprintx = 5, footprintz = 5,
        sightdistance = 250,
        buildtime = 30000,
    },

    -- Tower + settling tanks + pump house to 16 m. Pieces body + pump;
    -- `idle` works the pump. A civilian-utility POI the town planner (§T2)
    -- places, but authored military-family: an army holds the water.
    ms_water_works = building{
        name = 'Water Works',
        description = 'Water tower and pump house — the district drinks here',
        objectname = 'ms_water_works',
        maxdamage = 6000, mass = 14000,
        footprintx = 11, footprintz = 8,
        sightdistance = 250,
        buildtime = 120000,            -- ~20 min
    },

    -- 24 x 12 m platform + single track spur matched to the fable_train gauge.
    -- Pieces body / crane / hook / berth (empty, the train-alignment mount);
    -- `idle` yaws the loading crane and bobs the hook.
    --
    -- YARDMAP: the slab fills x -6..0 and the BALLAST/TRACK fills x 0..6
    -- (ms_rail_platform_layout.py). Blocking the track would wall off the rail
    -- lane the platform exists to serve, so the three track columns are 'u'
    -- (walkable, not buildable) and only the buffer-stop row at the +Z end is
    -- closed. Row 0 is z-minimum, column 0 is x-minimum
    -- (SolidObject.cpp GetGroundBlockingMaskAtPos: blockMap[bx + by*footprint.x],
    -- both indices increasing with world axis at facing 0).
    ms_rail_platform = building{
        name = 'Rail Platform',
        description = 'Rail terminus — canopied platform, loading crane, spur',
        objectname = 'ms_rail_platform',
        maxdamage = 5000, mass = 12000,
        footprintx = 6, footprintz = 12,
        yardmap = string.rep('ooouuu ', 11) .. 'oooooo',
        sightdistance = 400,
        buildtime = 100000,
        levelground = true,
        customparams = { footprint_profile = 'rail_platform_deck' },
    },

    -- 40 m floating jetty running from open water (-Z) to the shore ramp (+Z).
    -- Pieces body / crane / berth (empty) / shore (empty); `idle` works the
    -- jib. Footprint covers z -20..20; the shore ramp overhangs the +Z end by
    -- ~5 m, which lands on the bank where nothing needs to path.
    ms_pontoon_wharf = building{
        name = 'Pontoon Wharf',
        description = 'Floating jetty — pontoon deck, shore ramp, jib crane',
        objectname = 'ms_pontoon_wharf',
        maxdamage = 3500, mass = 8000,
        footprintx = 4, footprintz = 20,
        sightdistance = 350,
        buildtime = 80000,
        floater = true,
        customparams = { footprint_profile = 'pontoon_wharf_deck' },
    },

    -- 19 m airship mooring mast. Pieces body / head / beacon / dock (empty);
    -- `idle` turns the mooring head. The beacon is emissive (night check).
    ms_mooring_mast = building{
        name = 'Mooring Mast',
        description = 'Airship mast — rotating mooring head, hazard beacon',
        objectname = 'ms_mooring_mast',
        maxdamage = 2500, mass = 4000,
        footprintx = 5, footprintz = 5,
        sightdistance = 600,
        buildtime = 50000,
    },

    -- Perimeter kit: 8 m scrap-plate wall, 90° corner, 8 m gateway with an
    -- animated leaf (clip `open`, non-looping — NOT an idle, so the client
    -- idle policy leaves it in its rest pose, closed).
    --
    -- DEVIATION (§M2, 2026-08-06): the shipped model is a KIT SHEET, not an
    -- assembled fortification — ms_barricade_set_layout.py fans the three root
    -- pieces out along X (corner at -10, wall at 0, gate_frame at +10) "purely
    -- so pieces don't z-fight when the whole model renders", and tells
    -- integrators placing single pieces to zero the root offset. The client has
    -- no per-piece visibility channel (same gap that landed ms_expedition_rig's
    -- §M1 deviation), so this def necessarily renders all three elements at
    -- once as one 25 m run: corner, wall, gateway, left to right. That reads as
    -- a coherent perimeter segment and blocks correctly, but town-planner §T3
    -- (wall runs, corners at corners, gate on the main street) needs the
    -- elements placeable INDIVIDUALLY. That needs either a piece-visibility
    -- channel next to the clip/aim/wheel pose maps, or three regenerated forge
    -- models with the root offset zeroed (the layout file's own instruction —
    -- tools/forge/samples/ms_barricade_set/). §T3 is gated on one of the two.
    ms_barricade_set = building{
        name = 'Barricade Set',
        description = 'Perimeter kit — scrap-plate wall, corner, gateway',
        objectname = 'ms_barricade_set',
        -- Fortification walls are meant to SOAK fire (BAR walls are the
        -- toughest-per-footprint things in that roster): 6000 puts the 25 m
        -- run above the meeting hall but below the factories.
        maxdamage = 6000, mass = 6000,
        footprintx = 13, footprintz = 3,
        sightdistance = 150,
        buildtime = 24000,
    },
}
