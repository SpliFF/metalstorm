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
