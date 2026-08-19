-- fable_heavy.lua — FV-20 "Bastion" super-heavy twin railgun tank.
--
-- Second generated-model showcase from tools/fable-model-forge/: a
-- native hand-built glTF authored by Claude Fable 5 in the Cowork
-- sandbox, spawnable via the model-viewer harness
-- (?scenario=model-viewer&game=metalstorm&def=fable_heavy).
--
-- Model: models/fable_heavy.gltf (+.bin, 5 .ktx2) — 2× fable_tank
-- length (20.3 m), 2394 tris, 2048² atlas (texel density matches the
-- 1024² fable_tank, so wear/seams read at the same world scale).
-- Pieces: body / tracks_l / tracks_r / turret / barrel (twin tubes) /
-- muzzle / muzzle_l / muzzle_r / turret2 / barrel2 / muzzle2 / exhaust.
-- turret2 is an INDEPENDENT secondary turret on the front-left sponson
-- — weapon [2] should aim it separately once cosmetic turret aim
-- (DESIGN-MODEL-BUILDING.md §16c) lands. forward -Z, 1 unit = 1 m,
-- SPRINGRTS_geometry v8, SPRINGRTS_team_color mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.

local heavy = {
    name = 'FV-20 Bastion',
    description = 'Fable super-heavy twin railgun tank — generated-model showcase',
    objectname = 'fable_heavy',
    category = 'LAND MOBILE TANK',
    movementclass = 'HEAVY',
    -- Super-heavy ballpark (unit props review 2026-08-20): this is the same
    -- hull ms_tanks_s4 ships (units/tanks.lua), so the standalone showcase
    -- def tracks the roster flagship — 24000hp (a shade under the s4's
    -- 30000: twin rail + bow AC vs the s4's three-weapon fit), dreadnought
    -- crawl/turn. The old 9000hp/320-turn read as a mere T2 heavy.
    maxdamage = 24000, mass = 9000,
    maxvelocity = 1.2, acceleration = 0.07, brakerate = 0.09, turnrate = 160,
    footprintx = 6, footprintz = 6,
    sightdistance = 650,
    canmove = true, canattack = true, canpatrol = true, canstop = true,
    canguard = true,
    cantbetransported = true,
    transportbyenemy = false,
    weapons = {
        [1] = { name = 'MS_RAILGUN_S4' },   -- twin main tubes (muzzle_l/_r)
        [2] = { name = 'MS_AC_S2' },        -- independent bow turret2
    },
    customparams = {
        ms_class = 'fable_showcase',
        squad_size = '1',            -- land dreadnought: always a single hull
        generator = 'Claude Fable 5 (tools/fable-model-forge)',
    },
}

-- Dressing-kit showcase defs: each faction's kit on the heavy hull.
local function dressed_variant(faction, display_name)
    local def = {}
    for k, v in pairs(heavy) do def[k] = v end
    def.name = 'FV-20 ' .. display_name
    def.description = 'Fable super-heavy — ' .. faction .. ' dressing kit'
    def.customparams = {}
    for k, v in pairs(heavy.customparams) do def.customparams[k] = v end
    def.customparams.ms_dress = faction
    return def
end

return {
    fable_heavy = heavy,
    fable_heavy_order = dressed_variant('order', 'Bastion (Order)'),
    fable_heavy_dynasty = dressed_variant('dynasty', 'Bastion (Dynasty)'),
    fable_heavy_resistance = dressed_variant('resistance', 'Bastion (Resistance)'),
    fable_heavy_anarchic = dressed_variant('anarchic', 'Bastion (Anarchic)'),
}
