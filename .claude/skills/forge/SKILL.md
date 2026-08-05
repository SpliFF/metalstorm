---
name: forge
description: Build production Metalstorm 3D models (units, buildings, sites, props) with the pre-built fable-model-forge environment at tools/forge. Use when asked to create, generate, revise, or batch-produce game models, textures, or model previews — and when writing briefs for model-generation agents.
---

# forge — the shared model workbench

Everything needed to produce an engine-ready model is pre-built at
**`tools/forge/`** (repo-relative; absolute:
`/Users/shannon/WarriorHut/Projects/springrts-web/tools/forge`). Do NOT
re-extract tooling, create venvs, `npm ci`, or read the big precedent
generators — that is the expensive anti-pattern this environment exists to
kill.

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
- Encode: `bash $FORGE/bin/encode.sh <workspace> <stem>` (expects the PNG
  set in `<workspace>/out/`).
- Validate before reporting: `$PY $TOOLKIT/validate.py out/<stem>.gltf
  <budget> <piece,piece,…>` must print ALL CHECKS PASSED.
- Deviations from spec or STYLE.md, and mount/socket offsets, go in your
  final report — the integrator needs them for unitdef wiring.

## When briefing sub-agents for model batches

Put the byte-identical shared preamble FIRST in every brief (prompt-cache
hits), the per-model spec LAST. Each brief should instruct: read
FORGE-GUIDE.md + one named sample; work in an isolated workspace; one
impostor-bake visual check, read once; return structured results with an
ASSETS.md row. Batch small props 2–4 per agent.

## What's here already

`tools/forge/dist/batch-01/` holds 21 finished, validated models
(gltf+bin+ktx2+png) not yet integrated into the game data tree — check it
before generating a model that may already exist. `samples/` holds their
generator triplets. The generator toolkit is the sibling folder tools/fable-model-forge/ in this same tree.
