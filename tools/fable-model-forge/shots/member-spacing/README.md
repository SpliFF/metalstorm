# member-spacing — unit-motion M2, USER-REPORTED 2026-08-29

"Units visually overlap each other, within squads and between them. Give them
space." Before/after, filmed live on `scorched_crossing_v2.4`, metalstorm,
2026-08-30. Same script for both passes: an empty-scenario room, units spawned
on one well-lit patch of ground, cleaned between scenes, one fixed camera pose
per scene.

| shot | scene |
|---|---|
| `01-before-standing` / `02-after-standing` | `ms_tanks_s1` (8, wedge) right, `ms_soldiers_s1` (16, line) left, standing |
| `03-before-crossing` / `04-after-crossing`  | two `ms_tanks_s2` squads driven through each other, filmed mid-pass |
| `05-before-mixed-push` / `06-after-mixed-push` | `ms_tanks_s2` + `ms_soldiers_s1` ordered onto one point |

## The numbers behind the pictures

Tightest member-to-member distance inside one squad, elmos, read off the live
squad engine (`__squadSystem`). "needs" is two hull radii at 8 elmos = 1 m —
below it, two models are inside each other.

| def | before | after | needs | before | after |
|---|---|---|---|---|---|
| `ms_tanks_s1`     |  7.0 | 38.4 | 36 | 0.19x | **1.07x** |
| `ms_tanks_s2`     | 24.0 | 63.1 | 68 | 0.35x | **0.93x** |
| `ms_artillery_s2` | 22.7 | 64.9 | 60 | 0.38x | **1.08x** |
| `ms_soldiers_s1`  |  1.7 |  4.7 | 5.6 | 0.31x | **0.85x** |
| `ms_soldiers_s2`  |  9.7 |  9.8 |  6 | 1.62x | 1.63x (already clear — unchanged) |
| `ms_engineers_s2` | 22.7 | 22.7 |  6 | 3.78x | 3.78x (already clear — unchanged) |

Interpenetrating member pairs across the whole staged force: **1.6 % → 0.5 %**.

## Read the pictures honestly

- **01 → 02 is the clean pair.** Eight `ms_tanks_s1` go from one unreadable pile
  to a wedge with ground visible between every hull; the sixteen soldiers go
  from a solid bar to individually countable figures.
- **03/04 and 05/06 both carry residue.** Killing a squad's sim unit does not
  immediately remove its drawn members — the client keeps drawing the dead
  squad for a while — so both frames contain leftover marks from the previous
  scene. That is a client cleanup lag, not part of this change, and it is
  present on BOTH sides of the comparison. Judge those two pairs on hull
  spacing, not on unit count.
- **Neither pass is a fix for a real crush.** Squads ordered onto one point
  still stack; see the milestone note.
