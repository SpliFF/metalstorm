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

## Wiring (engine ask — Stage 7, currently gated)

The region-overlay stub next door is likewise unwired pending Stage 7. To bring
these online, the render worker needs one small native-game FX loader that mirrors
what `registerCegParticleShader()` et al. do for the Babylon path:

1. **Load + register.** Read each `shaders/fx/*.glsl` from the game VFS and
   compile a raw WebGL2 program per pair (no Babylon `ShaderStore` rewrite —
   these are already `#version 300 es`). One VAO per program with the base quad +
   instance divisors above.
2. **Instance pools.** Ring-buffer instance VBOs per program (particle pool
   sized to the PLAN-fx-offload budget: 50 k global, 8 emitters/unit,
   distance-culled). `orphan → subData` each frame with the live rows.
3. **Effect system.** Compile `effects/library.json` name → emitter configs
   (see `effects/README.md`); resolve weapon slots through `effects/weapon-fx.json`;
   drive spawns from `combat-fx.ts` (impacts/kills) and the fx-offload §2 binding
   interpreter (`weapon_fired` → muzzle, etc.). `combat-fx.ts` already routes
   ZK/BAR impacts through a name → runtime dispatch; Metalstorm adds a parallel
   resolver reading `weapon-fx.json` instead of `def.explosionGenerator`.
4. **Offset target + composite.** Allocate the `RGBA16F` distortion target, draw
   `shockwave` instances additively into it, then run `fullscreen-tri` +
   `shockwave-composite` as a post pass over the scene colour.

Until that loader lands these files are inert authored assets — exactly like the
`region-overlay` and `sounds.lua`/`resources.lua` stubs — and safe to sit in the
tree. Tuning happens against the render harness (PLAN-model-harness.md), which
already has capability-derived `fire`/`explode` showcase buttons.
