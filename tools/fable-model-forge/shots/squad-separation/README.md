# Between-squad separation — unit-motion M3

Live on `scorched_crossing_v2.4`, scenario `crossing_standoff`, team 0's
`amber_row` landing zone. Both pose shots use the SAME camera
(`pos 1120,1000,6700 → lookAt 1120,165,6360`), and both are taken with the sim
paused inside the first ~5 game-seconds, so the comparison is the scenario's
own start-of-battle pose and not a moment of the battle.

| shot | what it is |
|---|---|
| `01-before-standoff-pose.jpg` | the whole landing zone, before |
| `02-before-tanks-topdown.jpg` | the tank block, before — **adjacent squads' wedges intersect** |
| `03-after-tanks-topdown.jpg` | same camera, after — each wedge is its own readable cluster |
| `04-after-force-in-town.jpg` | a force that crossed 7,200 elmos and arrived, after |

## The measurement behind the pictures

Sim positions at the start-of-battle pose, team 0, nearest same-def pair:

| pair | before | after | the def's drawn diameter |
|---|---|---|---|
| `ms_tanks_s2` ↔ `ms_tanks_s2` | 120.8 | **167.7** | 290 |
| `ms_soldiers_s1` ↔ `ms_soldiers_s1` | 83.1 | **106.2** | 110 |
| `ms_artillery_s2` ↔ `ms_artillery_s2` | 110.8 | **279** | 268 |
| `ms_engineers_s1` ↔ `ms_engineers_s1` | 120 | 120 | 54 (already clear — spacing is a floor, so it did not move) |

## The two proofs that matter more than the pictures

**`separationDistance` is live, and it is what moved.** Squad B ordered to a
point **120 elmos** from a parked squad A: B closed to 145, was pushed out, and
held at **586**. Pre-M3 the same order parked them at the VEH MoveDef floor.

**That floor is exactly 24 elmos, measured.** Two `ms_tanks_s2` squads ordered
onto ONE point settle at **24.3** and stay there — `12 + 12` from
`MoveDef::CalcFootPrintMaxInteriorRadius`, which is why M2 measured 32.5 and why
no unit-def `footprintx/z` could have changed it. Note this crush case is
*unchanged* by M3: within collision range the engine takes the `isCollision`
branch and `separationDistance` is inert by construction.

**Pathing still works.** Six units ordered 7,200 elmos across the map to the
town at `(6400, 2400)`, no enemies: all six arrived (median 23 elmos from the
goal, nearest 8), none lost, none stuck, `n=6` at every sample.
