---
name: forge
description: Build production Metalstorm 3D models (units, buildings, sites, props) with the pre-built fable-model-forge environment at tools/forge. Use when asked to create, generate, revise, or batch-produce game models, textures, or model previews — and when writing briefs for model-generation agents.
---

# forge — the shared model workbench

Everything needed to produce an engine-ready model is pre-built at
**`tools/forge/`** (repo-relative; absolute:
`/Users/shannon/WarriorHut/Projects/springrts-web/tools/forge`). Do NOT
re-extract tooling or read the big precedent generators — that is the
expensive anti-pattern this environment exists to kill. Two gitignored
per-checkout pieces exist ONCE per checkout and are otherwise never rebuilt:
`tools/forge/venv` (`python3 -m venv tools/forge/venv && tools/forge/venv/bin/pip install numpy pillow`)
and `tools/fable-model-forge/node_modules` (`cd tools/fable-model-forge && npm ci`).
If `$FORGE/venv/bin/python` is missing in a fresh worktree, run those two
lines (or point `env.sh` at the main checkout's copy) — do not improvise a
third environment.

## Start here, in order

1. `tools/forge/docs/FORGE-GUIDE.md` — the recipe: contracts (meshlib
   Zone-vs-rect, piece tables, clips), the 8-step build loop, validator +
   encoder commands, pitfalls. This is the contract of record.
2. `tools/forge/docs/DESIGN-GUIDE.md` — style, scale table, tri budgets,
   texture discipline, faction register.
3. ONE sample triplet from `tools/forge/samples/<model>/` — the guide's
   sample index says which one fits your model class. Read only that one.
4. `tools/forge/prefabs/PREFABS.md` — reusable assemblies (wheels, turret
   chains, lattice towers, clutter). Prefer prefabs over hand-rolling.

## Rules

- `tools/forge/` is **read-only shared infrastructure** — build in your own
  workspace (session scratchpad), never inside it. Multiple agents may use
  it concurrently.
- Always `source tools/forge/bin/env.sh` → gives `$FORGE`, `$PY`
  (venv python with numpy+pillow — system python will fail), `PYTHONPATH`.
- Scaffold: `bash $FORGE/bin/new-workspace.sh <dir> <stem> [sample]`.
- Build: `bash $FORGE/bin/build.sh <workspace> <stem> <budget>
  <piece,piece,…> [--no-team]` — ONE call runs gen → paint → validate →
  encode → impostor bake with a compact summary; must end ALL CHECKS
  PASSED. Don't run the five steps as separate shell calls.
- Prefer `prefabs/parts.py` (geometry) and `prefabs/paintlib.py` (painting;
  `finish()` writes all five maps) over hand-rolling.
- Deviations from spec or STYLE.md, and mount/socket offsets, go in your
  final report — the integrator needs them for unitdef wiring.

## When briefing sub-agents for model batches

Put the byte-identical shared preamble FIRST in every brief (prompt-cache
hits), the per-model spec LAST. Each brief should instruct: read
FORGE-GUIDE.md + one named sample; work in an isolated workspace; one
impostor-bake visual check, read once; return structured results with an
ASSETS.md row. Batch small props 2–4 per agent.

## What's here already

`tools/forge/dist/batch-01..batch-04/` (LOCAL-ONLY, gitignored — present in
the main checkout, absent from every worktree; regenerable from `samples/`)
hold ~70 finished, validated models (gltf+bin+ktx2+png). **All 70 are already
integrated** into `data/games/metalstorm/models/` (the shipped `ms_*` corpus
replaced every `wz_*` placeholder, 2026-08). Check the game data tree (and
`ASSETS.md` — its rows use brace-expansion groups, expand them before declaring
a gap) before generating a model that may already exist. `samples/` holds the
generator triplets. The generator toolkit is
the sibling folder tools/fable-model-forge/ in this same tree.

## World-scale contract (×8) — REQUIRED for integration

Forge models are authored in **metres**, but the engine adopted
**8 elmos = 1 m applied at import** (Option A, decided 2026-08-27). Unit
models in `data/games/metalstorm/models/` must carry
`SPRINGRTS_geometry.units="elmos"` and be exactly 8× the metre baseline in
`tools/scripts/world_scale_baseline.json`; map features stay ×1. The gate is
`python3 tools/scripts/check_model_scale.py` — a hand-copied forge gltf
(still in metres) FAILS it. Run it after every import, redirect its output to
a file and read the exit code (never through a pipe). Import with `modelimporter --metres`, which
scales geometry and metadata together. Impostor framing constants are
scale-invariant but must be re-baked after a rescale.
