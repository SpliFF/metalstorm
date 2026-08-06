-- Recon vehicles — mobile eyes (PLAN-metalstorm-model-integration §M1).
-- Unarmed: they buy sight and radar, not damage. Distinct from units/radar.lua,
-- which is the immobile sensor-building class.
--
-- Hand-written (not units/_builder.lua): one-off vehicles wired to ONE shipped
-- forge model each, not a 4-scale class curve. Shape follows fable_tank.lua.
-- Provenance: the Generated rows in ../ASSETS.md.

return {
    -- Open-frame buggy: body / axle_f / axle_r / dish, clip idle (±60° dish
    -- sweep, 8 s). Axles spin off wire speed (wheel-spin-driver.ts).
    ms_scout_buggy = {
        name = 'Scout Buggy',
        description = 'Light scout — fast, unarmed, pintle sensor pod',
        objectname = 'ms_scout_buggy',
        category = 'LAND MOBILE VEHICLE',
        movementclass = 'VEH',
        maxdamage = 240, mass = 120,
        maxvelocity = 4.2, acceleration = 0.36, brakerate = 0.3, turnrate = 1100,
        footprintx = 2, footprintz = 2,
        sightdistance = 700,
        radardistance = 1200,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        canguard = true,
        customparams = {
            ms_class = 'scout', squad_size = '1',
            authority_cost_base = '1',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },

    -- Tethered aerostat on a winch trailer: body / wheel1 / wheel2 / cable /
    -- envelope (gondola at ~22 m, envelope top 26.4 m), clip idle (conical
    -- tether sway + envelope bob). A GROUND unit — the balloon is model
    -- geometry, not flight; canfly stays unset so it paths as a slow trailer.
    --
    -- DEVIATION (M1, 2026-08-06): the engine radius is computed over every
    -- piece (Unit.cpp SetRadiusAndHeight ← model->radius), so the envelope
    -- 26 m overhead gives this def a 14.1-elmo radius against a ~4-elmo
    -- trailer. Only `collisionVolume*` is def-overridable (SolidObjectDef.cpp);
    -- `radius` itself is not, so combat/targeting still sees the balloon.
    -- Left as-is until the §12 metre→elmo render scale is settled — the
    -- inflated radius is dwarfed by the footprint either way.
    ms_obs_balloon = {
        name = 'Observation Balloon',
        description = 'Tethered aerostat on a winch trailer — long sight, no guns',
        objectname = 'ms_obs_balloon',
        category = 'LAND MOBILE VEHICLE',
        movementclass = 'VEH',
        maxdamage = 300, mass = 260,
        maxvelocity = 1.4, acceleration = 0.1, brakerate = 0.14, turnrate = 300,
        footprintx = 2, footprintz = 3,
        sightdistance = 1600,
        radardistance = 2200,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        canguard = true,
        customparams = {
            ms_class = 'balloon', squad_size = '1',
            authority_cost_base = '2',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },
}
