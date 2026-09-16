# tools/imagegen — the image-generation pipeline

PLAN-beta.md "Honest advice: who should make the art" / PLAN-beta-presentation.md
L-IMAGEGEN. One `generate(prompt, seed, size, negative)` adapter interface behind
three backends, so the backend decision (local ComfyUI vs a paid API) never
blocks layout work — `--backend none` always works.

```
python3 -m venv tools/imagegen/.venv
tools/imagegen/.venv/bin/pip install numpy pillow requests

tools/imagegen/.venv/bin/python tools/imagegen/run.py --list
tools/imagegen/.venv/bin/python tools/imagegen/run.py --backend none --all
tools/imagegen/.venv/bin/python tools/imagegen/run.py --job biome_desert --force
```

`requests` is only needed by `comfy_local`/`hosted`; `--backend none` never
imports it.

## Layout

- `style.json` — palette + prompt prefix/negative per asset class, keyed to
  `data/games/metalstorm/art/DIRECTION.md`. Retune the look here, once, for
  every backend.
- `jobs/*.json` — one file per asset: prompt, seed, size, output path, post
  steps. The job file is the source of truth; `run.py` hashes it (+ backend)
  into `manifest.json`'s `job_hash` so an unchanged job is never regenerated.
- `backends/{none,comfy_local,hosted}.py` — `generate(prompt, seed, size,
  negative, *, asset_class, params) -> PNG bytes`. `none` is procedural
  (numpy/PIL, no network); `comfy_local` drives ComfyUI Desktop's HTTP API
  (`POST /prompt`, poll `/history/<id>`, `GET /view`); `hosted` calls fal.ai
  or Replicate from `FAL_KEY`/`REPLICATE_API_TOKEN` — **never commit either
  key**, both come from the environment only.
- `post/` — `seamless.py` (offset-blend tiling), `resize.py` (power-of-two),
  `pbr.py` (height→normal reusing `tools/fable-model-forge/normals.py`'s
  Sobel bake; luminance→roughness), `ktx2.py` (shells out to the built
  `tools/textureconverter` binary for terrain; PNG-only + a report line if
  it isn't built), `svg_trace.py` (emblems: `none` writes real SVG from its
  own shape list; a raster backend traces via `potrace` if installed, else
  falls back to an SVG that embeds the raster).
- `run.py` — orchestrator + `manifest.json` writer + backend auto-probe
  (ComfyUI :8188 then :8000 → `comfy_local`; else an API key env var →
  `hosted`; else `none`).
- `tests/` — `python3 -m unittest discover -s tools/imagegen/tests`.

## Backend selection (`--backend auto`, the default)

1. `comfy_local` if `GET http://127.0.0.1:8188/system_stats` or `:8000`
   answers (ComfyUI Desktop). Picks the first `sd_xl_base_1.0*.safetensors`
   checkpoint via `GET /object_info/CheckpointLoaderSimple`; raises with
   exactly what's missing if none is installed. **Never downloads a model**
   — Flux fp8 doesn't run on Metal and bf16 Flux doesn't fit in 32 GB
   unified memory on an M2 Pro, so SDXL base is the target; install it
   through ComfyUI Desktop's own model manager.
2. `hosted` if `FAL_KEY` or `REPLICATE_API_TOKEN` is set.
3. `none` otherwise — procedural placeholders (palette-gradient noise;
   emblems are flat geometric badges), fully deterministic per seed.

## Output

`data/games/metalstorm/art/gen/**` (emblems, lobby background, biome
tileables + derived `_normal`/`_roughness` + `.ktx2`, grime overlays, water
normal tiles) and `data/games/metalstorm/unittextures/fx_atlas.png` (the one
file outside `art/gen/`, since `client/src/core/native-fx/fx-game-loader.ts`
reads it straight from `unittextures/` — see PLAN-beta-presentation.md L-FX
step 2). `art/gen/manifest.json` records seed/prompt/negative/backend/post
steps/every output file per job.
