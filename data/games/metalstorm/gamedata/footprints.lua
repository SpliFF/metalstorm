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
    -- NOTE (unit props review 2026-08-20): the three MOBILE profiles below
    -- (quad_walker_l, heavy_tracks, dreadnought) are referenced by NO unit —
    -- only the four building profiles at the bottom are wired up via
    -- customparams.footprint_profile. Proposed attachments (units files, see
    -- .unitprops/agent-systems.md): mechs s3 -> quad_walker_l,
    -- tanks s3 -> heavy_tracks, mechs s4 / fable_colossus -> dreadnought.

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

    -- ====================================================================
    -- BUILDING profiles (PLAN-metalstorm-model-integration §M2)
    --
    -- READ THIS BEFORE TRUSTING THESE FOR BLOCKING. What actually blocks a
    -- building today is `footprintx/footprintz` (+ `yardmap`), NOT this file:
    -- CMoveMath::ObjectBlockType returns at its `collidee->immobile` early-out
    -- (rts/Sim/MoveTypes/MoveMath/MoveMath.cpp:303) BEFORE it reaches the
    -- footprint-profile branch (:319), so the sim never consults a profile for
    -- an immobile object. Buildings are solid to every move class, full stop.
    --
    -- That is also the RIGHT answer for this roster: every "you should be able
    -- to move through/under that" case here is already solved correctly by the
    -- footprint itself — the port crane's jib overhangs its rail-deck footprint
    -- rather than blocking the berth, and the rail platform opens its track
    -- columns with a 'u' yardmap. Nothing in §M2 wants a building to be
    -- selectively permeable, so no profile below declares an `underpass` list
    -- (per this file's own schema note: buildings omit it and are solid).
    --
    -- What these four DO carry is the authored ground-CONTACT geometry — the
    -- profile's other half, which the client derives its ground-contact patches
    -- from (see FootprintProfile.h's header). That consumer has not landed
    -- (nothing under client/src/ reads the profile yet), so these are authored
    -- reference for it, wired up via `customparams.footprint_profile` so they
    -- attach the moment either side starts reading them. Contacts are `track`
    -- strips because a building has no gait: halfWidth is the X half-extent,
    -- halfLength the Z half-extent, both in elmos (1 authored metre = 8 elmos,
    -- matching `footprint metres = footprintx * 2` against 16-elmo squares).
    -- ====================================================================

    -- ms_tank_farm — a 32.4 x 16.8 m concrete pad inside a bund wall. One
    -- unbroken slab: hull and contact are the same rectangle.
    tank_farm_pad = {
        hull      = { x = 256, z = 128 },
        clearance = 0,
        contacts  = {
            { kind = 'track', x = 0, z = 0, halfWidth = 128, halfLength = 64 },
        },
    },

    -- ms_rail_platform — two distinct ground surfaces, which is exactly what
    -- the def's yardmap encodes: the platform slab fills x -6..0 m (blocked)
    -- and the track ballast fills x 0..6 m (walkable, 'u'). Both are real
    -- ground contact; only one is solid.
    rail_platform_deck = {
        hull      = { x = 96, z = 192 },
        clearance = 0,
        contacts  = {
            { kind = 'track', x = -24, z = 0, halfWidth = 24, halfLength = 96 },  -- platform slab
            { kind = 'track', x =  24, z = 0, halfWidth = 24, halfLength = 96 },  -- ballast + rails
        },
    },

    -- ms_pontoon_wharf — a 7.4 m wide floating deck running 40 m from open
    -- water (-Z) to the shore ramp (+Z). Clearance is the deck's freeboard
    -- above the waterline, not ground.
    pontoon_wharf_deck = {
        hull      = { x = 64, z = 320 },
        clearance = 4,
        contacts  = {
            { kind = 'track', x = 0, z = 0, halfWidth = 32, halfLength = 160 },
        },
    },

    -- ms_port_crane — the ONLY ground contact is the two rails the portal legs
    -- ride on: 15 m long along X at z = ±3 m, 0.4 m wide
    -- (ms_port_crane_layout.py RAIL_Z/RAIL_LEN/RAIL_W). Everything else — jib,
    -- machinery house, cab — is 12+ m in the air, which is why the def's
    -- footprint is the 16 x 8 m rail deck and not the model's 16 x 18 m bounds.
    port_crane_rails = {
        hull      = { x = 128, z = 64 },
        clearance = 0,
        contacts  = {
            { kind = 'track', x = 0, z = -24, halfWidth = 60, halfLength = 2 },
            { kind = 'track', x = 0, z =  24, halfWidth = 60, halfLength = 2 },
        },
    },
}
