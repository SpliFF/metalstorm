"""backends/hosted — one hosted API path, used only when neither ComfyUI
port answers and a key is present. Never commit keys: both come from the
environment only (FAL_KEY / REPLICATE_API_TOKEN), never a file in this repo.
"""
from __future__ import annotations
import os
import time


def pick_provider() -> str | None:
    if os.environ.get('FAL_KEY'):
        return 'fal'
    if os.environ.get('REPLICATE_API_TOKEN'):
        return 'replicate'
    return None


def _gen_fal(prompt, seed, size, negative):
    import requests
    w, h = size
    key = os.environ['FAL_KEY']
    resp = requests.post(
        'https://fal.run/fal-ai/fast-sdxl',
        headers={'Authorization': f'Key {key}'},
        json={
            'prompt': prompt, 'negative_prompt': negative, 'seed': seed,
            'image_size': {'width': w, 'height': h}, 'num_images': 1,
        },
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    images = data.get('images') or []
    if not images:
        raise RuntimeError(f'fal.ai returned no images: {data}')
    img_resp = requests.get(images[0]['url'], timeout=60)
    img_resp.raise_for_status()
    return img_resp.content


def _gen_replicate(prompt, seed, size, negative):
    import requests
    w, h = size
    token = os.environ['REPLICATE_API_TOKEN']
    headers = {'Authorization': f'Token {token}', 'Content-Type': 'application/json'}
    resp = requests.post(
        'https://api.replicate.com/v1/models/stability-ai/sdxl/predictions',
        headers=headers,
        json={'input': {
            'prompt': prompt, 'negative_prompt': negative, 'seed': seed,
            'width': w, 'height': h,
        }},
        timeout=30,
    )
    resp.raise_for_status()
    prediction = resp.json()
    get_url = prediction['urls']['get']
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        r = requests.get(get_url, headers=headers, timeout=30)
        r.raise_for_status()
        prediction = r.json()
        if prediction['status'] == 'succeeded':
            break
        if prediction['status'] in ('failed', 'canceled'):
            raise RuntimeError(f'Replicate prediction {prediction["status"]}: {prediction.get("error")}')
        time.sleep(2.0)
    else:
        raise RuntimeError('Replicate prediction did not finish within 180s')
    output = prediction['output']
    url = output[0] if isinstance(output, list) else output
    img_resp = requests.get(url, timeout=60)
    img_resp.raise_for_status()
    return img_resp.content


def generate(prompt: str, seed: int, size: tuple[int, int], negative: str, *,
             asset_class: str = 'texture', params: dict | None = None) -> bytes:
    del asset_class, params
    provider = pick_provider()
    if provider is None:
        raise RuntimeError('No hosted backend key set (FAL_KEY or REPLICATE_API_TOKEN)')
    if provider == 'fal':
        return _gen_fal(prompt, seed, size, negative)
    return _gen_replicate(prompt, seed, size, negative)
