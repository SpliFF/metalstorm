-- Resource sites — capturable industry (PLAN-metalstorm-model-integration §M2,
-- PLAN-metalstorm-worldbuilding.md decision 3).
--
-- Silos, derricks, tank farms, timber yards, mine headframes and quay cranes.
-- These are PRE-PLACED, not built: scenariogen's named-site layer drops them
-- and gives each a narrative label ("the Weatherall silos"), and they start on
-- the Gaia team. Taking one is a CAPTURE (engine CMD_CAPTURE — a builder with
-- canCapture walks up and flips it), not a build order, so none of these appear
-- in any factory's buildoptions.
--
-- INCOME STAYS AUTHORITY (worldbuilding decision 3). A captured derrick pays
-- nothing into a metal/energy economy that Metalstorm does not run; the site is
-- worth holding because it is an objective anchor, a region-presence weight and
-- a place the story points at. So: no metalMake / extractsMetal / storage here.
-- `customparams.site_kind` is the key scenariogen labels against.
--
-- Hand-written one-off defs wired to ONE shipped forge model each. Footprints
-- are the GROUND CONTACT derived from the shipped glTF bounds under the
-- authored `footprint metres = footprintx * 2` convention
-- (DESIGN-MODEL-BUILDING.md §4); elevated overhang is deliberately not covered
-- — see ms_port_crane below for the case where that matters most.
--
-- Natives are SCRIPT-LESS: the pumpjack beam, headframe wheel, crane trolley,
-- silo belt, saw blade and tank vent all move from authored `idle` clips played
-- CLIENT-side (client/src/core/clip-auto-policy.ts).
local function site(t)
    t.category   = 'LAND BUILDING SITE'
    t.isbuilding = true
    t.canmove    = false
    t.maxvelocity = 0          -- immobile units MUST be speed 0 (see _builder.lua)
    t.canattack  = false
    t.canstop    = true
    -- Explicit even though the engine defaults it true (UnitDef.cpp:359):
    -- being takeable is the entire point of this family, so it should not be
    -- silently inherited.
    t.capturable = true
    t.customparams = t.customparams or {}
    t.customparams.ms_class = 'sites'
    t.customparams.building_family = 'site'
    t.customparams.gaia_site = '1'
    t.customparams.generator = 'Claude Fable 5 (tools/forge)'
    return t
end

return {
    -- 27 x 16.5 m grain terminal, headhouse to 15 m. Pieces body / belt /
    -- loadout (empty); `idle` runs the conveyor belt.
    ms_grain_silo = site{
        name = 'Grain Silo',
        description = 'Grain terminal — cell silos, conveyor gallery, loadout',
        objectname = 'ms_grain_silo',
        maxdamage = 4000, mass = 12000,
        footprintx = 14, footprintz = 8,
        sightdistance = 250,
        buildtime = 140000,
        customparams = { site_kind = 'grain' },
    },

    -- 18 m derrick over a pumpjack. Pieces body + beam; `idle` rocks the
    -- walking beam — one of the three §M2 browser animation checks.
    ms_oil_derrick = site{
        name = 'Oil Derrick',
        description = 'Wellhead derrick — nodding pumpjack, gathering lines',
        objectname = 'ms_oil_derrick',
        maxdamage = 3000, mass = 8000,
        footprintx = 7, footprintz = 5,
        sightdistance = 300,
        buildtime = 110000,
        customparams = { site_kind = 'oil' },
    },

    -- Three 8 m tanks in a bunded 32 x 17 m pad; export line runs -Z toward a
    -- paired derrick. Pieces body / vent / fumes (empty FX mount); `idle`
    -- turns the roof vent turbine.
    ms_tank_farm = site{
        name = 'Tank Farm',
        description = 'Bunded fuel storage — three tanks, export header',
        objectname = 'ms_tank_farm',
        maxdamage = 5000, mass = 15000,
        footprintx = 16, footprintz = 8,
        sightdistance = 250,
        buildtime = 130000,
        customparams = { site_kind = 'fuel', footprint_profile = 'tank_farm_pad' },
    },

    -- Log stacks, saw shed, log crane. Pieces body + blade; `idle` spins the
    -- circular blade at 0.9 s/rev — the fastest idle in the roster and the
    -- clearest browser check that building clips actually run.
    ms_timber_yard = site{
        name = 'Timber Yard',
        description = 'Sawmill yard — log stacks, saw shed, loading crane',
        objectname = 'ms_timber_yard',
        maxdamage = 2500, mass = 5000,
        footprintx = 6, footprintz = 6,
        sightdistance = 250,
        buildtime = 70000,
        customparams = { site_kind = 'timber' },
    },

    -- 15 m mine headframe over an open cut. Pieces body + wheel; `idle` turns
    -- the winding wheel.
    ms_metal_pit = site{
        name = 'Metal Pit',
        description = 'Open-cut mine — winding headframe, spoil, ore bins',
        objectname = 'ms_metal_pit',
        maxdamage = 3500, mass = 9000,
        footprintx = 7, footprintz = 6,
        sightdistance = 300,
        buildtime = 120000,
        customparams = { site_kind = 'metal' },
    },

    -- 20 m rail-mounted portal crane. Pieces body + trolley; `idle` traverses
    -- the trolley along the jib.
    --
    -- FOOTPRINT: the crane's GROUND contact is only its rail deck — two rails
    -- at z = ±3 spanning x -7.5..7.5, with the legs on bogies riding them
    -- (ms_port_crane_layout.py). The box-girder jib reaches to z = -13 and the
    -- machinery house sits at y 14.6..16.5; both are 15+ m in the air over the
    -- water a ship moors in. So the footprint is the 16 x 8 m rail deck and the
    -- jib OVERHANGS, rather than an 16 x 18 m block that would wall off the
    -- berth the crane exists to serve. "Overhang is fine"
    -- (DESIGN-MODEL-BUILDING.md §4) is doing real work here.
    ms_port_crane = site{
        name = 'Port Crane',
        description = 'Quayside portal crane — rail bogies, jib over the berth',
        objectname = 'ms_port_crane',
        maxdamage = 3000, mass = 10000,
        footprintx = 8, footprintz = 4,
        sightdistance = 350,
        buildtime = 120000,
        customparams = { site_kind = 'port', footprint_profile = 'port_crane_rails' },
    },
}
