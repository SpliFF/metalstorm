# Client-Side Rendering Events

Draw/Render events were removed from the C++ server event system (headless — no rendering) and migrated to the JS/TS browser client. This document tracks the migration status of each event.

## Implemented

These callins are dispatched by the client widget system:

| Event | Dispatched by | Notes |
|-------|---------------|-------|
| DrawGenesis | `lua-widget-worker.ts` | Per-frame init hook |
| DrawScreen | `lua-widget-worker.ts`, `lua-widget-host.ts` | 2D UI overlay, Y-up ortho projection |
| DrawWorldPreUnit | `lua-widget-host.ts` | World-space rendering after Babylon terrain/units |
| DrawWorld | `lua-widget.ts` | Defined, not actively dispatched yet |

Input callins (KeyPress, MousePress, etc.) are handled via message passing in `lua-widget-worker.ts`.

## Not Yet Implemented

These events exist in Spring/Recoil for Lua widgets but have no client-side dispatch yet. Implement as needed by hooking into the Babylon.js render pipeline.

### Rendering pipeline hooks

| Event | Purpose | Babylon hook point |
|-------|---------|-------------------|
| DrawWater | Custom water rendering | Water material |
| DrawSky | Custom skybox | Skybox |
| DrawSun | Custom sun/light | Light system |
| DrawGrass | Custom grass | Terrain detail |
| DrawTrees | Custom trees | Feature renderer |
| DrawWorldPreParticles | Before particle pass | Particle system |
| DrawWorldShadow | Shadow pass | Shadow generator |
| DrawShadowPassTransparent | Shadow transparent pass | Shadow generator |
| DrawWorldReflection | Reflection pass | Reflection probe |
| DrawWorldRefraction | Refraction pass | Refraction texture |
| DrawGroundPreForward | Before ground forward | Terrain renderer |
| DrawGroundPostForward | After ground forward | Terrain renderer |
| DrawGroundPreDeferred | Before ground deferred | Deferred pipeline |
| DrawGroundDeferred | Ground deferred pass | Deferred pipeline |
| DrawGroundPostDeferred | After ground deferred | Deferred pipeline |
| DrawUnitsPostDeferred | After units deferred | Unit renderer |
| DrawFeaturesPostDeferred | After features deferred | Feature renderer |
| DrawPreDecals | Before decals | Terrain decals |
| DrawWaterPost | After water | Water material |

### Screen/UI hooks

| Event | Purpose | Implementation point |
|-------|---------|---------------------|
| DrawScreenEffects | Screen-space effects | Post-processing pipeline |
| DrawScreenPost | After screen render | Post-processing pipeline |
| DrawInMiniMap | Minimap overlay | Minimap component |
| DrawInMiniMapBackground | Minimap background | Minimap component |
| DrawLoadScreen | Loading screen | Lobby UI |

### Per-entity draw hooks

| Event | Purpose | Implementation point |
|-------|---------|---------------------|
| DrawUnit | Per-unit custom draw | Entity renderer |
| DrawFeature | Per-feature custom draw | Feature renderer |
| DrawShield | Shield visual | Shield effect |
| DrawProjectile | Custom projectile draw | Projectile renderer |
| DrawMaterial | Custom material | Material system |

### Lua render pass hooks

| Event | Purpose |
|-------|---------|
| DrawOpaqueUnitsLua | Lua-driven opaque unit rendering |
| DrawOpaqueFeaturesLua | Lua-driven opaque feature rendering |
| DrawAlphaUnitsLua | Lua-driven alpha unit rendering |
| DrawAlphaFeaturesLua | Lua-driven alpha feature rendering |
| DrawShadowUnitsLua | Lua-driven shadow unit rendering |
| DrawShadowFeaturesLua | Lua-driven shadow feature rendering |

### Entity lifecycle notifications

In our architecture the client learns about entity creation/destruction from the state stream, so these aren't needed as separate events. Widgets that need creation/destruction hooks should listen to the entity state stream instead.

| Event | Spring purpose | Client equivalent |
|-------|---------------|-------------------|
| RenderUnitCreated | Unit visual created | Entity state stream |
| RenderUnitDestroyed | Unit visual destroyed | Entity state stream |
| RenderFeatureCreated | Feature visual created | Entity state stream |
| RenderFeatureDestroyed | Feature visual destroyed | Entity state stream |
| RenderProjectileCreated | Projectile visual | Projectile state stream |
| RenderProjectileDestroyed | Projectile visual | Projectile state stream |

### UI/Camera events

| Event | Purpose |
|-------|---------|
| ActiveCommandChanged | Command UI updated |
| CameraRotationChanged | Camera rotation |
| CameraPositionChanged | Camera position |
| MiniMapRotationChanged | Minimap rotation |
| MiniMapStateChanged | Minimap window state |
| MiniMapGeometryChanged | Minimap size/position |
| FontsChanged | Font reload |
| AllowDraw | Frame skip control |
| ViewResize | Window resize (Babylon handles this) |
