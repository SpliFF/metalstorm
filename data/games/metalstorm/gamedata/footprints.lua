-- gamedata/footprints.lua — authored footprint profiles (PLAN-metalstorm-flow.md §1). STUB.
--
-- Per-profile ground-contact shape for scale 3–4 units and buildings:
-- permeability (can smaller move-classes flow UNDER/through?), mass-yield
-- rules, and contact-patch layout (feet/tracks) the client patch renderer
-- (client/squads/patches.js) animates against gait phase.
--
-- Unit defs opt in via customparams.footprint_profile = '<key>' (authored in
-- units/_builder.lua); model sidecars (.meta.lua, PLAN-metalstorm-beta-units)
-- carry the per-piece patch anchors. Engine-side parsing is flow engine ask
-- F1 (Stage-7 gated) — until then this file is inert data.
--
-- Profile shape (proposed):
--   quad_walker_l = {
--       permeable_below = 'INFANTRY',   -- move classes that pass under
--       mass_yield      = 0.0,          -- 0 = never yields, 1 = always
--       patches = {                     -- contact patches, model space
--           { piece = 'foot_fl', kind = 'foot',  w = 8, l = 10 },
--           { piece = 'foot_fr', kind = 'foot',  w = 8, l = 10 },
--           { piece = 'foot_rl', kind = 'foot',  w = 8, l = 10 },
--           { piece = 'foot_rr', kind = 'foot',  w = 8, l = 10 },
--       },
--   },
--   heavy_tracks = { ... },             -- twin track strips
--   dreadnought  = { ... },             -- scale-4 super-heavy

return {
    -- TODO (PLAN-metalstorm-flow §1): author profiles alongside the first
    -- scale-3/4 models (PLAN-metalstorm-beta-units roster).
}
