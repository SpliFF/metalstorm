-- gamedata/footprints.lua — authored footprint profiles (PLAN-metalstorm-flow.md §1).
--
-- One authored source, two derived representations (§1). The SIM derives a hull
-- mask + per-move-class permeability (who may flow UNDER a big unit's hull, and
-- at what cost); the CLIENT derives animated ground-contact patches (feet plant
-- on gait phase, track strips always contact) that smaller squad members thread
-- around and under. Sim and client can never disagree because both hang off the
-- same profile.
--
-- A unit opts in via customparams.footprint_profile = '<key into this table>'
-- (authored in units/_builder.lua for scale 3–4 units + buildings). The engine
-- parses this file at startup (flow engine ask F1): every profile is resolved
-- (underpass move-class NAMES → MoveDef pathTypes) and attached to each opting
-- UnitDef, then exported to the client alongside the unit defs.
--
-- Schema (authoritative — replaces the earlier inconsistent stub shape):
--   <key> = {
--       hull      = { x = <elmos>, z = <elmos> },  -- outer sim footprint, axis-aligned in unit space
--       clearance = <elmos>,                        -- ground clearance of the hull between contacts
--       underpass = { '<moveclass>', ... },         -- move classes permitted underneath (moveinfo names)
--       contacts  = {                               -- ground-contact elements, unit-local space
--           -- foot: a planted disc, plants on its gait window
--           { kind = 'foot',  x =, z =, r =, gait = { phase =, duty = } },
--           -- track: a strip, always in contact (no gait); underpass = "between the tracks"
--           { kind = 'track', x =, z =, halfWidth =, halfLength = },
--       },
--   }
--
-- underpass semantics (sim, PLAN-metalstorm-flow §3): a permitted class sees the
-- hull as passable-with-cost while the big unit is moving or stopped, and BLOCKED
-- only during its turn-in-place (rotation sweeps the contacts unpredictably). A
-- non-permitted class always sees the hull as solid. Buildings (no gait) are
-- solid with no underpass — they simply omit an `underpass` list.

return {
    -- Scale-3 quad walker (the §1 reference profile). Four feet on a duty cycle;
    -- infantry may thread between the planted legs.
    quad_walker_l = {
        hull      = { x = 96, z = 128 },
        clearance = 18,
        underpass = { 'INFANTRY' },
        contacts  = {
            { kind = 'foot', x = -40, z =  48, r = 12, gait = { phase = 0.00, duty = 0.62 } },
            { kind = 'foot', x =  40, z =  48, r = 12, gait = { phase = 0.50, duty = 0.62 } },
            { kind = 'foot', x = -40, z = -48, r = 12, gait = { phase = 0.25, duty = 0.62 } },
            { kind = 'foot', x =  40, z = -48, r = 12, gait = { phase = 0.75, duty = 0.62 } },
        },
    },

    -- Tracked heavy: twin track strips, always in contact. underpass = infantry
    -- passing BETWEEN the tracks (the gap down the hull centreline).
    heavy_tracks = {
        hull      = { x = 72, z = 104 },
        clearance = 10,
        underpass = { 'INFANTRY' },
        contacts  = {
            { kind = 'track', x = -28, z = 0, halfWidth = 10, halfLength = 52 },
            { kind = 'track', x =  28, z = 0, halfWidth = 10, halfLength = 52 },
        },
    },

    -- Scale-4 super-heavy: bigger hull, six feet, no underpass — nothing flows
    -- under a dreadnought (it is solid to every class; the flow field routes
    -- following traffic around it). Left here as the "solid big footprint" case.
    dreadnought = {
        hull      = { x = 160, z = 224 },
        clearance = 26,
        underpass = {},
        contacts  = {
            { kind = 'foot', x = -60, z =  80, r = 18, gait = { phase = 0.00, duty = 0.66 } },
            { kind = 'foot', x =  60, z =  80, r = 18, gait = { phase = 0.50, duty = 0.66 } },
            { kind = 'foot', x = -60, z =   0, r = 18, gait = { phase = 0.33, duty = 0.66 } },
            { kind = 'foot', x =  60, z =   0, r = 18, gait = { phase = 0.83, duty = 0.66 } },
            { kind = 'foot', x = -60, z = -80, r = 18, gait = { phase = 0.66, duty = 0.66 } },
            { kind = 'foot', x =  60, z = -80, r = 18, gait = { phase = 0.16, duty = 0.66 } },
        },
    },
}
