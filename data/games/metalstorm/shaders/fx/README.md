# Metalstorm FX shaders (`shaders/fx/`)

Native **WebGL2 / GLSL ES 3.00** special-effect programs for Metalstorm weapons,
explosions, and projectiles. Authored directly for this engine per
[PLAN-metalstorm.md](../../../../PLAN-metalstorm.md) §9 — **no GL4 features, no
Babylon shader-processor includes, no CEG translator dependency**. They are the
kinetic-weapon analogues of the shipped BAR/ZK client effect shaders
(`client/src/core/shaders/*.ts`), which they are modelled on line-for-line where
the technique carries over.

All twelve files validate clean under `glslangValidator` as GLSL ES 3.00.

## The programs

| Files | Program | Based on (BAR/ZK) | Used for |
|---|---|---|---|
| `particle.vert/frag.glsl` | GPU-integrated billboard/ground/stretch particle | `ceg-particle.ts` | explosions, smoke, sparks, dust, scorch, muzzle heat — the workhorse |
| `muzzle-flash.vert/frag.glsl` | camera-facing flash billboard | `muzzle-flare.ts` | gun muzzle flash on `weapon_fired` |
| `tracer.vert/frag.glsl` | stretched camera-billboarded streak, HDR core | `projectile-beam.ts` + `projectile-laser.ts` | autocannon/MG tracers, railgun/dreadnought rail slug |
| `trail.vert/frag.glsl` | camera-facing ribbon segment, per-end alpha | `projectile-trail.ts` | missile/bomb smoke plumes, torpedo bubble wakes |
| `shockwave.vert/frag.glsl` | expanding-ring signed-UV-offset emitter | `distortion.ts` (emitter) | heat-haze/shockwave of big blasts → offset target |
| `shockwave-composite.frag.glsl` | full-screen warp of the scene by the offset | `distortion.ts` (composite) | applies the accumulated distortion |
| `fullscreen-tri.vert.glsl` | `gl_VertexID` full-screen triangle | — | reusable vertex for the composite / any post pass |

## Shared conventions

- **Birth-state, GPU-resident.** Every transient program uploads a particle's
  *birth state* once (on spawn) as per-instance attributes and integrates
  `age = uNow - birthTime` on the GPU each frame; the CPU never touches a live
  particle again. Dead / unborn / free slots self-cull by emitting an off-screen
  clip vertex (`gl_Position = vec4(2,2,2,1)`). This is the model
  [PLAN-fx-offload.md](../../../../PLAN-fx-offload.md) §5 mandates (JS owns only
  lifecycle: spawn, retire, budget-cull).
- **Additive, premultiplied.** Fragments output premultiplied colour and pair
  with `blendFunc(ONE, ONE)`; a faded particle contributes nothing and an FX
  quad can never *darken* the scene. HDR tints (>1) are intentional — the
  ACES + bloom pipeline (PLAN-lighting L1) blows explosion / rail cores to white.
  No FX point-lights (faithful to ZK — see `client/src/core/fx-light-pool.ts`).
- **Depth:** test ON, write OFF for world FX. `particle.frag.glsl` also does a
  soft-particle depth fade against an opaque-scene depth pre-pass (`uSoftRange`;
  ≤0 disables) to kill the cardboard-intersection seam.

## Per-instance attribute layouts (what the JS uploader must pack)

Base quad for all billboard programs: `aCorner` in `[-0.5,0.5]` (loc 0),
`aUV` in `[0,1]` (loc 1). Instance streams use `vertexAttribDivisor(…, 1)`.

**particle** (locs 2–8, 7×vec4):
```
iPosLife  = (birthPos.xyz, lifetime)      lifetime<=0 → free slot
iVelTime  = (birthVel.xyz, birthTime)
iSize     = (sizeStart, sizeEnd, gravity, stretch)
iRot      = (rotBase, rotSpeed, orient, animFps)   orient 0=BB 1=GROUND 2=STRETCH
iAnim     = (animFrameStart, animFrameCount, _, _)
iColStart = colourStart RGBA      iColEnd = colourEnd RGBA
```
Uniforms: `uViewProj`, `uNow`, `uCamPos`, `uAtlasCols`, `uAtlasRows`;
frag: `uParticleTex`, `uAtlasDimsInv`, `uDepthTex`, `uCamNearFar`, `uScreenSize`, `uSoftRange`.

**muzzleFlash** (locs 2–4): `iPosLife=(pos.xyz,lifetime)`, `iBirth=(birthTime,size,spin,seed)`, `iColor=RGB+peakA`.

**tracer** (locs 2–5): `iHeadLife=(headPos.xyz,lifetime)`, `iVelTime=(vel.xyz,birthTime)`, `iShape=(length,width,coreBoost,taper)`, `iColor=RGB+peakA`. `coreBoost`/`taper` are per-instance (carried to the fragment), so **one tracer program batches every style** in a single draw. Frag uniforms: optional `uColorScale`, `uTex`/`uHasTex`. The renderer refreshes `headPos` each frame for a projectile-following tracer; a fire-and-forget spark lets the lifetime fade carry it.

**trail** (locs 2–4): `iP1=(pos1.xyz,width1)`, `iP2=(pos2.xyz,width2)`, `iUVAlpha=(uMin,uMax,a1,a2)`. One segment instance per node pair. Frag: `uTrailTex`, `uTint`.

**shockwave** (locs 1–2, `aCorner` at loc 0): `iPosLife=(centre.xyz,lifetime)`, `iParams=(birthTime,maxRadius,strength,_)`. Renders into an `RGBA16F` offset target with additive blend; `shockwave-composite` then samples `uScene` at `vUV + uOffset.rg * uStrength`.

## Wiring (live — PLAN-beta-presentation.md L-FX steps 1–4)

These shaders run in the game. The loader is
`client/src/core/native-fx/fx-game-loader.ts`, built at game start by
`game-processor.ts` and best-effort: a game that ships no `effects/` library
gets `null` back and every dispatch site keeps its existing CEG path.

1. **Load.** `loadFxGameAssets` fetches all twelve `shaders/fx/*.glsl`, then
   `effects/library.json`, `weapon-fx.json` and `unit-fx.json` over the game
   VFS at `/api/games/data/<game>/…` — the same tree and the same order as the
   `fx-viewer` scenario's `loadFxAssets`. The atlas is the procedural
   placeholder (`native-fx/fx-atlas-placeholder.ts`, shared with the stage,
   baked on an `OffscreenCanvas` in the worker) unless
   `unittextures/fx_atlas.png` exists, which is probed first and decoded with
   `createImageBitmap`. No ktx2: the worker has no transcoder.
2. **Programs + pools.** `NativeFxRenderer` compiles the programs and owns the
   ring-buffered instance VBOs against Babylon's own WebGL2 context
   (`getEngineGl`). Unchanged from the fx-viewer stage — it is the same class.
3. **Draw.** `NativeFxGamePass` hooks `scene.onAfterRenderingGroupObservable`
   for the last rendering group and calls
   `NativeFxRenderer.renderInto(gl, viewProj, now, depthTex, params)`, which
   draws ONLY the additive FX passes into the framebuffer Babylon already has
   bound — no clears, no render targets, no composite. GL-state discipline is
   the LuaUI raw-GL pass's, verbatim (`game-processor.ts` `gpRunUiPass`): draw,
   `bindVertexArray(null)`, `engine.wipeCaches(true)`. Because the pass lands
   inside the scene, the FX are depth-tested against the world and go through
   the HDR pipeline's bloom/tonemap with it.
4. **Effects.** `effect-compiler.ts` expands a library name into rows;
   `client/src/core/weapon-fx-resolver.ts` resolves a weapon def to slots
   (exact → `defaults[weapontype]` → `__fallback`, case-insensitively — the
   engine lowercases def names). Dispatch is one branch at each existing site
   in `combat-fx.ts` (`onCombatEvents`, `onVolleyOutcome`,
   `onProjectileImpacts`) and `projectile-renderer.ts` (`onFired`,
   `onImpact`): **a def that authors no CEG and resolves here draws natively
   and returns; anything else keeps the ceg-runtime path** — so maps, features
   and the ZK/BAR games are untouched. Statistical volleys have no projectile,
   so the pass invents `rounds` tracer copies in a ±3° cone spread over 0.4 s,
   plus a dim 80 ms muzzle light through `FxLightPool` (gated by
   `gfx.fxLights`). An impact with an authored `impact` effect also raises a
   ground scar through the decal overlay's existing `onSnapshot(scars, …)`.

**Not wired (deliberate, beta scope).** Soft particles — `uSoftRange = 0`, no
depth copy; a `DepthRenderer` copy is a High-preset item later. The native
`shockwave*` + `shockwave-composite` pair stays **stage-only**: the game
composites shockwaves through `distortion-renderer.ts`, and the offset pass
needs render targets the in-scene pass deliberately does not allocate.
Projectile-attached `trail` ribbons and `unit-fx.json` (`unit-fx-dispatch.ts`)
are later L-FX steps; the trail pool exists and draws, nothing streams it yet.

Tuning still happens in the `fx-viewer` scenario — it is the authoring loop,
and it drives this exact renderer against the same authored files.
