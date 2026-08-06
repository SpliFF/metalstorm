# `features/` — Metalstorm featuredefs

**This directory is scanned, not indexed.** `cont/base/springcontent/gamedata/featuredefs.lua`
does `RecursiveFileSearch('features/', '*.tdf')` then `RecursiveFileSearch('features/', '*.lua')`
and merges every returned table into the `FeatureDefs` root that
`CFeatureDefHandler::Init` reads (rts/Sim/Features/FeatureDefHandler.cpp:22).
That is the same contract `units/` has, with two consequences worth stating
before someone adds a file here:

1. **Every `.lua` under `features/` is a featuredef file.** It must return a
   `{ name = {def}, ... }` table. A shared helper module dropped in here would
   be parsed as defs, log `Missing return table from: ...`, and — if it *did*
   return a table — silently register garbage defs. Helpers go in
   `LuaRules/`, or stay file-local (which is what the files here do).
2. **Do NOT author `gamedata/featuredefs.lua` in this game.** The game archive
   overrides springcontent in the VFS, so that file would *replace the parser*
   rather than add defs, and the `features/` scan would stop happening.

Optional hooks the parser honours if we ever need them:
`gamedata/featuredefs_pre.lua` (seed `FeatureDefs` before the scan) and
`gamedata/featuredefs_post.lua` (post-process after it).

## What the engine actually reads

`CreateFeatureDef` (FeatureDefHandler.cpp:88) consumes exactly these keys —
anything else you write is ignored except `customParams`, which is passed
through verbatim to Lua and to the client:

| key | effect |
| --- | --- |
| `description` | free text |
| `object` | model stem; `SolidObjectDef::LoadModel` resolves `<stem>.gltf` in the mod VFS |
| `blocking` (default true) | `collidable` → `CFeature::Block()` occupies the ground-blocking map |
| `noselect` | inverts `selectable` |
| `flammable` / `indestructible` | `burnable` / `!destructable` |
| `reclaimable` (default = `destructable`) | reclaim eligibility |
| `autoreclaimable` (default = `reclaimable`) | area-reclaim eligibility |
| `floating` | rides the water surface instead of the given Y |
| `metal` / `energy` | reclaim yield; also the `reclaimTime` and `mass` defaults |
| `health` (or legacy `damage`) | clamped to ≥ 0.1 |
| `reclaimTime` | default `(metal + energy) * 6` frames |
| `smokeTime` | default 300 |
| `footprintX` / `footprintZ` | ×`SPRING_FOOTPRINT_SCALE` (2) → `xsize`/`zsize` |
| `mass` / `crushResistance` | default `metal*0.4 + health*0.1`, clamped |
| `upright` | orientation on slopes |
| `featureDead` | name of the next link in a death chain, resolved in a second pass |
| `collisionVolume{...}`, `selectionVolume{...}` | see `SolidObjectDef::ParseCollisionVolume` |
| `customParams` | verbatim string map → `custom_params` on the wire |

## Downstream, for free

`Simulation.cpp:264` inits the handler → `LuaDefsSerializer.cpp:255
SerializeFeatureDefs` resolves `model_url` by looking for
`data/games/metalstorm/models/<stem>.gltf` → `FeatureDefInfo`
(client/src/core/connection.ts) → `FeatureRenderer.applyLifecycleBatch`
(client/src/core/feature-renderer.ts). Naming `object` after a shipped forge
model is the whole of the client integration; there is no client-side
registration step.

## Two engine limits these defs are authored around

- **Features cannot animate.** `FeatureRenderer` thin-instances one picked mesh
  per def and has no `AnimationGroup` path at all (contrast `entity-renderer.ts`
  + `clip-auto-policy.ts` for units). `ms_monolith_spire`'s `idle` ring orbit
  and `ms_dig_site`'s `idle` hoist are therefore **static as features**. If
  either ever needs its motion, promote it to a Gaia-team *unit* the way
  `units/buildings_sites.lua` does — do not build feature animation for two
  props.
- **Features cannot be pathable on top.** Spring pathing is single-layer: a
  feature either occupies the blocking map or it does not. The fork's one
  permeability mechanism (`FootprintProfile`'s `underpass` move classes) is
  attached to `UnitDef` only and never consulted for features. See
  `bridges.lua` for what that forces.

## Footprint convention

Same as `units/`: **footprint metres = `footprintX` × 2**
(DESIGN-MODEL-BUILDING.md §4), derived from the shipped glTF's bounds, rounded
to the nearest cell. Overhang above ground contact is fine and expected.

Note the standing metre/elmo ambiguity recorded in DESIGN-MODEL-BUILDING.md
§(render scale): models author at 1 u = 1 m while the sim world is elmos. These
defs follow the unit-def convention exactly so features and units stay
*consistent with each other* whichever way that is finally resolved.
