# battle-flow (lane 12) — deep review 2026-09-10

## STATUS
in-progress: baseline taken; fixing transports/civilians/train/game_start; scenario asset next.

Branch: `worktree-agent-a6d61b5b2f6c4966a` (cut from main `88d257bce2`, merged main tip at start).

## Baseline (before any edit, same session)

Run from the dirs that make them green (`scratchpad/baseline.sh`):

| suite | result |
|---|---|
| Gadgets/tests: transports 64, train 20, teams 34, tick 14, squad_extents 7, defs_reconciled 7, snapshot 25 | all green |
| metalstorm root: scenario briefing 5 / neutral 9 / objectives 13 / population 18 / towns 15, crossing_standoff 18, meridian_basin 11, meridian_basin_soak 6 | all green |
| metalstorm root: `game_scenario_ai_spec` | **RED at baseline** — `units[21]: unknown unit def "ms_timber_yard"` (mock def list predates the §M4 resource sites in meridian_basin.lua) |
| regions/tests: control 7, cost 5, ownership 10, partition 48 | green |
| civilians/tests: convoy 6, estate_buildings 12, estate 10, estate_venue 10, routines 8, spawn 6, town 20 | green |

## Findings (ranked)

(filled in incrementally below — see "Findings detail")

## Findings detail

## Changes

## Proposed C++ patches (UNCOMPILED — needs a build session)

None yet.

## Out-of-lane findings

## Assumptions / decisions made without asking

- `data/maps` is untracked and absent from this worktree; every map fact below was read from the MAIN checkout's `data/maps/**` (read-only) and sampled from `heightmap.bin` (uint16 LE, (mapx+1)x(mapy+1), `minheight..maxheight` from mapinfo).

## Next milestones
