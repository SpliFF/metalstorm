-- fable_train.lua — "Colubris" land train family (4 independent units).
--
-- Eleventh generated-model showcase from tools/fable-model-forge/:
-- native hand-built glTF authored by Claude Fable 5, spawnable via
-- ?scenario=model-viewer&game=metalstorm&def=fable_train_engine (etc).
--
-- Models: fable_train_{engine,gun,troop,cargo}.gltf (+.bin) sharing
-- ONE texture set fable_train_*.ktx2 (§28 atlas-sharing pattern).
-- Wheeled land train, slightly over rail-train scale: hulls 4.2 m
-- wide, engine ~21 m + plow (5 axles), carriages 16 m (4 axles), all
-- heavily plated with painted firing ports + shuttered rows on the
-- carriage band.
--
-- COUPLING CONTRACT: every unit ships `link_f` / `link_r` empties at
-- the coupler knuckles (y 1.35, z ±(L/2+0.7)). Consists are joined by
-- game code exactly like the transport/turret attachment patterns
-- (§23 links, §25 pads): a gadget binds car link_f → leader link_r
-- (AttachUnit or position-slaving), drives the lead engine and slaves
-- the rest; a rear engine (same unit placed reversed) drives the
-- consist the other way — both engines carry couplers on both ends.
-- Axle pieces (axle1..axleN) are the wheel-spin script API.
--
-- The troop car's second cupola is a FLAME PROJECTOR visually (fuel
-- tanks + wide nozzle, pilot-light glow) but binds MS_MG_S1 — no
-- flame weapon family exists yet; customparams.flame_visual marks it
-- for rebinding when one lands.
-- Licensing: see the Generated rows in ../ASSETS.md.

local common = {
    category = 'LAND MOBILE',
    movementclass = 'VEH',
    canmove = true, canattack = true, canpatrol = true, canstop = true,
    canguard = true,
    footprintx = 3,
    sightdistance = 450,
}

local function unit(t)
    for k, v in pairs(common) do
        if t[k] == nil then t[k] = v end
    end
    t.customparams = t.customparams or {}
    t.customparams.ms_class = 'fable_showcase'
    t.customparams.squad_size = '1'
    t.customparams.couple_links = 'link_f,link_r'
    t.customparams.generator = 'Claude Fable 5 (tools/fable-model-forge)'
    return t
end

return {
    fable_train_engine = unit{
        name = 'Colubris Engine',
        description = 'Land train engine — drives the consist from either end',
        objectname = 'fable_train_engine',
        maxdamage = 9500, mass = 2400,
        maxvelocity = 2.4, acceleration = 0.06, brakerate = 0.10,
        turnrate = 220, footprintz = 9,
        weapons = {
            [1] = { name = 'MS_RAILGUN_S2' },     -- forward turret chain
            [2] = { name = 'MS_FLAK_S1' },        -- AA chain (turret2)
        },
        customparams = { train_role = 'engine' },
    },
    fable_train_gun = unit{
        name = 'Colubris Gun Car',
        description = 'Land train weapons platform — twin roof howitzer turrets',
        objectname = 'fable_train_gun',
        maxdamage = 7000, mass = 1800,
        maxvelocity = 1.8, acceleration = 0.05, brakerate = 0.09,
        turnrate = 200, footprintz = 7,
        weapons = {
            [1] = { name = 'MS_HOWITZER_S2' },    -- fore turret
            [2] = { name = 'MS_HOWITZER_S2' },    -- aft turret (baked +Z)
            [3] = { name = 'MS_MG_S1' },          -- cupola (turret3)
        },
        customparams = { train_role = 'gun' },
    },
    fable_train_troop = unit{
        name = 'Colubris Troop Car',
        description = 'Land train passenger car — firing ports + MG/flame cupolas',
        objectname = 'fable_train_troop',
        maxdamage = 7500, mass = 1700,
        maxvelocity = 1.8, acceleration = 0.05, brakerate = 0.09,
        turnrate = 200, footprintz = 7,
        canload = 1,
        transportcapacity = 8, transportsize = 1,   -- a rifle squad
        loadingradius = 120, releaseheld = true,
        weapons = {
            [1] = { name = 'MS_MG_S1' },          -- fore cupola
            [2] = { name = 'MS_MG_S1' },          -- aft cupola (flame visual)
        },
        customparams = { train_role = 'troop', flame_visual = 'weapon2' },
    },
    fable_train_cargo = unit{
        name = 'Colubris Cargo Car',
        description = 'Land train equipment car — armoured flatbed',
        objectname = 'fable_train_cargo',
        maxdamage = 7000, mass = 1900,
        maxvelocity = 1.8, acceleration = 0.05, brakerate = 0.09,
        turnrate = 200, footprintz = 7,
        canload = 1,
        transportcapacity = 2, transportsize = 2,   -- light vehicles
        loadingradius = 120, releaseheld = true,
        weapons = {
            [1] = { name = 'MS_MG_S1' },          -- pulpit cupola
        },
        customparams = { train_role = 'cargo' },
    },
}
