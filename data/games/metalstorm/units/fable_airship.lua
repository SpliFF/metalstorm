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
        -- Durability to the §7.9 comparator (PLAN-metalstorm-transports.md),
        -- not warship HP: survives one ms_soldiers_s1 squad's focused fire
        -- ≥30 s (MS_MG_S1 ≈ 50 dps raw → 24 s, ≥30 s with statistical accuracy
        -- falloff at cruise altitude), dies to dedicated flak in ~10-15 s
        -- (MS_FLAK_S1 80 dps / MS_FLAK_S2 120 dps). 3500 survived flak 44 s —
        -- HVT-proof, so it came down.
        maxdamage = 1200, mass = 1500,
        -- 3.6 e/f = 108 e/s: slow for air (BAR lift transports run 150-240
        -- e/s) but a heavy dirigible must still outpace the ground columns it
        -- lifts (tanks 2.6 e/f); 2.0 was slower than its own cargo.
        maxvelocity = 3.6, acceleration = 0.06, brakerate = 0.08, turnrate = 120,
        turninplace = 0,
        footprintx = 8, footprintz = 8,
        sightdistance = 600,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        canguard = true,
        -- transport
        canload = 1,
        -- FOUR, not two, and the unit is "footprint", not "passenger": the
        -- engine charges `xsize / 2` per passenger (Sim/Units/Unit.cpp:2684),
        -- so an s1 squad (footprint 2) costs 2 slots. `2` therefore meant ONE
        -- passenger, not the two cradles the model has and the comment above
        -- describes — measured on a headless arrival that loaded 1 of 2 squads.
        -- 4 = the two cradles the model actually ships.
        transportcapacity = 4,
        transportsize = 3,
        -- Must cover the MBT the cradles are sized for: one ms_tanks_s2 masses
        -- 1000 (baseMass 500 × 2), two s1 squads ≈ 180-1000. 1200 was one
        -- squad's margin, not a tank's.
        transportmass = 2200,
        loadingradius = 160,
        releaseheld = true,
        -- §7.9: fire platform, not a gunship — carried squads fight from the
        -- external cradles (train T5 precedent); canattack stays false.
        isfireplatform = true,
        -- A carrier is never cargo, and no enemy Pelican abducts our squads.
        cantbetransported = true,
        transportbyenemy = false,
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
