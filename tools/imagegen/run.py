#!/usr/bin/env python3
"""tools/imagegen/run.py — the image-generation pipeline entry point.

    python3 tools/imagegen/run.py --backend none --all
    python3 tools/imagegen/run.py --list
    python3 tools/imagegen/run.py --job biome_desert --force

Backend selection (`--backend auto`, the default): probe ComfyUI Desktop on
127.0.0.1:8188 then :8000 (GET /system_stats) -> comfy_local; else FAL_KEY
or REPLICATE_API_TOKEN in the environment -> hosted; else `none` (procedural
placeholders, so layout work never blocks on the backend decision — see
PLAN-beta.md "Honest advice: who should make the art").

Idempotent: each job's manifest entry is keyed to a hash of the job spec +
backend; a rerun with nothing changed regenerates nothing. `--force` bypasses
that. `--all` also runs a completeness check at the end (every job has a
manifest entry and every file it names exists on disk).

Raw cache: the bytes a raster backend returns are cached under
tools/imagegen/.cache/raw/<backend>/ keyed to (prompt, negative, seed, size),
so `--force` re-runs every post step for free (that's what you iterate on)
without re-sampling; `--no-raw-cache` re-samples too.

Per-job pin: a job file may carry `"backend": "none"` + `"backend_reason"`
to stay on the procedural placeholder whatever `--backend` says — used when
the real backend's output is worse than the placeholder (the reason lands in
the manifest entry so the call is on record).
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

try:
    import numpy  # noqa: F401 — presence check only; backends/post import it themselves
    from PIL import Image
except ImportError:
    sys.exit(
        "tools/imagegen needs numpy + pillow, not found on this interpreter.\n"
        "  python3 -m venv tools/imagegen/.venv\n"
        "  tools/imagegen/.venv/bin/pip install numpy pillow requests\n"
        "  tools/imagegen/.venv/bin/python tools/imagegen/run.py ...")

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
GAME_ROOT = REPO_ROOT / 'data' / 'games' / 'metalstorm'
JOBS_DIR = HERE / 'jobs'
STYLE_PATH = HERE / 'style.json'
MANIFEST_PATH = GAME_ROOT / 'art' / 'gen' / 'manifest.json'
RAW_CACHE_DIR = HERE / '.cache' / 'raw'  # gitignored (.gitignore: .cache/)

sys.path.insert(0, str(HERE))
from backends import none as backend_none  # noqa: E402
from backends import comfy_local as backend_comfy  # noqa: E402
from backends import hosted as backend_hosted  # noqa: E402
from post import seamless, resize, pbr, ktx2 as ktx2mod, svg_trace, alpha as alphamod, grade  # noqa: E402

BACKENDS = {'none': backend_none, 'comfy_local': backend_comfy, 'hosted': backend_hosted}


def load_jobs() -> list[dict]:
    jobs = []
    for path in sorted(JOBS_DIR.glob('*.json')):
        job = json.loads(path.read_text())
        job['_source'] = path.name
        jobs.append(job)
    return jobs


def load_style() -> dict:
    return json.loads(STYLE_PATH.read_text())


def build_prompt(style: dict, job: dict) -> tuple[str, str]:
    cls = style['classes'][job['class']]
    parts = [cls['prefix'], job['prompt']]
    if cls.get('suffix'):  # CLIP weights early tokens: a class whose shared material terms
        parts.append(cls['suffix'])  # come *after* the job's subject keeps the subject readable
    prompt = '. '.join(part.strip().rstrip('.') for part in parts)
    negative = ', '.join(p for p in (style['global_negative'], cls.get('negative', ''),
                                      job.get('negative', '')) if p)
    return prompt, negative


def probe_backend() -> str:
    if backend_comfy.probe_base_url() is not None:
        return 'comfy_local'
    if backend_hosted.pick_provider() is not None:
        return 'hosted'
    return 'none'


def job_hash(job: dict, backend_name: str) -> str:
    spec = {k: v for k, v in job.items() if k != '_source'}
    blob = json.dumps(spec, sort_keys=True) + '|' + backend_name
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()[:16]


def rel(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def effective_backend(job: dict, backend_name: str) -> str:
    """A job pinned to a backend (`"backend": "none"`) wins over --backend."""
    pinned = job.get('backend')
    if pinned is None:
        return backend_name
    if pinned not in BACKENDS:
        raise ValueError(f'{job["id"]}: unknown pinned backend {pinned!r}')
    return pinned


def raw_cache_path(backend_name: str, prompt: str, negative: str, seed: int,
                   size: tuple[int, int]) -> Path:
    key = json.dumps([prompt, negative, seed, list(size)], sort_keys=True)
    return RAW_CACHE_DIR / backend_name / (hashlib.sha256(key.encode('utf-8')).hexdigest()[:24] + '.png')


def generate_raw(backend_name: str, job: dict, prompt: str, negative: str,
                 size: tuple[int, int], use_raw_cache: bool) -> bytes:
    backend = BACKENDS[backend_name]
    if backend_name == 'none':  # procedural and instant — never worth caching
        return backend.generate(prompt, job['seed'], size, negative,
                                asset_class=job['class'], params=job)
    cache = raw_cache_path(backend_name, prompt, negative, job['seed'], size)
    if use_raw_cache and cache.is_file():
        return cache.read_bytes()
    png_bytes = backend.generate(prompt, job['seed'], size, negative,
                                 asset_class=job['class'], params=job)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(png_bytes)
    return png_bytes


def process_job(job: dict, backend_name: str, style: dict, force: bool,
                 existing_manifest: dict, use_raw_cache: bool = True) -> tuple[dict, bool]:
    output_rel_game = job['output']
    output_path = GAME_ROOT / output_rel_game
    backend_name = effective_backend(job, backend_name)
    h = job_hash(job, backend_name)

    prior = existing_manifest.get(job['id'])
    if not force and prior and prior.get('job_hash') == h and \
            all((REPO_ROOT / p).exists() for p in prior.get('outputs', [])):
        return prior, False

    prompt, negative = build_prompt(style, job)
    size = (job['width'], job['height'])
    png_bytes = generate_raw(backend_name, job, prompt, negative, size, use_raw_cache)
    img = Image.open(io.BytesIO(png_bytes))
    img.load()

    post_steps = job.get('post', [])
    extra_rel: dict[str, Image.Image] = {}
    for step in post_steps:
        if step == 'seamless':
            if backend_name != 'none':  # the placeholder generators are periodic already
                img = seamless.make_seamless(img)
        elif step == 'pow2':
            img = resize.to_pow2(img)
        elif step == 'pbr_derive':
            if '_diffuse.' not in output_rel_game:
                raise ValueError(f'{job["id"]}: pbr_derive needs a "_diffuse." output name')
            height = pbr.height_from_luminance(img)
            extra_rel[output_rel_game.replace('_diffuse.', '_normal.')] = pbr.normal_from_height(height)
            extra_rel[output_rel_game.replace('_diffuse.', '_roughness.')] = pbr.roughness_from_luminance(img)
        elif step == 'pbr_normal_only':
            img = pbr.normal_from_height(pbr.height_from_luminance(img))
        elif step == 'overlay_alpha':
            img = alphamod.overlay_alpha(img, backend_none.hex_to_rgb(job.get('tint', '#808080')))
        elif step == 'bg_key':
            img = alphamod.key_out_background(img, circle=job.get('key_circle', 0.5),
                                              bright_unsat_is_bg=bool(job.get('key_bright_unsat', False)))
        elif step == 'palette_grade':
            if backend_name != 'none':  # the placeholder is painted from the palette already
                img = grade.grade_to_palette(img, job.get('colors', []))
        elif step in ('svg_trace', 'ktx2'):
            pass  # handled below, after the PNG is saved
        else:
            raise ValueError(f'{job["id"]}: unknown post step {step!r}')

    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(output_path, optimize=True)
    outputs = [rel(output_path)]
    for extra_game_rel, extra_img in extra_rel.items():
        p = GAME_ROOT / extra_game_rel
        p.parent.mkdir(parents=True, exist_ok=True)
        extra_img.save(p, optimize=True)
        outputs.append(rel(p))

    derived: dict = {}
    if 'ktx2' in post_steps:
        ktx2_map = {}
        for out_rel in outputs:
            png_path = REPO_ROOT / out_rel
            ktx2_path = png_path.with_suffix('.ktx2')
            ok, info = ktx2mod.encode_ktx2(REPO_ROOT, png_path, ktx2_path)
            ktx2_map[out_rel] = rel(ktx2_path) if ok else f'MISSING: {info}'
        derived['ktx2'] = ktx2_map
    if 'svg_trace' in post_steps:
        svg_path = output_path.with_suffix('.svg')
        if backend_name == 'none':
            svg_trace.write_geometric_svg(backend_none.emblem_shapes(job.get('tint', '#7fd0c8')), svg_path)
            derived['svg'] = rel(svg_path)
            outputs.append(rel(svg_path))
        else:
            ok, info = svg_trace.trace_to_svg(output_path, svg_path)
            derived['svg'] = rel(svg_path) if ok else f'FALLBACK: {info}'
            outputs.append(rel(svg_path))

    entry = {
        'job_id': job['id'],
        'class': job['class'],
        'backend': backend_name,
        'seed': job['seed'],
        'size': [size[0], size[1]],
        'prompt': prompt,
        'negative': negative,
        'post': post_steps,
        'outputs': outputs,
        'source_job': job['_source'],
        'job_hash': h,
        **derived,
    }
    if 'backend' in job:
        entry['backend_pinned'] = True
        entry['backend_reason'] = job.get('backend_reason', '(no reason given in the job file)')
    return entry, True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--backend', choices=['auto', *BACKENDS], default='auto')
    ap.add_argument('--all', action='store_true', help='run every job in jobs/*.json')
    ap.add_argument('--job', action='append', default=[], help='run one job by id (repeatable)')
    ap.add_argument('--list', action='store_true', help='list job ids and exit')
    ap.add_argument('--force', action='store_true',
                    help='ignore the idempotency cache (re-runs post steps; raw samples still come from .cache/raw)')
    ap.add_argument('--no-raw-cache', action='store_true',
                    help='also ignore tools/imagegen/.cache/raw — re-sample every raster job')
    args = ap.parse_args()

    jobs = load_jobs()

    if args.list:
        for job in jobs:
            pin = f"  [pinned backend={job['backend']}]" if 'backend' in job else ''
            print(f"{job['id']:<24} class={job['class']:<16} -> {job['output']}{pin}")
        return 0

    if not args.all and not args.job:
        ap.error('pass --all or --job <id> (repeatable)')

    if args.all:
        selected = jobs
    else:
        wanted = set(args.job)
        selected = [j for j in jobs if j['id'] in wanted]
        missing = wanted - {j['id'] for j in selected}
        if missing:
            print(f'unknown job id(s): {", ".join(sorted(missing))}', file=sys.stderr)
            return 1

    backend_name = args.backend
    if backend_name == 'auto':
        backend_name = probe_backend()

    style = load_style()
    existing_manifest = json.loads(MANIFEST_PATH.read_text()) if MANIFEST_PATH.exists() else {}
    new_manifest = dict(existing_manifest)

    generated = skipped = failed = 0
    for job in selected:
        try:
            entry, changed = process_job(job, backend_name, style, args.force, existing_manifest,
                                         use_raw_cache=not args.no_raw_cache)
        except Exception as exc:  # noqa: BLE001 — report and keep going
            print(f'FAIL {job["id"]}: {exc}', file=sys.stderr)
            failed += 1
            continue
        new_manifest[job['id']] = entry
        generated += changed
        skipped += not changed

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(new_manifest, indent=2, sort_keys=True) + '\n')

    complete = True
    if args.all:
        for job in jobs:
            entry = new_manifest.get(job['id'])
            if entry is None or not all((REPO_ROOT / p).exists() for p in entry.get('outputs', [])):
                print(f'INCOMPLETE: {job["id"]} missing from manifest or its output files', file=sys.stderr)
                complete = False

    print(f'backend={backend_name} generated={generated} skipped={skipped} failed={failed} '
          f'jobs={len(selected)} manifest={"complete" if complete else "INCOMPLETE"}')
    return 1 if (failed or not complete) else 0


if __name__ == '__main__':
    sys.exit(main())
