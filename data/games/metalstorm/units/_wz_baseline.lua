-- _wz_baseline.lua — Warzone 2100 conversion baseline units.
--
-- These are NOT part of the Metalstorm roster. They are the model-harness
-- showcase + PoC comparison baseline (PLAN-metalstorm-beta-units.md §1/§5):
-- real WZ2100 `.pie` models (GPL-2.0-or-later, see ../ASSETS.md) converted to
-- native `.gltf` by tools/scripts/pie_to_glb.py, wired as spawnable defs so
-- the model-viewer harness (?scenario=model-viewer&game=metalstorm&def=wz_tank
-- &capture=turntable) can showcase them and Fable's generated tank/mech can be
-- judged against them side by side. Kept intentionally minimal: single-unit
-- (squad_size = 1) so the harness frames one model, not a squad fan-out.
--
-- Model stems (data/games/metalstorm/models/<objectname>.gltf):
--   wz_tank     drhbod09 (hull) + prh?trk3 (tracks) + trhcan (turret)
--   wz_wheeled  drlbod01 (Viper hull) + prl?whl1 (wheels) + trlcan (turret)
--   wz_cyborg   cybd_std (body) + cy_can (gun)
--   wz_building blhq (command HQ)

local function baseline(t)
    t.customparams = t.customparams or {}
    t.customparams.ms_class = 'wz_baseline'
    t.customparams.squad_size = '1'          -- single model, no fan-out
    t.customparams.wz_source = 'Warzone 2100 (GPL-2.0-or-later)'
    return t
end

return {
    wz_tank = baseline{
        name = 'WZ Tank (baseline)',
        description = 'Warzone 2100 tracked tank — conversion baseline',
        objectname = 'wz_tank',
        category = 'LAND MOBILE TANK',
        movementclass = 'VEH',
        maxdamage = 1600, mass = 600,
        maxvelocity = 2.4, acceleration = 0.25, brakerate = 0.2, turnrate = 700,
        footprintx = 3, footprintz = 3,
        sightdistance = 450,
        canmove = true, canattack = true, canpatrol = true, canstop = true, canguard = true,
        weapons = { [1] = { name = 'MS_AC_S3' } },
    },
    wz_wheeled = baseline{
        name = 'WZ Wheeled (baseline)',
        description = 'Warzone 2100 wheeled vehicle (Viper hull) — conversion baseline',
        objectname = 'wz_wheeled',
        category = 'LAND MOBILE',
        movementclass = 'VEH',
        maxdamage = 700, mass = 250,
        maxvelocity = 3.2, acceleration = 0.35, brakerate = 0.3, turnrate = 1000,
        footprintx = 2, footprintz = 2,
        sightdistance = 420,
        canmove = true, canattack = true, canpatrol = true, canstop = true, canguard = true,
        weapons = { [1] = { name = 'MS_MG_S2' } },
    },
    wz_cyborg = baseline{
        name = 'WZ Cyborg (baseline)',
        description = 'Warzone 2100 cyborg walker — conversion baseline',
        objectname = 'wz_cyborg',
        category = 'LAND MOBILE',
        movementclass = 'INFANTRY',
        maxdamage = 400, mass = 90,
        maxvelocity = 1.8, acceleration = 0.3, brakerate = 0.3, turnrate = 1400,
        footprintx = 2, footprintz = 2,
        sightdistance = 380,
        canmove = true, canattack = true, canpatrol = true, canstop = true, canguard = true,
        weapons = { [1] = { name = 'MS_MG_S1' } },
    },
    wz_building = baseline{
        name = 'WZ Command HQ (baseline)',
        description = 'Warzone 2100 command HQ — conversion baseline',
        objectname = 'wz_building',
        category = 'LAND BUILDING',
        isbuilding = true,
        maxdamage = 20000, mass = 30000,
        footprintx = 10, footprintz = 8,
        yardmap = string.rep(string.rep('o', 10) .. ' ', 8),
        sightdistance = 500,
        canmove = false, canattack = false,
    },
}
