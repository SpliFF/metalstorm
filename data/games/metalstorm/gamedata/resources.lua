-- Metalstorm graphics resources.
-- Native game: textures land here as .ktx2, FX sprites referenced directly.
-- Populated as art assets are authored (PLAN-metalstorm.md §11).
--
-- FX WIRING (weapon-fx pass): these logical names are what the effect library
-- (effects/library.json) and the shaders/fx/ programs sample. The .ktx2 files
-- under unittextures/ are authored later (objects3d/unittextures currently
-- empty per §11); like sounds.lua, declaring a name whose file is absent is
-- inert until the FX system actually binds it, which is Stage-7 work. STUB
-- paths — one shared FX sprite atlas keeps the particle draw to a single
-- texture bind (PLAN-fx-offload.md §5 GPU-particle batching).
return {
    graphics = {
        -- Projectile / tracer core textures (tracer.frag.glsl optional uTex).
        projectiletextures = {
            fx_dot = 'unittextures/fx_dot.ktx2',   -- soft round dot for tracer core
        },
        -- The shared FX particle atlas (particle.frag.glsl uParticleTex). Frame
        -- layout (cols/rows/frames) is declared in effects/library.json.atlas.
        groundfx = {
            fx_atlas = 'unittextures/fx_atlas.ktx2',
            scorch   = 'unittextures/fx_atlas.ktx2',  -- scorch cell lives in the atlas
        },
        -- Ribbon-trail strips (trail.frag.glsl uTrailTex): rocket smoke + wake.
        smoke = {
            smoketrail  = 'unittextures/fx_atlas.ktx2',   -- smoketrail cell (16)
            bubbletrail = 'unittextures/fx_atlas.ktx2',   -- bubbletrail cell (17)
        },
        -- Persistent ground scorch decals (impact `scorch` particle, ground orient).
        scars = {
            scorch = 'unittextures/fx_atlas.ktx2',
        },
    },
}
