-- Irregulars — improvised militia vehicles (PLAN-metalstorm-model-integration
-- §M1). Scrap-built, cheap, fast, thin-skinned: the Anarchic signature
-- (PLAN-metalstorm-worldbuilding §4) rather than a faction's line armour.
--
-- Hand-written (not units/_builder.lua): these are one-off vehicles wired to
-- ONE shipped forge model each, not a 4-scale class curve. Shape follows
-- units/fable_tank.lua.
--
-- Model: models/ms_technical.gltf — pieces body / turret / barrel / muzzle /
-- axle_f / axle_r / flag, clips idle (pennant sway) + walk (axle spin),
-- forward -Z, 1 unit = 1 m. The turret chain gets cosmetic aim for free
-- (turret-aim-controller.ts) and the axles spin off wire speed
-- (wheel-spin-driver.ts) — no sim-side unit script, natives are script-less.
-- Licensing/provenance: the Generated rows in ../ASSETS.md.

return {
    ms_technical = {
        name = 'Technical',
        description = 'Anarchic gun truck — bed-mounted scrap autocannon',
        objectname = 'ms_technical',
        category = 'LAND MOBILE VEHICLE',
        movementclass = 'VEH',
        maxdamage = 320, mass = 180,
        maxvelocity = 3.4, acceleration = 0.3, brakerate = 0.28, turnrate = 900,
        footprintx = 2, footprintz = 3,
        sightdistance = 420,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = { [1] = { name = 'MS_AC_TECHNICAL' } },
        customparams = {
            ms_class = 'technical',
            -- Single model, not a squad: the squad fan-out renders MEMBERS
            -- instead of the unit mesh, and the member path carries neither
            -- the cosmetic turret aim nor the axle spin. Every M1 def is
            -- squad_size 1 for that reason (M1 note, 2026-08-06).
            squad_size = '1',
            authority_cost_base = '1',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },
}
