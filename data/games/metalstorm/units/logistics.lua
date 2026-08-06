-- Logistics — the supply tail (PLAN-metalstorm-model-integration §M1).
-- Unarmed or barely armed wheeled vehicles: they carry, fuel, courier and
-- survey. Military counterparts of units/civvehicles.lua, which they are
-- deliberately distinct from in armour and palette.
--
-- Hand-written (not units/_builder.lua): one-off vehicles wired to ONE shipped
-- forge model each, not a 4-scale class curve. Shape follows fable_tank.lua.
--
-- All four models carry `axle_*` pieces on the civkit convention (axle bar
-- along local X, pivot at wheel centre, wheels resting at Y=0) and are spun
-- client-side off wire speed by wheel-spin-driver.ts. Natives are script-less
-- — do NOT add a sim-side unit script to spin them.
-- Provenance: the Generated rows in ../ASSETS.md.

return {
    -- 6x6 cab-over, plated cargo box. Pieces body + axle_f/axle_m/axle_r.
    ms_supply_truck = {
        name = 'Supply Truck',
        description = 'Armoured 6x6 hauler — the forward supply tail',
        objectname = 'ms_supply_truck',
        category = 'LAND MOBILE VEHICLE',
        movementclass = 'VEH',
        maxdamage = 420, mass = 320,
        maxvelocity = 2.6, acceleration = 0.18, brakerate = 0.2, turnrate = 520,
        footprintx = 2, footprintz = 3,
        sightdistance = 320,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        canguard = true,
        customparams = {
            ms_class = 'supply', squad_size = '1',
            authority_cost_base = '1',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },

    -- Cylindrical tank + hose reel. Pieces body / hose_reel / axle_f,m,r /
    -- nozzle (an empty — the unload-FX mount, nothing drives it yet).
    ms_fuel_tanker = {
        name = 'Fuel Tanker',
        description = 'Armoured fuel bowser — hazard-banded, hose reel aft',
        objectname = 'ms_fuel_tanker',
        category = 'LAND MOBILE VEHICLE',
        movementclass = 'VEH',
        maxdamage = 380, mass = 340,
        maxvelocity = 2.4, acceleration = 0.16, brakerate = 0.2, turnrate = 480,
        footprintx = 2, footprintz = 3,
        sightdistance = 300,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        canguard = true,
        customparams = {
            ms_class = 'tanker', squad_size = '1',
            authority_cost_base = '1',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },

    -- Low, fast dispatch runner. Pieces body / axle_f / axle_r plus an
    -- unmanned MG ring on the standard turret→barrel→muzzle chain, so it
    -- picks up cosmetic turret aim for free.
    ms_courier_car = {
        name = 'Courier Car',
        description = 'Fast armoured dispatch runner — light MG ring',
        objectname = 'ms_courier_car',
        category = 'LAND MOBILE VEHICLE',
        movementclass = 'VEH',
        maxdamage = 260, mass = 150,
        maxvelocity = 4.6, acceleration = 0.4, brakerate = 0.34, turnrate = 1000,
        footprintx = 2, footprintz = 2,
        sightdistance = 400,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = { [1] = { name = 'MS_MG_S1' } },
        customparams = {
            ms_class = 'courier', squad_size = '1',
            authority_cost_base = '1',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },

    -- 6-wheel mission-module chassis. DEVIATION (M1, 2026-08-06): the model
    -- carries all four modules (mod_survey+dish / mod_envoy / mod_repair /
    -- mod_mast) as separate pieces and the client has NO per-piece visibility
    -- channel, so all four render at once. Fixing it needs either a piece-hide
    -- channel next to the clip/aim/wheel pose maps or per-variant forge
    -- models; neither is M1 work. The `idle` clip rotates the survey dish.
    ms_expedition_rig = {
        name = 'Expedition Rig',
        description = 'Survey and liaison chassis — mission modules aboard',
        objectname = 'ms_expedition_rig',
        category = 'LAND MOBILE VEHICLE',
        movementclass = 'VEH',
        maxdamage = 520, mass = 420,
        maxvelocity = 2.4, acceleration = 0.16, brakerate = 0.2, turnrate = 460,
        footprintx = 3, footprintz = 3,
        sightdistance = 620,
        radardistance = 1400,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        canguard = true,
        customparams = {
            ms_class = 'expedition', squad_size = '1',
            authority_cost_base = '2',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },
}
