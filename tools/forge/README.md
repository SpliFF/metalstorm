# tools/forge — shared model-forge environment

Multi-agent-safe workbench for producing Metalstorm models with the generator
toolkit in the sibling folder `tools/fable-model-forge/` (meshlib,
gltf_export, bake_impostors, validate.py, encode.mjs).

- START HERE (agents): docs/FORGE-GUIDE.md — recipe + contracts + pitfalls.
- Style authority: docs/DESIGN-GUIDE.md (distills data/games/metalstorm/art/STYLE.md).
- Prefabs: prefabs/PREFABS.md (parts.py geometry + paintlib.py painting) ·
  smoke_test.py renders every part.
- bin/env.sh (source it), bin/new-workspace.sh, bin/build.sh (whole build
  loop in one call), bin/encode.sh.
- samples/ — 21 complete gen/layout/paint triplets (batch 01).
- dist/batch-01/ — finished, validated batch-01 assets awaiting integration
  into the game data tree (local only, gitignored — regenerable from samples).

Per-checkout setup (once; both locations are gitignored):

    python3 -m venv tools/forge/venv && tools/forge/venv/bin/pip install numpy pillow
    cd tools/fable-model-forge && npm ci

Sharing rules: this folder is READ-ONLY for build agents; each agent works in
its own workspace directory (session scratchpad) and only reads from here.

Provenance: samples/ and dist/ are the forge-40-models batch-01 outputs.
