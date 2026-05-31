# Phase V — consolidated visual-parity audit (in progress)

> Run 2026-05-31 against `?scenario=weapon-showcase` on ZK / green_flat,
> with the build block (Phases R/L/T/U/D/G/F) complete on
> `weapon-fx-tier1`. This is the running record for the
> [PLAN-weapon-fx-gaps.md](../PLAN-weapon-fx-gaps.md) Phase V exit gate.

## Headline finding

**The FX *systems* largely engage; the *capture harness* is not
capture-ready.** The weapon-showcase was built to *watch* weapons, not to
*screenshot* them, and five separate harness issues block clean
per-archetype parity shots (table below). Two archetypes also have real
producer gaps. Until the harness issues are fixed, the side-by-side
column can't be filled reliably — independent of whether the user has
sourced the ZK reference images yet.

## The "645 calls / 4 live" question is resolved

The Z5 smell was **not** a render bug. The weapon-showcase drives
`WG.__lupsAudit.totalAdd = 0` — i.e. the worker **LUPS** system emits
*nothing* for lone showcase units. Every visible weapon effect (laser
bolts, trails, impacts, muzzle flares, dynamic lights, shockwave
distortion) is carried by the **main-thread** systems: `CegRuntime`,
`ProjectileRenderer`, `FxLightPool`, `MuzzleFlareRenderer`,
`DistortionRenderer`, plus the scripted-missile path (`missile_fired`
SendToUnsynced). LUPS is driven by *unit scripts* in busy multi-unit
fights (where the 645 came from), not by the showcase. So the LUPS
per-class instrument (now extended with calls/created/failed/alive — see
below) reads zero here *by design*; the right coverage signal for the
showcase is the new `window.__fx` handle.

## Instrumentation landed this session

- **`WG.__lupsAudit` extended** ([lua-widget-worker.ts](../client/src/core/lua-widget-worker.ts))
  — per-class `calls / created / failed / maxAliveFx / maxAlivePart`,
  plus `_G.SampleLupsAudit()` (folds a `GetStats()` snapshot) and
  `_G.LupsAuditReport()` (returns the per-class verdict string).
  `created>0` ⇒ the FX entered the RenderSequence ⇒ will draw; this is
  the clean "ever-drawn" proxy. (Reads 0 in the showcase per above.)
- **`window.__fx`** ([main.ts](../client/src/main.ts)) — lazy
  `{cegLive, projectiles, fxLights}.snapshot()`; the main-thread coverage
  signal the LUPS instrument can't see.
- **`window.__showcase`** ([weapon-showcase.ts](../client/src/scenarios/bench/weapon-showcase.ts))
  — `{index, key, phase, total, enteredAt}` so a capture driver syncs to
  the active archetype instead of guessing at dwell timing.

## Per-archetype audit table

| Archetype | ZK unit | Fired? | Main-thread FX observed | Our shot | Gap category |
|---|---|---|---|---|---|
| lasercannon | Bandit | ✅ | CEG ~18, **2 persistent bolts** | **CLEAN** `ours_lasercannon.png` | (d) plausible — confirm vs ZK |
| beamlaser | Gremlin | ✅ | lights ~3 | unit framed; **1-tick beam not caught**, AA target aerial/off-frame | (c) capture-timing + framing |
| cannon | Big Bertha | ❌ | none (0 / 50 s) | empty — **never fired** | (a) producer not firing (static power-gate, bench) |
| starburst | Impaler | ? | not sampled | not captured | pending harness |
| nuke | Trinity | ⚠️ intermittent | **detonation CEG = 51 confirmed** | flaky launch (stockpile); impact-cam frames map void | (a flaky) + (c framing) |
| missile | Magpie | ✅ | CEG ~14 trail + lights ~4 (scripted `missile_fired`) | FX present, mis-keyed capture | (d) present; coverage nuance |
| lightning | Felon | ✅ | lights ~3 | **both units framed** (tracking-off fix); 1-tick bolt not caught | (c) capture-timing |
| dgun | Ultimatum | ✅ (server log) | **0 projectiles streamed** | empty — fired but no client projectile | (a/b) **FLAG: fired, nothing rendered** |
| flak | Thresher | ? | not sampled | not captured; AA aerial | pending harness |
| ground-to-air | Flail | ? | not sampled | not captured; AA aerial | pending harness |
| air-to-air | Swift | ? | not sampled | not captured; AA aerial | pending harness |

## The five capture-harness blockers (the real remaining Phase V work)

1. **Shooter-tracking pushes the target off-frame.** `fireOneEntry`
   leaves the tracking camera on the *shooter*, which re-centres every
   frame and pushes the target — and the bolt/beam/projectile path to it
   — off-screen. *Fix proven live:* `inputManager.setTrackingCamera(false)`
   + frame the **shooter↔target midpoint** wider. With this, lightning's
   Felon+target both framed.
2. **1-tick hitscan FX are unscreenshootable.** Beam-laser and lightning
   render for **one sim tick** ([projectile-renderer.ts:15](../client/src/core/projectile-renderer.ts#L15));
   the muzzle light (`fxLights`) lingers longer, so `fxLights>0` does
   *not* mean the bolt is on-screen this frame. Needs **pause-on-fire**:
   freeze the sim the tick the bolt streams, then screenshot.
3. **Static power-gated weapons don't fire in the bench.** Big Bertha
   (`staticheavyarty`) produced zero FX for a full 50 s dwell — the
   `current_energyIncome`/`lowpower` unit-rules hack doesn't actually
   power its weapon. (AA turrets `flak`/`ground-to-air` likely the same.)
4. **Impact-cam framing misses the detonation.** The nuke's CEG burst
   *fires* (51 live particles) but the impact-cam pans to a point that
   frames the **map-edge void**, not the column. Per-archetype impact-cam
   targets need re-tuning, or frame the actual streamed impact position.
5. **Nuke stockpile timing is flaky.** Sometimes launches within the
   dwell, sometimes not (caught both a detonation and a no-launch this
   session). Needs a deterministic insta-stockpile verb (already an open
   ask in `project_weapon_showcase_handoff`).

## Two real producer gaps (not harness)

- **`cannon` / Big Bertha — does not fire** (blocker #3). Confirm whether
  this is purely the bench power-gate or also affects real games.
- **`dgun` / Ultimatum — fires but streams no projectile.** Server logs
  the shot (`weapon 0 … firing from unit centre`) yet
  `ProjectileRenderer.live.size` stays 0 the whole dwell. The
  Disintegrator projectile is either not streamed (envelope 0x04) or not
  rendered. **Highest-value follow-up** — a genuine missing weapon visual.

## What's confirmed *working* (FX-system side)

- Persistent projectiles render and look right: **lasercannon** bolts are
  bright-cored, velocity-stretched (Phase F laser-fade + Phase T stretch
  orientation visibly landed).
- **Nuke detonation** produces a dense CEG burst (51 live particles —
  Phase T cap-lift working).
- **Missile** (Magpie) trail + muzzle lights fire via the scripted path.
- **Muzzle/impact dynamic lights** (`fxLights`) fire on laser/beam/
  lightning/missile (Phase L/U pool live).

## Next steps

1. **Build a showcase capture mode** (`&capture=1`): tracking off, frame
   shooter↔target midpoint wide, pause-on-fire for hitscan, fix static
   power-gating + impact-cam targets + insta-stockpile. One slow run then
   yields clean shots for all 11. *(This is the gating item.)*
2. Root-cause the **dgun no-projectile** gap.
3. Once the user drops `ref_<key>.png` images into the folders here,
   re-capture `ours_<key>.png` framed to match each reference's angle and
   fill the side-by-side / gap-category verdict per archetype.
