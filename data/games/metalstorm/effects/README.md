# Metalstorm effect library (`effects/`)

The **data** half of the Metalstorm FX system: named effect definitions and the
weapon→effect resolution map. The **shader** half lives in
[`../shaders/fx/`](../shaders/fx/README.md). Together they are the kinetic-weapon
analogue of the BAR/ZK authored-CEG content (PLAN-metalstorm.md §6), built the
native way ([PLAN-fx-offload.md](../../../../PLAN-fx-offload.md): GPU particles,
JS-managed lifecycles, effects referenced by name).

| File | Role |
|---|---|
| `library.json` | Named effect definitions → emitter configs (fx-offload **X3** source of truth). 27 effects covering every weapon family. |
| `weapon-fx.json` | Weapon def → `{muzzle, projectile, trail, impact, fireSound, impactSound}`. The data analogue of `client/src/core/weapon-fx-dispatch.ts`. 30 weapons + type defaults + fallback. |
| `bindings.example.json` | Per-unit binding template (fx-offload **§2** format) for `weapon_fired`/`killed`/loop-sound choreography. |

Everything is validated: JSON parses, and every effect/sound name referenced in
`weapon-fx.json` and `bindings.example.json` resolves to a real entry in
`library.json` / `gamedata/sounds.lua`.

## Effect library schema (`library.json`)

Top level: `atlas` (one shared FX sprite sheet — `cols`/`rows`/named `frames`;
registered in `gamedata/resources.lua`) and `effects` (the name → definition map).
Each effect has a `usage` hint (`muzzle`/`projectile`/`trail`/`impact`) and either
an `alias` (→ another effect) or an `emitters` list. Each emitter's `shader` picks
one program in `../shaders/fx/`, and its fields become per-instance rows.

**particle emitter fields** (→ `particle.vert/frag.glsl`):

| Field | Meaning |
|---|---|
| `count` | particles to spawn (int, or `[min,max]`) |
| `sprite` | atlas frame name → `animFrameStart` |
| `animFrames`, `animFps` | flipbook over life (optional) |
| `orient` | `"billboard"` \| `"ground"` \| `"stretch"` → `iRot.z` 0/1/2 |
| `life` | `[min,max]` seconds → `lifetime` |
| `size` | `[start,end]` elmos → `iSize.xy` |
| `speed` | `[min,max]` initial radial speed; `0` = static |
| `spread` | emission shape: `"sphere"`, `"hemisphere"`, `"disc"`, `"cone:<deg>"` |
| `gravity` | elmo/s² → `iSize.z` (negative = buoyant smoke rise) |
| `stretch` | length/width for `stretch` orient → `iSize.w` |
| `rot` | `[base,speed]` → `iRot.xy` (optional) |
| `colorStart`,`colorEnd` | linear **HDR** RGBA (>1 blooms) → `iColStart`/`iColEnd` |
| `delay` | seconds after trigger (staged/composite bursts; optional) |

Other emitters carry the field set their shader needs — `muzzleFlash`
(`size`,`color`,`life`,`spin`); `tracer` (`length`,`width`,`coreBoost`,`taper`,
`color`,`life`); `trail` (`sprite`,`width:[head,tail]`,`tileLength`,`nodeInterval`,
`life`,`tint`,`alpha:[head,tail]`,`rise?`); `shockwave` (`maxRadius`,`strength`,
`life`). See `../shaders/fx/README.md` for the exact attribute packing each maps to.

> **Note — fields the analytic shader does *not* model:** `particle` integrates
> position from birth state with gravity only (no per-frame drag/turbulence, to
> stay CPU-free — same limitation as `ceg-particle.ts`). If a future effect needs
> drag or curl-noise motion, add it as a shader term, not a per-frame CPU pass.

## Resolution order (the client FX dispatch reads this)

For a firing/​impacting weapon, resolve each slot as: exact `weapons[<name>]` entry
→ `defaults[<weapontype>]` → `__fallback`. `null` in a slot = render nothing for
that slot. `impact` always resolves to *something* (`__fallback.impact =
__default_explosion`, aliasing `expl_small`) so no weapon is silent — the same
guarantee `combat-fx.ts` makes with `__default_explosion`.

## How it plugs in (advisory for the engine/other session)

- **X3 effect compiler:** load `library.json`, expand each emitter into a spawn
  descriptor (resolve `spread`/`life`/`size` ranges at spawn to concrete
  per-instance rows), push into the shader's instance pool. Aliases and
  `__default_explosion` resolve here.
- **Dispatch:** a Metalstorm resolver reading `weapon-fx.json` sits beside
  `weapon-fx-dispatch.ts`. On `ProjectileImpact` / `CombatEvent`, `combat-fx.ts`
  calls it (instead of `def.explosionGenerator`) to get the `impact` effect +
  `impactSound`; on `weapon_fired`, the binding interpreter (fx-offload **X4**)
  gets `muzzle` + `fireSound`; the projectile renderer attaches `projectile`
  (tracer) and streams `trail`.
- **Sounds:** `fireSound`/`impactSound` are `gamedata/sounds.lua` SoundItem keys,
  played through the existing 96-voice HRTF pool (PLAN-audio.md); event one-shots
  ride the bindings' `onEvent`, faithful to fx-offload §6.
- **Budgets:** the JS pool enforces the PLAN-client-entity budgets (8 emitters/
  unit, 50 k global, distance cull); `library.json` counts are per-spawn, not
  per-frame.

STUB status: shapes are deliberately plausible, numbers are placeholders. Tune
against the render harness (PLAN-model-harness.md `explode`/`fire` showcase),
never for balance.
