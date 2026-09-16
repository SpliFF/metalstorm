-- Civilian ships — harbour and coastal work traffic (PLAN-metalstorm.md §7,
-- the naval half of civvehicles.lua; units-assets review 2026-09-10 finding 9,
-- wired 2026-09-17).
--
-- Hand-written (not units/_builder.lua): four one-off hulls, each wired to
-- ONE shipped batch-03 forge model, not a 4-scale class curve. Shape follows
-- civvehicles.lua (the roster's existing civilian-vehicle contract: Gaia
-- team, environment-AI driven, escort / extraction objective payloads,
-- `customparams.civilian = '1'`) and transports.lua for the SHIP handling
-- numbers. Movement is the SHIP movedef (gamedata/moveinfo.tdf,
-- minwaterdepth 12), so a hull stays in navigable water — no per-def key.
--
-- WHY DEFS AND NOT FEATURES. A moored trawler could have been scenery, but
-- every one of these ships a clip a unit plays and a feature cannot (the
-- trawler's net boom sways, the ferry's ramps drop, the crane ship's trolley
-- runs), and the civvehicles contract they extend — a payload that MOVES and
-- can be lost — is the reason a harbour town wants them at all.
--
-- NOT SCENARIO-GENERATOR CONTENT. tools/mapgen/ms_defs.py reads only the def
-- files it can site, and it has no water placement; this file is deliberately
-- absent from its lists exactly as transports.lua is (see the comment there
-- and in ms_defs.py). Naming any of these in a template would let a war name
-- a def it can never place. Hand-authored scenarios stage them at a wharf.
--
-- Footprints: single-hull rule footprint metres = cells x 2 (_builder.lua;
-- ms_landing_ship at 34.3 m carries 4 x 17, ms_ships_s3 at 55 m carries 28),
-- measured off the shipped glTF. HP sits on the civilian tier: well under a
-- warship of the same length (ships s2 destroyer pair 7500, landing ship
-- 2600 for a 35 m hull), well above a truck (400 for 10.7 m) — killable
-- objective payloads, not combatants. Turn rates follow ships.lua's
-- 2026-08-29 derivation: a ~1.0 hull-length turning radius, and
-- turnInPlace = false so a ferry answers the helm instead of pivoting.
--
-- Provenance: the Generated rows in ../ASSETS.md (tools/forge batch-03).

--- Shared civilian-hull posture; only the numbers differ.
local function hull(t)
    t.category      = 'SHIP MOBILE CIVILIAN'
    t.movementclass = 'SHIP'
    t.canmove = true; t.canattack = false; t.canpatrol = true; t.canstop = true
    t.turnInPlace = false
    t.turnInPlaceSpeedLimitFrac = 1.0
    t.customparams = t.customparams or {}
    t.customparams.ms_class   = 'civships'
    t.customparams.civilian   = '1'
    t.customparams.squad_size = '1'
    t.customparams.generator  = 'Claude Fable 5 (tools/forge)'
    return t
end

return {
    -- 17.8 x 5.3 m, 7.7 m tall. High bow, aft working deck, A-frame gantry
    -- with a swaying net boom (`idle`), warm-lit wheelhouse, fish crates,
    -- draped nets. The smallest civilian hull; a fishing fleet is what a
    -- coastal shanty's harbour is FOR.
    ms_fishing_trawler = hull{
        name = 'Fishing Trawler',
        description = 'Civilian fishing trawler — protect / escort objective payload',
        objectname = 'ms_fishing_trawler',
        maxdamage = 900, mass = 600,
        maxvelocity = 2.4, acceleration = 0.12, brakerate = 0.12, turnrate = 210,
        footprintx = 3, footprintz = 9,      -- 6 x 18 m
        sightdistance = 350,
    },

    -- 31.8 x 9.4 m, 9.0 m tall. Double-ended two-lane vehicle ferry: ramps
    -- at both ends (`unload` drops them), pontoon sponsons, gantry pilot
    -- house. The naval ms_civbus — an EXTRACTION carrier, so it must be able
    -- to LOAD (canload/loadingradius; the capacity/size pair alone never
    -- makes a transport, civvehicles.lua's own lesson). Well-deck arithmetic
    -- follows transports.lua: size 4 admits an s3 tank, capacity 8 is four
    -- s1 squads or two s3 tanks — max 4 items, matching the four `link*`
    -- attach empties the model ships. Attach-side engine work is the same
    -- follow-on the landing ship records.
    ms_ferry = hull{
        name = 'Vehicle Ferry',
        description = 'Civilian double-ended vehicle ferry — extraction objective payload',
        objectname = 'ms_ferry',
        maxdamage = 2000, mass = 1600,
        maxvelocity = 1.9, acceleration = 0.08, brakerate = 0.10, turnrate = 90,
        footprintx = 5, footprintz = 16,     -- 10 x 32 m
        sightdistance = 400,
        canload = 1,
        transportcapacity = 8, transportsize = 4, transportmass = 4200,
        loadingradius = 200, releaseheld = true,
        cantbetransported = true,
        customparams = {
            -- PLAN-metalstorm-transports.md §3.6/§7.9: the ONE key UI, AI and
            -- gadgets key off to recognise a carrier.
            is_transport = '1',
            transport_links = 'link1,link2,link3,link4',
        },
    },

    -- 54.0 x 9.4 m, 14.6 m tall. Tramp freighter: forecastle, two open
    -- cargo holds, deck crane, aft house and funnel (`idle` runs the exhaust
    -- and the laundry line). The convoy payload at sea — the naval
    -- ms_civtruck, at five times the length.
    ms_cargo_tramp = hull{
        name = 'Cargo Tramp',
        description = 'Civilian tramp freighter — convoy / escort objective payload',
        objectname = 'ms_cargo_tramp',
        maxdamage = 3200, mass = 3000,
        maxvelocity = 1.7, acceleration = 0.05, brakerate = 0.07, turnrate = 48,
        footprintx = 5, footprintz = 27,     -- 10 x 54 m
        sightdistance = 400,
        cantbetransported = true,
    },

    -- 54.0 x 11.0 m, 15.9 m tall. Salvage crane ship: barge hull, lattice
    -- A-frame and stern boom with a travelling trolley and hook (`idle`),
    -- scrap heap, torch gantry, workshop cabin. The one civilian hull with a
    -- reason to be near a wreck field — a salvage economy's boat, when one is
    -- designed (features/wrecks.lua carries the placeholder yields). No
    -- reclaim ability here: squad.lua vetoes CMD_RECLAIM and nothing spends
    -- metal yet, so declaring it would be a promise the game cannot keep.
    ms_salvage_crane_ship = hull{
        name = 'Salvage Crane Ship',
        description = 'Civilian salvage crane ship — escort objective payload',
        objectname = 'ms_salvage_crane_ship',
        maxdamage = 3000, mass = 3200,
        maxvelocity = 1.5, acceleration = 0.05, brakerate = 0.07, turnrate = 46,
        footprintx = 6, footprintz = 27,     -- 12 x 54 m
        sightdistance = 400,
        cantbetransported = true,
    },
}
