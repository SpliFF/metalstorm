-- Civilian vehicles — transport and work traffic (PLAN-metalstorm.md §7).
-- Escort-objective payloads; environment-AI driven.
return {
    ms_civtruck = {
        name = 'Cargo Truck',
        description = 'Civilian cargo hauler — convoy / escort objective payload',
        objectname = 'ms_civtruck',
        category = 'LAND MOBILE CIVILIAN',
        movementclass = 'VEH',
        maxdamage = 400, mass = 250,
        maxvelocity = 3.0, acceleration = 0.2, brakerate = 0.2, turnrate = 600,
        footprintx = 2, footprintz = 3,
        sightdistance = 250,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        customparams = { ms_class = 'civvehicles', civilian = '1', squad_size = '1' },
    },
    ms_civbus = {
        name = 'Transit Bus',
        description = 'Civilian transport — extraction objective payload',
        objectname = 'ms_civbus',
        category = 'LAND MOBILE CIVILIAN',
        movementclass = 'VEH',
        maxdamage = 350, mass = 220,
        maxvelocity = 2.8, acceleration = 0.2, brakerate = 0.2, turnrate = 550,
        footprintx = 2, footprintz = 3,
        sightdistance = 250,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        -- Extraction carrier: it must actually be able to LOAD its passengers.
        -- canload/loadingradius were missing (props review 2026-08-20) — the
        -- capacity/size pair alone never makes a unit a transport.
        canload = 1,
        transportcapacity = 4, transportsize = 1,
        loadingradius = 100, releaseheld = true,
        customparams = {
            ms_class = 'civvehicles', civilian = '1', squad_size = '1',
            -- PLAN-metalstorm-transports.md §3.6/§7.9: the ONE key UI, AI and
            -- gadgets key off to recognise a carrier.
            is_transport = '1',
        },
    },
}
