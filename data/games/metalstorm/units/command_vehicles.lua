-- Command vehicles — mobile HQs (PLAN-metalstorm-model-integration §M1).
-- The field counterpart of units/buildings_military.lua's command post: sight,
-- radar and presence rather than firepower.
--
-- Hand-written (not units/_builder.lua) even though the def name reads like a
-- builder product: `ms_command_s2` is the SHIPPED MODEL STEM (ASSETS.md), and
-- only that one scale has a model. If a full `command` class curve is ever
-- wanted, move this def into a mk{} call with an s2 objectname override, the
-- way units/tanks.lua carries fable_tank.
--
-- Model: models/ms_command_s2.gltf — pieces body / tracks_l / tracks_r / dish
-- / banner, clip idle (12 s dish sweep + banner sway). TURRETLESS by design,
-- so its gun gets no cosmetic aim piece and fires from the hull centre
-- (turret-aim-controller.ts needs a `turret` piece); tracked, so the axle
-- wheel-spin driver correctly skips it.
-- Provenance: the Generated rows in ../ASSETS.md.

return {
    ms_command_s2 = {
        name = 'Command Vehicle',
        description = 'Tracked mobile HQ — map table, antenna farm, sensor head',
        objectname = 'ms_command_s2',
        category = 'LAND MOBILE VEHICLE',
        movementclass = 'VEH',
        maxdamage = 900, mass = 600,
        maxvelocity = 2.2, acceleration = 0.16, brakerate = 0.2, turnrate = 480,
        footprintx = 3, footprintz = 3,
        sightdistance = 900,
        radardistance = 1800,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        -- Self-defence only, reusing the existing family (§M1: "reuse an
        -- existing MS_ gun if suitable") — a casemate pintle, not a turret.
        weapons = { [1] = { name = 'MS_MG_S2' } },
        customparams = {
            ms_class = 'command', ms_scale = '2', squad_size = '1',
            authority_cost_base = '2',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },
}
