-- Transports — surface lift (PLAN-metalstorm-model-integration §M1).
-- The naval counterpart of fable_airship.lua's air lift.
--
-- Hand-written (not units/_builder.lua): one-off hull wired to ONE shipped
-- forge model, not a 4-scale class curve. Shape follows fable_tank.lua.
--
-- Model: models/ms_landing_ship.gltf — 35 m amphibious hull, pieces body /
-- ramp (hinged at the bow sill) / radar / link1–link4 / exhaust, clips idle
-- (radar rotation) + unload (ramp lowers −102° about X).
--
-- Transport contract: the four `link*` empties follow the fable_airship
-- convention (QueryTransport → AttachUnit). Like the airship, the ATTACH side
-- still needs the engine/script work described in fable_airship.lua — the def
-- declares capacity so the load command exists, and the `unload` clip has no
-- automatic driver yet (clip-auto-policy only drives walk/idle; the ramp stays
-- shut outside the F8 harness). Both are follow-on work, not §M1.
-- Provenance: the Generated rows in ../ASSETS.md.

return {
    ms_landing_ship = {
        name = 'Landing Ship',
        description = 'Amphibious landing ship — bow ramp, open vehicle well deck',
        objectname = 'ms_landing_ship',
        category = 'SHIP MOBILE',
        movementclass = 'SHIP',
        maxdamage = 1800, mass = 2200,
        maxvelocity = 2.0, acceleration = 0.08, brakerate = 0.1, turnrate = 220,
        footprintx = 4, footprintz = 8,
        sightdistance = 600,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        canguard = true,
        -- transport (see the header — the attach side is follow-on work)
        canload = 1,
        transportcapacity = 4,
        transportsize = 3,
        transportmass = 2400,
        loadingradius = 200,
        releaseheld = true,
        customparams = {
            ms_class = 'landing_ship', squad_size = '1',
            -- PLAN-metalstorm-transports.md §3.6/§7.9: the ONE key UI, AI and
            -- gadgets key off to recognise a carrier. No per-consumer def lists.
            is_transport = '1',
            authority_cost_base = '2',
            transport_links = 'link1,link2,link3,link4',
            generator = 'Claude Fable 5 (tools/forge)',
        },
    },
}
