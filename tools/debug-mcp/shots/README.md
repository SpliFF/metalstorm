# capture_subject acceptance shots

Six images, all taken **hands-off by `capture_subject`** on a live
`meridian_basin` room (metalstorm, lane stack, 2026-08-29). No hand-written
camera math, no retries, no "the sim moved between the two calls": each is one
MCP call that resolved the subject, framed it from the subject's own model
bounds, paused the sim, captured a presented frame and checked the luminance
before returning. Every one came back `capture: OK` on the **first attempt**.

They exist to close two standing on-screen debts, which is also the acceptance
test for the primitive itself.

## Debt A — world-scale (PLAN-world-scale.md, "the only item still open")

`worldscale-ladder-tq.jpg` (three-quarter) and `worldscale-ladder.jpg` (low).
Four defs spanning an order of magnitude, spawned on one flat strip and framed
together, with the map's **own feature corpus as the independent terrain
reference** — those trees are authored at 1 unit = 1 elmo (`tree_broadleaf`
11.7 m, `tree_conifer` 13.1 m, PLAN-world-scale §2c) and were never touched by
the ×8 re-import.

| def | authored | `capture_subject` reported (sphere diameter) |
|---|---|---|
| `ms_soldiers_s1` | ~2 m infantry | **2.0 m** |
| `ms_tanks_s2` (`fable_tank`) | 9.02 m long | **11.5 m** |
| `ms_tanks_s4` (`fable_heavy`) | 17.41 m long | **22.5 m** |
| `ms_habitat` | 24 × 24 m footprint, model 25.5 × 24.4 | **42.4 m** |

Sphere diameter is the model AABB's circumscribed sphere, so it runs above the
longest edge — the ratios are what matter, and they are right. The eyeball
half: in the three-quarter shot the habitat stands about **twice a broadleaf's
height**, and the heavy tank is a little longer than a tree is tall. Had the ×8
never been applied, the same models against the same untouched trees would be
**one eighth** of what you see — the habitat would be knee-high to the
undergrowth. It is not. The re-import (landed `592f07e497`) is confirmed on
screen.

**What this A/B is NOT:** a literal pre-vs-post pair. The ×8 was applied *at
import, in place*, so the pre-×8 corpus no longer exists anywhere in the tree
and cannot be re-photographed. What is compared here is post-×8 geometry
against (i) the authored metre spec and (ii) a terrain corpus the re-import
never touched — which is the strongest comparison still available.

## Debt B — subs at depth (`.tasks/notes/metalstorm-unit-art.md`: "the ONE remaining on-screen debt")

`subs-at-depth.jpg` (all four, top-down through the water surface),
`subs-at-depth-side.jpg` (the fjord, side on, with the treeline for scale),
`sub-s1.jpg` and `sub-s4.jpg` (the two ends of the ladder, three-quarter).

Spawned into the deepest water run on `meridian_basin` (found by a heightmap
scan, seabed −29 elmos), submerged, on a paused sim.

| def | guide row | reported | model |
|---|---|---|---|
| `ms_subs_s1` | 18 m | **19.4 m** | loaded |
| `ms_subs_s2` | 30 m | **31.3 m** | loaded |
| `ms_subs_s3` | 45 m | **45.9 m** | loaded |
| `ms_subs_s4` | 65 m | **66.9 m** | loaded |

All four are real models (`model=loaded`, not the E1 procedural fallback):
hulls, conning towers, deck detail and lit markings are visible in `sub-s1.jpg`
and `sub-s4.jpg`. `ms_subs_s1` is a squad def, which is why it reads as four
overlapping hulls from above.

The previous verify fire died retrying exactly this shot. It is now one call.

## The spawn path — `spawn-and-frame.jpg`

```
capture_subject {"def": "fable_heavy", "spawn": {"x": 8704, "z": 15360}, "angle": "three-quarter"}
```

One call: `cheats on → spawn fable_heavy → los on → wait 600 ms for the stream →
pause sim → capture → resume sim → los off → cheats off`, reported back in the
`plan:` line. Reported subject: **22.5 m across, model=loaded**, framed from
305 elmos.

This shot is also a regression marker. The first version of the tool returned
*"2.5 m across, model=loading"* here and photographed the unit from 34 elmos —
subject resolution had accepted the def-radius fallback that
`getEntityBounds` returns while a template is still loading, which is the exact
wrong-zoom failure the primitive exists to remove. Resolution now waits for the
template to settle (`waitForBounds`, pinned by a composite test).

## Verified failure paths (no image — they are refusals, by design)

- **Black frame ⇒ diagnosis.** Forced with `luminanceFloor: 250`: three
  attempts, the ladder genuinely escalating (pitch 30° → 45° → 80°, fill
  0.70 → 0.50 → 0.25), then `capture: UNUSABLE`, the luminance trail
  `46.4 → 50.6 → 63.4`, and the candidate causes named. With `reveal:false`,
  fog of war is named first; with LOS revealed, it is not named at all.
- **Ordering.** `reveal:false` shortens the plan to `pause sim → capture →
  resume sim` — no LOS steps at all.
- **Restore discipline.** With the sim pre-paused by hand, the capture ran and
  left `paused: true` behind. It never resumes a sim it did not pause.
- **Unresolvable subjects refuse rather than shoot.** An unknown def answers
  *"no live entity of def X reached this client within 5000 ms"*; two subjects,
  no subject, and `defName` (the name `spawn_unit` uses) each answer with the
  correction.

## Known limitation visible in these images

The scene renders in a dusk/low-key palette. `test.sun({azimuthDeg:135,
elevationDeg:55})` was issued before the captures and the sun rig reported
`active:true` at that elevation, but the frame did not brighten — the sun
override does not appear to reach this map's lighting. Out of scope here and
recorded rather than chased; the images are legible as they stand.

---

# V2 — capture_sequence acceptance sequences

Two filmed manoeuvres, both taken **hands-off by `order_and_film`** on a live
`meridian_basin` room (metalstorm, lane stack, 2026-08-30). Where the V1 shots
above are *poses*, these are *motion*: the point of each is what changes between
frames, and whether that change is at a spacing you can reason about.

## (a) `m1-tank-180-turn/` — an `ms_tanks_s2` reversing course

18 frames, `mode: "step"`, `everyNthSimFrame: 12`, framed `top` at `fill 0.40`.
The evidence need filed by the unit-motion lane's M1: *see the turn arc*.

```
order_and_film {"unitId": 15976, "move": {"x": 6525, "z": 2527},
                "frames": 18, "everyNthSimFrame": 12, "mode": "step",
                "angle": "top", "fill": 0.40, "maxDim": 900}
```

The 180° is manufactured honestly: the squad is first driven 1400 elmos one way
until it is under way on a settled heading (−67.9°), and only then ordered back
where it came from. That second order is a real course reversal.

| what | value |
|---|---|
| shots | 18, server frames 222 → 426 |
| delivered spacing | `12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12` |
| span | 204 sim frames = 6.80 game-seconds, over **15.0 s of wall clock** |
| heading swept | **192.2°** (path-summed, short way round each step) |
| motion onset | 234 ms / 1 poll — 7.8 elmo/s, turning 62.6°/s |

**The spacing is the result.** Seventeen intervals, all exactly 12 sim frames,
while the camera round trips consumed 15 seconds of wall clock — more than
twice the sim time being filmed. That is the property `step` mode exists for and
the one no amount of slow motion buys: between two shots the world advances by
the number of frames asked for and by nothing else. At speed 1 the same 18 relay
calls would have spanned ~450 sim frames at an unequal, unknowable spacing.

`f000` shows the squad broadside with barrels down-left; by `f009` it has swung
through the passing phase; `f017` has it pointed back the way it came, the
camera having re-framed on the subject before every shot.

## (b) `mech-walk-slowmo/` — one `fable_mech` walk loop, mid-stride

10 frames, `mode: "realtime"`, `simSpeed: 0.25`, `everyNthSimFrame: 1` →
**133 ms apart**, framed `side` at `pitch 20°`, `fill 0.60`.

```
order_and_film {"unitId": 31801, "move": {"x": 6427, "z": 3930},
                "frames": 10, "everyNthSimFrame": 1,
                "mode": "realtime", "simSpeed": 0.25,
                "angle": "side", "pitchDeg": 20, "fill": 0.60}
```

The reverse-joint legs are in a visibly different stride phase in every frame:
`f000` leg extended forward with the trailing foot lifted, `f004` the passing
pose, `f007` contact. That is the mid-stride evidence walk-clip verification
needs, and it is not obtainable from a paused sim — a freeze gives you one pose,
ten times.

**Why the interval is 133 ms and not "3 sim frames".** The sim advances only 9
frames across this whole sequence (`deltas 0, 3, 0, 0, 3, 0, 0, 3, 0` — the
entity stream sends every 3rd frame, so consecutive shots share a snapshot) yet
the mech walks a complete cycle. That is not a bug in the sequence; it is the
finding below.

## Finding: the client's authored-clip clock is WALL-CLOCK, not sim-linked

The V2 brief asked whether the client's animation clock follows sim speed.
**It does not.** Measured directly against `fable_mech`'s `walk` loop — 1.2 s,
72 key-frames at the glTF loader's 60 fps timebase — with ~150 ms samples, short
enough that the loop cannot alias (this matters: a 2–3 s sample wraps twice at
full rate and lands exactly where a sim-linked clip would have crawled to, which
is how a first pass reads a convincing but wrong `ratio ≈ 0.11`):

| sim speed | `clipState().speed` | clip advance | unit travel |
|---|---|---|---|
| 1× | 1.000 | 56.3 key-frames / wall-second | 76.0 elmo/wall-s |
| 0.1× | 0.958 | **55.6** key-frames / wall-second | 6.7 elmo/wall-s |
| **ratio 0.1×/1×** | | **0.99** | **0.09** |

Sim-linked would give ~0.10 for both. The travel ratio is 0.09; the clip ratio
is 0.99. Mechanism, and it is not accidental in either half:

- `ClipPlayer` is constructed with its default clock,
  `now = () => performance.now()` (`client/src/core/game-processor.ts:568`), and
  samples `(now - startMs)` per render frame.
- `clip-auto-policy` does not compensate: it derives a unit's speed from
  **sim-frame** deltas (`dtSec = (frame - prev.frame) / SIM_HZ`,
  `clip-auto-policy.ts:303`), so its playback-speed scaling is speed-invariant
  by construction — it read 1.000 at 1× and 0.958 at 0.1×.

**What it means for callers:** `simSpeed` slows the world, not the legs. Pace a
clip sequence off the clip's own timebase (sequence (b) does), not off sim
frames. **This is a finding, not a fix.** Whether an authored clip *should* run
on sim time is a decision for whoever owns the animation driver — it changes
what every walk cycle in the game looks like during a speed change, not just
what a debug tool photographs.

## Also found while filming these

- **The realtime burst has a hard ~6.5 s ceiling, and an overrun loses
  everything.** The worker→main relay abandons a `test` evaluation that has not
  answered in 8 s (`game-processor.ts` ~1237). Hit live: a 12-shot burst 1 s
  apart came back `Relay unavailable: timeout: main thread did not answer in
  8s`, with all twelve frames gone. Now refused before the shoot, with the
  arithmetic shown and `step` mode named; the harness also self-limits so a
  burst that overruns anyway returns what it has.
- **`gameFrame` quantises to 30.** It comes from GameInfo, broadcast once a
  game-second. The first take of (a) reported `deltas 30, 0, 0, 30, 0, 0, 0`
  for a sequence whose steps were exactly 9 frames — the spacing was right and
  the *clock* was wrong. Spacing is now read from the server frame the step
  landed on, and "did the picture change" from the client's freshest
  entity-snapshot frame.
- **`capture_subject {"def": …}` does not reliably pick the newest instance.**
  Four `fable_mech` spawned in turn at four different points; all four captures
  framed the **first** one, at the same coordinates each time. `def` resolution
  goes through `EntityRenderer.findEntitiesByDef`, documented as newest-first.
  Not chased here (every V2 sequence addresses its subject by `unitId`), but a
  caller who spawns repeatedly and frames by `def` will photograph the wrong
  unit.
- The dusk-palette limitation recorded for V1 still applies. Frame luminance
  runs 54–76 in the open and drops to ~23 under the tree canopy, which is where
  the first mech take was spawned — the (b) frames were re-shot on open ground.
