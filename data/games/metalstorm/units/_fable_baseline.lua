-- _fable_baseline.lua — Fable-forge procedural native-model showcase units.
--
-- These are NOT part of the Metalstorm roster. They are the model-harness
-- showcase units (PLAN-metalstorm-beta-units.md §1/§5, DESIGN-MODEL-BUILDING.md
-- §14) for the native procedural pipeline (tools/fable-model-forge), wired as
-- spawnable defs so the model-viewer harness
-- (?scenario=model-viewer&game=metalstorm&def=fable_tank) can exercise them —
-- including DESIGN §16c client-side cosmetic turret aim, which requires a
-- `turret` piece with a barrel/muzzle descendant and a weapon that actually
-- fires. Kept intentionally minimal: single-unit (squad_size = 1) so the
-- harness frames one model, not a squad fan-out. Mirrors _wz_baseline.lua.
--
-- Model stems (data/games/metalstorm/models/<objectname>.gltf):
--   fable_tank  body/tracks_l/tracks_r/turret/barrel/muzzle/exhaust
--   fable_mech  body/turret/barrel/muzzle/exhaust + biped legs (clip-owned)

local function baseline(t)
    t.customparams = t.customparams or {}
    t.customparams.ms_class = 'fable_baseline'
    t.customparams.squad_size = '1'          -- single model, no fan-out
    return t
end

return {
    fable_tank = baseline{
        name = 'Fable Tank (baseline)',
        description = 'Procedural native-model tank — fable-model-forge showcase',
        objectname = 'fable_tank',
        category = 'LAND MOBILE TANK',
        movementclass = 'VEH',
        maxdamage = 1600, mass = 600,
        maxvelocity = 2.4, acceleration = 0.25, brakerate = 0.2, turnrate = 700,
        footprintx = 3, footprintz = 3,
        sightdistance = 450,
        canmove = true, canattack = true, canpatrol = true, canstop = true, canguard = true,
        weapons = { [1] = { name = 'MS_AC_S3' } },
    },
    fable_mech = baseline{
        name = 'Fable Mech (baseline)',
        description = 'Procedural native-model biped mech — fable-model-forge showcase',
        objectname = 'fable_mech',
        category = 'LAND MOBILE',
        movementclass = 'VEH',
        maxdamage = 900, mass = 300,
        maxvelocity = 2.0, acceleration = 0.3, brakerate = 0.25, turnrate = 900,
        footprintx = 2, footprintz = 2,
        sightdistance = 420,
        canmove = true, canattack = true, canpatrol = true, canstop = true, canguard = true,
        weapons = { [1] = { name = 'MS_AC_S2' } },
    },
}
