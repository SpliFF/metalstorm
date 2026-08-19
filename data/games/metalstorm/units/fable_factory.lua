-- fable_factory.lua — "Plant 07" generic factory building.
--
-- Fourth generated-model showcase from tools/fable-model-forge/: a
-- native hand-built glTF authored by Claude Fable 5 in the Cowork
-- sandbox, spawnable via
-- ?scenario=model-viewer&game=metalstorm&def=fable_factory.
--
-- Model: models/fable_factory.gltf (+.bin, 5 .ktx2) — scale-relative
-- to the shipped units (colossus 15 m): sawtooth hall ridge 13.2 m,
-- stacks 17.8 m, on a 30×24 m concrete pad. 5544 tris, 2048² atlas.
-- Pieces: body / dish / fan / exhaust — dish (comms) and fan (rear
-- extractor) rotate in the looping 'idle' clip; exhaust is the FX
-- empty at the tall stack tip. forward -Z (gate side), 1 u = 1 m,
-- SPRINGRTS_geometry v8, team mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.

return {
    fable_factory = {
        name = 'Plant 07',
        description = 'Fable factory — generated-model showcase building',
        objectname = 'fable_factory',
        category = 'LAND BUILDING',
        isbuilding = true,
        canmove = false, canattack = false,
        maxvelocity = 0,   -- immobile units MUST be speed 0 (see _builder.lua)
        maxdamage = 16000, mass = 28000,
        footprintx = 15, footprintz = 12,
        yardmap = string.rep(string.rep('o', 15) .. ' ', 12),
        sightdistance = 420,
        buildtime = 420000,
        customparams = {
            ms_class = 'fable_showcase',
            building_family = 'military',
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
