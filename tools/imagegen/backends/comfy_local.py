"""backends/comfy_local — drives a local ComfyUI Desktop instance over its
HTTP API: POST /prompt with an API-format workflow graph, poll GET
/history/<id>, fetch bytes via GET /view. See PLAN-beta.md "Honest advice"
and PLAN-beta-presentation.md L-IMAGEGEN for why this is the scriptable
path (not Midjourney, which has no API).

This module never downloads a model — if no SDXL checkpoint is installed
it raises with exactly what's missing and lets the operator install it in
ComfyUI Desktop.
"""
from __future__ import annotations
import fnmatch
import io
import os
import time

PORTS = (8188, 8000)
CLIENT_ID = 'metalstorm-imagegen'
_PREFERRED_CKPT_GLOBS = ('sd_xl_base_1.0*.safetensors', '*sdxl*base*.safetensors')
NATIVE_AREA = 1024 * 1024  # SDXL base is trained at ~1 MP; anything else degrades fast
LATENT_STEP = 64
JOB_TIMEOUT_S = 900  # a 1 MP / 28-step run is ~2 min on an M2 Pro (Metal); leave headroom


def native_size(size: tuple[int, int], target_area: int = NATIVE_AREA,
                step: int = LATENT_STEP) -> tuple[int, int]:
    """The size SDXL is actually asked for: the job's aspect ratio scaled to
    ~1 MP and snapped to the latent grid. A 512² emblem is sampled at 1024²
    and downscaled (SDXL at 512² is mush); a 2048×1024 lobby background is
    sampled at 1472×704 and upscaled (native 2 MP repeats the scene and takes
    ~4× as long)."""
    w, h = size
    scale = (target_area / float(w * h)) ** 0.5
    nw = max(step, int(round(w * scale / step)) * step)
    nh = max(step, int(round(h * scale / step)) * step)
    return nw, nh


def _get_json(session, url, timeout=5):
    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    return r.json()


def probe_base_url(timeout: float = 1.5) -> str | None:
    import requests
    host = os.environ.get('COMFY_HOST', '127.0.0.1')
    override_port = os.environ.get('COMFY_PORT')
    ports = (int(override_port),) if override_port else PORTS
    for port in ports:
        base = f'http://{host}:{port}'
        try:
            r = requests.get(f'{base}/system_stats', timeout=timeout)
            if r.ok:
                return base
        except requests.RequestException:
            continue
    return None


def list_checkpoints(session, base: str) -> list[str]:
    info = _get_json(session, f'{base}/object_info/CheckpointLoaderSimple')
    try:
        return info['CheckpointLoaderSimple']['input']['required']['ckpt_name'][0]
    except (KeyError, IndexError):
        return []


def pick_checkpoint(checkpoints: list[str]) -> str | None:
    for pattern in _PREFERRED_CKPT_GLOBS:
        for ckpt in checkpoints:
            if fnmatch.fnmatch(ckpt.lower(), pattern.lower()):
                return ckpt
    return None


def _build_workflow(ckpt: str, prompt: str, negative: str, seed: int,
                     size: tuple[int, int]) -> dict:
    w, h = size
    return {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': ckpt}},
        '2': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['1', 1]}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': negative, 'clip': ['1', 1]}},
        '4': {'class_type': 'EmptyLatentImage', 'inputs': {'width': w, 'height': h, 'batch_size': 1}},
        '5': {'class_type': 'KSampler', 'inputs': {
            'seed': seed, 'steps': 28, 'cfg': 6.5, 'sampler_name': 'dpmpp_2m',
            'scheduler': 'karras', 'denoise': 1.0,
            'model': ['1', 0], 'positive': ['2', 0], 'negative': ['3', 0], 'latent_image': ['4', 0],
        }},
        '6': {'class_type': 'VAEDecode', 'inputs': {'samples': ['5', 0], 'vae': ['1', 2]}},
        '7': {'class_type': 'SaveImage', 'inputs': {'images': ['6', 0], 'filename_prefix': 'imagegen'}},
    }


def generate(prompt: str, seed: int, size: tuple[int, int], negative: str, *,
             asset_class: str = 'texture', params: dict | None = None) -> bytes:
    del asset_class, params  # the model reads the prompt text, same as any real backend
    import requests

    base = probe_base_url()
    if base is None:
        raise RuntimeError(
            f'ComfyUI not reachable on 127.0.0.1:{PORTS[0]} or :{PORTS[1]} '
            '(ComfyUI Desktop must be running)')

    session = requests.Session()
    checkpoints = list_checkpoints(session, base)
    ckpt = pick_checkpoint(checkpoints)
    if ckpt is None:
        installed = ', '.join(checkpoints) or '(none)'
        raise RuntimeError(
            'No SDXL base checkpoint found in ComfyUI (models/checkpoints). '
            f'Installed: {installed}. Install sd_xl_base_1.0*.safetensors manually via '
            'ComfyUI Desktop\'s model manager — this tool does not download models '
            '(Flux fp8 does not run on Metal; bf16 Flux is too large for 32 GB unified memory).')

    sample_size = native_size(size)
    workflow = _build_workflow(ckpt, prompt, negative, seed, sample_size)
    resp = session.post(f'{base}/prompt', json={'prompt': workflow, 'client_id': CLIENT_ID}, timeout=15)
    resp.raise_for_status()
    prompt_id = resp.json()['prompt_id']

    deadline = time.monotonic() + JOB_TIMEOUT_S
    history = None
    while time.monotonic() < deadline:
        h = _get_json(session, f'{base}/history/{prompt_id}')
        if prompt_id in h:
            history = h[prompt_id]
            break
        time.sleep(1.0)
    if history is None:
        raise RuntimeError(f'ComfyUI job {prompt_id} did not finish within {JOB_TIMEOUT_S}s')

    status = history.get('status', {})
    if status.get('status_str') == 'error':
        detail = ''
        for msg in status.get('messages', []):
            if msg[0] == 'execution_error':
                detail = f"{msg[1].get('node_type')}: {msg[1].get('exception_message')}"
        raise RuntimeError(f'ComfyUI job {prompt_id} failed inside ComfyUI — {detail or status}')

    images = history.get('outputs', {}).get('7', {}).get('images', [])
    if not images:
        raise RuntimeError(f'ComfyUI job {prompt_id} produced no images: {status}')
    img = images[0]
    r = session.get(f'{base}/view', params={
        'filename': img['filename'], 'subfolder': img.get('subfolder', ''), 'type': img.get('type', 'output'),
    }, timeout=30)
    r.raise_for_status()
    if sample_size == tuple(size):
        return r.content
    from PIL import Image
    im = Image.open(io.BytesIO(r.content))
    im.load()
    im = im.resize(tuple(size), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format='PNG')
    return buf.getvalue()
