-- fable_airship.lua — FT-2 "Pelican" heavy air transport.
--
-- Sixth generated-model showcase from tools/fable-model-forge/: native
-- hand-built glTF authored by Claude Fable 5 in the Cowork sandbox,
-- spawnable via ?scenario=model-viewer&game=metalstorm&def=fable_airship.
--
-- Model: models/fable_airship.gltf (+.bin, 5 .ktx2) — 65 m rigid
-- dirigible, twin ventral cargo cradles sized for MBTs. 2222 tris,
-- 2048² atlas. Four podded props (prop1–prop4) spin in the looping
-- idle clip. Rests on gondola skids + cradle frames; forward -Z,
-- 1 u = 1 m, SPRINGRTS_geometry v8, team mask on materials[0].
--
-- Transport contract (BAR/ZK pattern, researched from
-- data/games/zk/scripts/gunshipheavytrans.lua + Sim/Units/Unit.cpp):
-- the model ships empty attachment pieces `link1`/`link2` under the
-- cargo bays. A unit script's QueryTransport(passengerID) returns one
-- of them and AttachUnit(link, passengerID) snaps the passenger there,
-- after Move()-ing the link down by the passenger's height (Hercules
-- lowers it by GetUnitHeight + 15). Engine gates: canload,
-- transportCapacity, and xsize <= transportSize * 2 per passenger —
-- transportSize 3 admits footprint-3 (s2, 8.5 m) tanks and below,
-- capacity 2 matches the two cradles.
-- Licensing: see the Generated rows in ../ASSETS.md.

return {
    fable_airship = {
        name = 'FT-2 Pelican',
        description = 'Fable heavy air transport — generated-model showcase',
        objectname = 'fable_airship',
        category = 'AIR MOBILE',
        canfly = true,
        hoverattack = true,          -- gunship-style hover, no strafing runs
        airstrafe = 0,
        upright = true,
        collide = false,
        cruisealtitude = 220,
        verticalspeed = 15,
        maxdamage = 3500, mass = 1500,
        maxvelocity = 2.0, acceleration = 0.06, brakerate = 0.08, turnrate = 120,
        turninplace = 0,
        footprintx = 8, footprintz = 8,
        sightdistance = 600,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        canguard = true,
        -- transport
        canload = 1,
        transportcapacity = 2,
        transportsize = 3,
        transportmass = 1200,
        loadingradius = 160,
        releaseheld = true,
        customparams = {
            ms_class = 'fable_showcase',
            -- PLAN-metalstorm-transports.md §3.6/§7.9: the ONE key UI, AI and
            -- gadgets key off to recognise a carrier. No per-consumer def lists.
            is_transport = '1',
            squad_size = '1',
            transport_links = 'link1,link2',   -- QueryTransport attach pieces
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
