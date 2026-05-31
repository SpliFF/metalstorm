# Weapon/explosion rendering — the real ZK architecture (2026-05-31)

Cross-checked both directions: the **Recoil engine** source
(`/Users/shannon/WarriorHut/Projects/RecoilEngine/`) and **ZK content**
(`content/games/zk/`). This settles "is it CEG / is it LUPS / is it
custom" and scopes the faithful port.

## ZK weapon/explosion FX is a 3-layer hybrid

### Layer 1 — the beam/bolt/lightning geometry is **engine C++**, NOT Lua

LaserCannon, BeamLaser, LargeBeamLaser, LightningCannon, Cannon/plasma,
Missile, Starburst are drawn by the engine's C++ `ProjectileDrawer`
(`rts/Sim/Projectiles/WeaponProjectiles/*` + `rts/Rendering/Env/Particles/
ProjectileDrawer.cpp`), reading each weapon's **`WeaponDef.visuals`**.
**ZK does not replace this.** The per-weapon variety you spotted — thin
white beam vs. thick internally-striped cyan beam vs. branching yellow
lightning — comes entirely from per-def `WeaponDef.visuals`:

- `color` (edge) + `color2` (core), `thickness` + `corethickness`
- `tilelength` + `scrollspeed` (the thick beam's internal stripes =
  LargeBeamLaser tiled scrolling texture), `pulseSpeed`, `beamdecay`,
  `laserflaresize`
- textures `laserfalloff` / `laserend` / `largebeam` / `muzzleside`
- blend `GL_ONE, GL_ONE_MINUS_SRC_ALPHA` (premultiplied additive glow)
- lightning = jagged 10-segment **double-traced random-walk** zigzag

So: **CEG is not the beam, and LUPS is not the beam.** The "different
colours/thickness/roughness" is engine projectile rendering off
per-weapon data.

### Layer 2 — explosions + trails are **engine CEG** (not legacy, not custom render)

ZK ships **~215 CEG definitions** (`content/games/zk/effects/*.lua` —
`beam.lua`, `plasma_hit_*`, `lightning_*`, `nuke_*`, missile trails…).
These run on the engine's built-in CEG classes (`CSimpleParticleSystem`,
`groundflash`, `explspike`) — **not** custom Lua rendering. Weapons wire
them via `cegTag` (in-flight trail) + `explosionGenerator` (impact).
**CEG is the active, correct path** — our client CEG runtime (935 CEGs
registered) is right; CEG is *not* a legacy path to replace.

### Layer 3 — ZK Lua **augments** (it adds on top; it does not replace Layers 1–2)

- **`gfx_projectile_lights.lua`** (+ `deferred_lights_gl4.frag.glsl`) —
  deferred shader **lights for every projectile**, tuned per weapon via
  `customParams.light_*` (color/radius/beam_mult/fade…). This is the
  "ground lit in weapon colour" AAA cue. → our **FxLightPool** (Phase L/U)
  is the forward substitute; it could read ZK's `light_*` customParams to
  be faithful.
- **`lups_shockwaves.lua`** (+ LUPS `ShockWave`/`SphereDistortion`) —
  expanding warp ring on big explosions (AoE>70 or DGun). → our
  **DistortionRenderer** (Phase D) is the forward substitute.
- **LUPS `NanoLasers`** — nano/repair beams (shader particle class). Not a
  combat weapon.
- **Unit LUPS FX** (jets/shields/glow via `gfx_lups_manager.lua`) — units,
  not weapons.

**Your hypothesis, reconciled:** you were right that ZK layers custom Lua
FX on top (lights + shockwaves + nano), and those matter for the look. But
the *core beam/lightning geometry variety* is engine `WeaponDef.visuals`,
not LUPS; and CEG is the live explosion/trail system, not a legacy path.

## Where OUR client is unfaithful to Layer 1 (the concrete gaps)

Our `ProjectileRenderer` reimplements the engine projectile draw at
~75–85% fidelity. Confirmed gaps:

| Gap | Engine field / behaviour | Our client now | Fix tier |
|---|---|---|---|
| **Beam width wrong** | `thickness` (sent!) | beam builder ignores it, uses a `size×2` heuristic | **bug — low** |
| Beam tiling not per-def | `tilelength` | hardcoded `200` | wire field |
| Beam decay ramp | `beamdecay` | age-based shader fade | wire + shader |
| Laser end flare | `laserflaresize` | none (muzzle flare is procedural) | wire + geometry |
| Flame/Cannon sprites | `texture1` sprite (sent!) | **procedural spheres**, texture ignored | renderer |
| Flame expansion | `sizeDecay` | static size | wire + loop |
| Explosive multi-stage | `stages`/`alphaDecay`/`sizeDecay` | single billboard | wire + geometry |
| Muzzle flare size | `muzzleFlareSize` | procedural radial, no per-def size | wire |
| Smoke trail tuning | `smokePeriod/Time/Size` | hardcoded cadence | wire |
| Projectile lights tuning | `customParams.light_*` | FxLightPool ignores them | customParams read |

**Fields NOT on the wire today** (server `LuaDefsSerializer.inl` doesn't
emit them): `tilelength`, `laserflaresize`, `beamdecay`, `alphaDecay`,
`sizeDecay`, `pulseSpeed`, `stages`, `muzzleFlareSize`, smoke params,
`customParams.light_*`. `thickness`/`corethickness`/`color2`/`scrollspeed`
**are** sent — the beam bug is that the builder doesn't use `thickness`.

## Faithful-port plan (proposed — "Phase W: engine projectile fidelity")

1. **W1 — wire the missing `WeaponDef.visuals` fields** (server
   `LuaDefsSerializer.inl` + client `WeaponDefInfo`/`defs-fetch.ts`):
   tilelength, laserflaresize, beamdecay, alphaDecay, sizeDecay,
   pulseSpeed, stages, muzzleFlareSize, smoke params. *(low effort,
   unblocks everything; needs defs-cache clear + server rebuild.)*
2. **W2 — fix the beam-thickness bug**: use sent `thickness` instead of
   the `size×2` heuristic. *(immediate fidelity win.)*
3. **W3 — load real engine projectile textures everywhere**, incl. sprite
   billboards for Flame/Cannon (stop using procedural spheres). Textures
   already exist in `data/engine/bitmaps/` (laserfalloff/laserend/
   largelaserfalloff/flame…).
4. **W4 — match geometry per projectile type to the engine Draw methods**:
   two-layer beam (start/mid/end quads), LargeBeam tiled-scroll + pulsing
   muzzle, lightning 10-seg double-trace, Explosive multi-stage billboards,
   Starburst tracer ring.
5. **W5 — faithful blend**: premultiplied `GL_ONE, GL_ONE_MINUS_SRC_ALPHA`
   across the projectile shaders.
6. **W6 (Layer-3 fidelity, optional)**: FxLightPool reads
   `customParams.light_*`; DistortionRenderer gated like `lups_shockwaves`
   (AoE>70 / DGun).

Sequence: W1→W2→W3 are the high-ROI foundation (wire + bug + textures);
W4 is the bulk; W5/W6 polish. This *replaces* the Phase-F custom
approximations with faithful ports where they overlap (per the
"replace, don't parallel" directive).

## Progress (2026-05-31) — BeamLaser template DONE + validated

Chose BeamLaser as the end-to-end template (per user). Landed + validated
live against a real ZK beam:

- **W1 (beam fields wired):** added `laser_flare_size` + `beam_decay` to
  `rts/Server/LuaDefsSerializer.inl`; client `WeaponDefInfo` +
  `defs-fetch.ts`. Server rebuilt, defs cache cleared, confirmed the
  fields arrive (`laserFlareSize`/`beamDecay` present on the live def).
- **W2 (thickness bug):** `buildBeamVisual` now uses the wired `thickness`
  (was a `size×2` heuristic).
- **Two-layer beam:** added a core layer (`color2`, half-width
  `thickness×corethickness`) over the edge layer (`color`, thickness) —
  Recoil's `beamEdgeSize`/`beamCoreSize` quads. This is the big win: the
  bright white core line inside the coloured glow.
- **Texture roles fixed:** both caps now use `texture2` (laserend);
  `texture3` is the muzzle flare (was mis-used as the end cap).
- **Muzzle flare:** camera-facing `texture3` billboard at the start point,
  size `thickness×laserFlareSize`, drawn only when `laserFlareSize > 0`
  (faithful — most plain beams ship 0 and the engine draws none either).
- **Blend:** premultiplied additive (`alphaMode 7`) across both layers.

**Validated:** live ZK beam now renders as a cyan edge + white core shaft
with soft `largelaser` falloff + cap glow (`ours_beamlaser.png`) — vs. the
prior empty/single-layer capture. Type-clean, server builds.
(Capture used a temporary 3 s beam-life floor to beat the screenshot
round-trip; reverted to 0.12 s after — appearance identical, only
persistence differed.)

**Remaining beam fidelity:** LargeBeamLaser tiled-scroll *striping* (the
thick internally-textured beam, `ref_strider_beam`) + its `texture4` flare
(serializer sends only texture1–3); beam-intensity/bloom tuning vs the
very-bright thin references.

**Next:** replicate the template across LaserCannon (closest already),
LightningCannon (10-seg double-trace), Cannon/Explosive (multi-stage
billboards + real sprite texture), Missile/Starburst.
