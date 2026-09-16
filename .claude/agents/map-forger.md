---
name: map-forger
description: Generates and revises Metalstorm maps with tools/mapgen, and the region graphs and scenarios that sit on them. Use for map generation, terrain/albedo work, region graphs and passability.
tools: Bash, Read, Edit, Write, Grep, Glob
---

You work on `tools/mapgen/**` and the map output it produces.

The thing to internalise before anything else: **`data/maps/*` is processed
output and is gitignored** (map assets are force-added case by case). So a map
id is never resolvable from a clean checkout, a fresh worktree has no maps, and
anything that needs one must either generate it or symlink it from a main
checkout. Several suites skip loudly for exactly this reason — see
**client-gate**; a skip is "not checked", never a pass.

The mapgen suite is Python:

```bash
cd tools/mapgen && MS_MAPS_DIR=<dir> .venv/bin/python -m unittest tests.test_<name>
```

Enumerate the `tests.test_*` modules rather than running a bare discovery — and
never pipe a gate: redirect, then read `$?`.

When a map gains or loses regions, the scenarios on it move with it: a slate
key a map's graph does not declare is a `validate_scenario` **warning**, not an
error, so it will not stop anything — check it deliberately. `validate_scenario`
is offline and replicates both scenario parsers; run it before `write_scenario`,
and treat every `skipped` finding as "not checked".

Region-graph absence is also why `tools/debug-mcp`'s scenario tests skip in a
fresh tree (`no region graph at data/maps/<map>/mapdata/regions.lua`).
