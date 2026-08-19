-- fable_tank.lua — FV-9 "Vanguard" railgun MBT.
--
-- The generated-model PoC counterpart to units/_wz_baseline.lua
-- (PLAN-metalstorm-beta-units.md §1/§5, PLAN-model-harness.md): a native,
-- hand-built glTF authored by Claude Fable 5 in the Cowork sandbox
-- (tools/fable-model-forge/), wired as a spawnable def so the model-viewer
-- harness (?scenario=model-viewer&game=metalstorm&def=fable_tank) can
-- judge it side by side with the WZ2100 conversion baseline.
--
-- Model: models/fable_tank.gltf (+.bin, 4 .ktx2) — pieces body /
-- tracks_l / tracks_r / turret / barrel / muzzle / exhaust, forward -Z,
-- 1 unit = 1 m (matches the wz baseline convention), 1212 tris,
-- SPRINGRTS_geometry v8, SPRINGRTS_team_color mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.
--
-- `fable_tank_dressed` is the §M5 dressing-kit probe: the same hull with
-- `customparams.ms_dress = 'order'`, which the client reads at model load to
-- append the ms_dress_order accessories (staff+pennant, lightbar, stowage) as
-- extra pieces parented to `body` (client/src/core/dressing-kits.ts). Cosmetic
-- only — the server sees an ordinary fable_tank: same model, radius, footprint
-- and collision volume.
--   ?scenario=model-viewer&game=metalstorm&def=fable_tank_dressed

local tank = {
    name = 'FV-9 Vanguard',
    description = 'Fable railgun MBT — generated-model showcase',
    objectname = 'fable_tank',
    category = 'LAND MOBILE TANK',
    movementclass = 'VEH',
    -- MBT ballpark (BAR stumpy: 1800hp / 75 e/s / turn 340). 2.3 e/f =
    -- 69 e/s. turnrate was 680 — scout-car agility on an MBT hull.
    maxdamage = 2000, mass = 700,
    maxvelocity = 2.3, acceleration = 0.24, brakerate = 0.2, turnrate = 420,
    footprintx = 3, footprintz = 3,
    sightdistance = 470,
    canmove = true, canattack = true, canpatrol = true, canstop = true,
    canguard = true,
    transportbyenemy = false,
    weapons = { [1] = { name = 'MS_RAILGUN_S2' } },
    customparams = {
        ms_class = 'fable_showcase',
        squad_size = '1',            -- single model: harness frames one unit
        generator = 'Claude Fable 5 (tools/fable-model-forge)',
    },
}

-- Dressing-kit showcase defs: each faction's kit on the tank hull.
local function dressed_variant(faction, display_name)
    local def = {}
    for k, v in pairs(tank) do def[k] = v end
    def.name = 'FV-9 ' .. display_name
    def.description = 'Fable railgun MBT — ' .. faction .. ' dressing kit'
    def.customparams = {}
    for k, v in pairs(tank.customparams) do def.customparams[k] = v end
    def.customparams.ms_dress = faction
    return def
end

return {
    fable_tank = tank,
    fable_tank_dressed = dressed_variant('order', 'Vanguard (Order colours)'),
    fable_tank_dynasty = dressed_variant('dynasty', 'Vanguard (Dynasty)'),
    fable_tank_resistance = dressed_variant('resistance', 'Vanguard (Resistance)'),
    fable_tank_anarchic = dressed_variant('anarchic', 'Vanguard (Anarchic)'),
}
