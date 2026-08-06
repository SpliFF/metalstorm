-- Civilian buildings (PLAN-metalstorm.md §7–8).
-- Mostly pre-placed by maps/scenarios; objective fodder (protect / capture /
-- keep-running). Owned by the environment (gaia) team in the common case.
local function civbuilding(t)
    t.category   = 'LAND BUILDING CIVILIAN'
    t.isbuilding = true
    t.canmove    = false
    t.canattack  = false
    t.customparams = t.customparams or {}
    t.customparams.ms_class = 'buildings'
    t.customparams.building_family = 'civilian'
    t.customparams.civilian = '1'
    return t
end

return {
    ms_habitat = civbuilding{
        name = 'Habitat Block',
        description = 'Civilian housing — population centre',
        objectname = 'ms_habitat',
        maxdamage = 8000, mass = 15000,
        footprintx = 12, footprintz = 12,
        sightdistance = 200,
        buildtime = 600000,
    },
    ms_transit_hub = civbuilding{
        name = 'Transit Hub',
        description = 'Civilian transport node — keeps a district connected',
        objectname = 'ms_transit_hub',
        maxdamage = 6000, mass = 10000,
        footprintx = 10, footprintz = 14,
        sightdistance = 250,
        buildtime = 420000,
    },
    ms_depot = civbuilding{
        name = 'Supply Depot',
        description = 'Civilian logistics store — convoy origin/destination',
        objectname = 'ms_depot',
        maxdamage = 7000, mass = 12000,
        footprintx = 10, footprintz = 10,
        sightdistance = 220,
        buildtime = 360000,
    },

    -- ── §M2 forge models (PLAN-metalstorm-model-integration) ──────────────
    -- The town roster the town-planner lane (§T2) fills lots from: one unique
    -- meeting hall per town, shanty blocks in bulk, market stalls as a POI.
    -- Footprints derive from the shipped glTF bounds under the authored
    -- `footprint metres = footprintx * 2` convention (DESIGN-MODEL-BUILDING §4).
    --
    -- All three carry an authored `idle` clip (bell sway / laundry line /
    -- awning flap) that plays CLIENT-side — natives are script-less, see
    -- client/src/core/clip-auto-policy.ts.
    --
    -- ESTATE: these register with the civilian estate at creation, not from a
    -- def flag read at query time — game_civilians.lua's UnitCreated hands any
    -- unit whose def carries `civilian = '1'` to civilians/estate.lua, whose
    -- registry stays the source of truth for role/site/venue (the reason
    -- GG.Civilians.IsCivilian reads the registry and not a customParam).

    -- 18.9 x 13.4 m gabled hall with a porch, noticeboard and bell tower.
    -- Pieces body + bell; `idle` sways the bell (4.0 s, seamless).
    -- THE PARLEY VENUE (PLAN-metalstorm-worldbuilding §4): exactly one per
    -- town, and the estate reports it via GG.Civilians.ParleyVenue().
    ms_meeting_hall = civbuilding{
        name = 'Meeting Hall',
        description = 'Civilian meeting hall — the town parleys here',
        objectname = 'ms_meeting_hall',
        maxdamage = 4000, mass = 7000,
        footprintx = 9, footprintz = 7,
        sightdistance = 260,
        buildtime = 240000,
        customparams = {
            civ_role = 'venue',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },

    -- 16 x 16 m stacked corrugated housing with a strung laundry line.
    -- Pieces body + line; `idle` drifts the line.
    ms_shanty_block = civbuilding{
        name = 'Shanty Block',
        description = 'Stacked civilian housing — corrugated, improvised, lived-in',
        objectname = 'ms_shanty_block',
        maxdamage = 2200, mass = 4000,
        footprintx = 8, footprintz = 8,
        sightdistance = 180,
        buildtime = 90000,
        customparams = {
            civ_role = 'housing',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },

    -- 8 x 8 m market plaza: five timber stalls, hanging goods, warm string
    -- lights (emissive — one of the §M2 night-lighting checks). Pieces body +
    -- awning; `idle` flaps the five canvases.
    ms_market_stalls = civbuilding{
        name = 'Market Stalls',
        description = 'Civilian market — timber stalls under strung lights',
        objectname = 'ms_market_stalls',
        maxdamage = 900, mass = 1200,
        footprintx = 4, footprintz = 4,
        sightdistance = 160,
        buildtime = 40000,
        customparams = {
            civ_role = 'market',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },
}
