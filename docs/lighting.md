# Lighting and Shadows

How the sun + ambient + HDR pipeline + cascaded shadows fit together,
and the gotchas you need to know before changing anything.

The implementation is split across three modules:

- [client/src/core/scene-lighting.ts](../client/src/core/scene-lighting.ts) — builds the sun + ambient + HDR pipeline + CSM
- [client/src/core/map-lighting.ts](../client/src/core/map-lighting.ts) — fetches and parses `mapinfo.lua → lighting`
- [client/src/core/entity-renderer.ts](../client/src/core/entity-renderer.ts) — team-color shader with custom CSM sampling

See [PLAN-lighting.md](../PLAN-lighting.md) for the rollout phases. This
doc describes the live state plus the non-obvious traps.

## Pipeline overview

```
mapinfo.lua (per map)
    |
    v
loadMapLighting(gameId, mapId)      map-lighting.ts
    |                                — Fengari Lua eval of mapinfo.lua
    +-> MapLighting { sunDir, unitDiffuse, groundAmbient, ... }
    |
    v
applyMapLighting(lighting, scene)   scene-lighting.ts
    |   — writes sun.direction, sun.diffuse, ambient.*, csm.darkness
    |
    v
DefaultRenderingPipeline (HDR + ACES)
    |
    v
Per-material shadow sampling:
    - StandardMaterial / PBRMaterial   → Babylon's stock CSM integration (PCF mode)
    - teamColor ShaderMaterial         → manual sample of sampler2DArray depth layers
```

Lighting (and all render-only map data) is **client-only** — the server
never sends it. The client fetches `mapinfo.lua` straight from the
content HTTP endpoint and parses it with Fengari.

## HDR pipeline (L1)

`DefaultRenderingPipeline('default', true, scene, [camera])` with
`hdr=true` allocates an RGBA16F intermediate target. Emissive materials
can exceed 1.0 without clipping; the ACES tonemap on output maps the HDR
range back to LDR for display.

Configured once in `createSceneLighting()` and never touched per-map.
Live tuning available via `window.__renderPipeline` in DevTools.

## Sun + ambient (L2)

Recoil's `sunDir` is the direction **FROM the world TO the sun**.
Babylon's `DirectionalLight.direction` is the direction **light
TRAVELS** (away from the sun). `applyMapLighting()` negates accordingly.

For legacy-coord-system maps (`mapinfo.lua` opts in via
`legacyCoordSystem = true` after being detected by the gameconverter),
the Z component additionally flips sign so the apparent sun position
matches the same on-map landmark in both coord systems.

Spring/Recoil splits ambient into `groundAmbient` (terrain shader) and
`unitAmbient` (unit shader). Babylon's single `HemisphericLight` can't
separate these per-material, so we approximate by hemisphere
orientation: `diffuse = groundAmbient` (up-facing terrain), `groundColor
= unitAmbient` (down-facing unit underbellies). Faithful per-material
split is L3+ work.

## Cascaded shadow maps (L3)

`CascadedShadowGenerator(2048, sun)` with 4 cascades, log-uniform splits
(`lambda = 0.85`), stabilised camera movement, PCF filtering. `2048² × 4
= 16 MB` of VRAM. Configured once in `createCsm()`.

```
csm.numCascades = 4
csm.lambda = 0.85                    # 0=uniform, 1=log; 0.85 favours near cascades
csm.stabilizeCascades = true         # anti-shimmer
csm.cascadeBlendPercentage = 0.05
csm.shadowMaxZ = 8000                # tune per map
csm.usePercentageCloserFiltering = true
csm.filteringQuality = QUALITY_HIGH
csm.bias = 0.01
csm.normalBias = 0.02
```

`darkness` is set from the map's `(groundShadowDensity +
unitShadowDensity) * 0.5`, with Recoil's "1.0 = fully black" convention
inverted to Babylon's "0 = fully black".

### Caster registration

Each renderer registers its meshes as casters when they come online:

- [EntityRenderer.setShadowGenerator()](../client/src/core/entity-renderer.ts) registers all unit piece meshes; new units register at piece-mesh creation.
- [DynamicFeatureRenderer.setShadowGenerator()](../client/src/core/feature-renderer.ts) registers dynamic-feature bucket meshes.
- `renderMapFeatures(scene, map, csm)` registers static map-feature meshes.
- Terrain mesh sets `receiveShadows = true` in [main.ts](../client/src/main.ts) after `buildTerrainMesh`.

### Casters/receivers that must be excluded

Overlays that look "part of the ground" but aren't real geometry must
have `receiveShadows = false` and be explicitly removed from the
generator. Otherwise they capture the shadow map and the shadow is
visible on the overlay's plane instead of the terrain below.

- Water mesh — `receiveShadows = false`, `csm.removeShadowCaster(water, false)`
- LOS / fog overlay — same treatment, plus the `FOG_Y_OFFSET = 8`
  elmos in [terrain.ts](../client/src/core/terrain.ts) to avoid
  z-fighting with the heightmap at far zoom.

### customAllowRendering

[scene-lighting.ts:116](../client/src/core/scene-lighting.ts#L116) installs:

```ts
csm.customAllowRendering = (subMesh) => {
    const mesh = subMesh.getRenderingMesh();
    if (mesh.hasThinInstances && mesh.thinInstanceCount === 0) return false;
    return true;
};
```

EntityRenderer / DynamicFeatureRenderer / renderMapFeatures all register
their template meshes as casters **up front**, so newly-spawned units
shadow immediately on their first frame. Until a template gets its
first live instance, though, `thinInstanceCount === 0` and Babylon
would still draw the template geometry at the mesh's origin (`(0,0,0)`
— every template is detached from its parent and reset).

That projects a unit-sized blob from the world origin across the whole
sun-aligned frustum, which is the "giant blocky shadow that appeared
mid-map during boot" bug. The `customAllowRendering` callback skips
those depth-pass draws until the template has real instances.

### Thin-instance bounds

Per-frame `mesh.thinInstanceRefreshBoundingInfo(false)` is called in
the EntityRenderer update loop. Without it, the mesh keeps its
placeholder origin-centric bounds and the CSM treats every caster as
living at world `(0,0,0)`, crushing the cascade Z slab and producing
nonsense depth values (every fragment compares against near-plane = 0
→ terrain reads as fully in shadow regardless of sun).

**Do not** set per-mesh bounds to a giant `BoundingInfo(±1e6, ±1e6,
±1e6)` to "cover everything" — that prevents the cascade fitter from
tightening the projection at all, blowing out shadow-map precision and
producing the same wrong-result symptoms as a too-tight box.

## Material integration (L4)

### Stock Babylon materials (terrain, features, water)

`StandardMaterial` / `PBRMaterial` integrate automatically with the
CSM through Babylon's stock light loop. PCF mode is required because
the standard pipeline uses `sampler2DShadow` and the
`SHADOWCSM_RIGHTHANDED` define handles cascade selection in our RH
scene.

### teamColor ShaderMaterial (units)

The unit shader is a plain `ShaderMaterial` so Babylon's automatic
light binding doesn't fire. We bind the sun + CSM uniforms ourselves:

- `setActiveShadowGenerator(csm, sun)` registers the module-local CSM
  reference.
- `createTeamColorMaterial()` adds an `onBindObservable` callback that
  calls `bindShadowUniforms(mat)` every frame, copying the current
  cascade matrices, splits, depth array, and sun direction onto the
  material.

The fragment shader samples the depth array via `sampler2DArray`
(plain depth, not PCF-compare), picks the smallest cascade whose
`csmSplits[i]` still contains the fragment's `vViewZ`, projects the
world-space position through `csmMatrices[cascade]`, and does a manual
depth compare with a `0.0015` bias. Out-of-cascade / out-of-UV
fragments return 1.0 (unshadowed) so they fall through to the next
cascade or the ambient lighting.

The sun-visibility result attenuates ONLY the directional + specular
terms — the ambient floor stays put, so shadows go darker but not
black, matching how Spring / ZK shaders darken shadowed surfaces.

## ⚠️ Gotcha: thin-instance matrix packing breaks shadow casting

**Do not pack per-instance auxiliary data into a thin-instance world
matrix's normally-zero W-row entries (`arr[7]`, `arr[15]`).**

Babylon's CSM shadow generator renders caster geometry with a stock
depth shader that does

```glsl
gl_Position = viewProjection * (world * vec4(position, 1.0));
```

It does **not** reconstruct `vec4(wp.xyz, 1.0)` before projection.

If you set `arr[7] = groundY` (the Y-basis vector's W component) and
`arr[15] = buildProgress` (the homogeneous W of the translation
column), then for any vertex `position.y != 0` the depth shader
computes

```
wp.w = arr[7] * position.y + arr[15] * 1.0
     = groundY * position.y + buildProgress
```

For a unit at `groundY = 100` with a vertex at `position.y = 10`, that
gives `wp.w = 1001`. After the perspective divide, caster vertices
collapse toward the world origin in light-space NDC. Result: unit
silhouettes in the shadow map are wrong-shape, bidirectional, or
streaky — and the bug only shows up on **shadows**, not the main pass,
because the main pass uses our custom team-color shader which DOES
rebuild `gl_Position` from `wp.xyz`.

This bug burned us once already (mid-May 2026). The previous comment
that justified the packing — "affine transforms always have m30=m31=
m32=0 / m33=1, so packing values there only corrupts wp.w" — was
correct about the main pass but completely wrong about the depth pass.

**The fix:** for per-instance data that needs to ride alongside the
world matrix (build progress, ground Y, team index, ...), use a
separate per-instance vertex attribute via
`thinInstanceSetBuffer('attrName', data, stride, staticBuffer)` rather
than packing into the matrix. The world matrix then stays a clean
affine transform and both passes project correctly.

The build animation in [entity-renderer.ts TEAMCOLOR_VERTEX](../client/src/core/entity-renderer.ts) is currently disabled (the shader holds `vBuildProgress = 1.0`
and `groundY = 0.0`) pending the per-instance attribute plumbing.

## Live tuning hooks

Available in DevTools:

| Global | What |
|--------|------|
| `window.__renderPipeline` | `DefaultRenderingPipeline` — exposure, contrast, tonemap, FXAA |
| `window.__csm` | `CascadedShadowGenerator` — bias, normalBias, lambda, darkness |
| `window.__mapLighting` | Last `MapLighting` applied (parsed `mapinfo.lua`) |
