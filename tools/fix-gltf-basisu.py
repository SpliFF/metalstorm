#!/usr/bin/env python3
"""
fix-gltf-basisu — patch glb files emitted by modelimporter so their
texture entries comply with the KHR_texture_basisu extension spec.

The modelimporter routes through Assimp's glb2 exporter, which writes
texture entries as `{"source": 0, "sampler": 0}` even when the image
URI is a `.ktx2` file. Assimp then declares `KHR_texture_basisu` in
`extensionsRequired`. Per spec, when that extension is required,
`source` must live INSIDE `extensions.KHR_texture_basisu` on the
texture, not at the top level. Babylon's loader is strict about this
and throws `Cannot read properties of null (reading 'length')` when
it tries to follow the missing extension path.

This tool walks every .glb in a directory and rewrites the JSON chunk
to move `source` into the proper extension structure for any texture
whose source image has a `.ktx2` URI. Idempotent.

Usage:
    python3 tools/fix-gltf-basisu.py data/games/zk/models
"""
import json
import os
import struct
import sys


def patch_glb(path: str) -> tuple[bool, str]:
    """Rewrite the JSON chunk in `path` if needed.

    Returns (changed, msg). `changed=False` means the file was already
    correct or has no Basis textures; `msg` carries diagnostic detail.
    """
    with open(path, 'rb') as f:
        data = f.read()

    if data[:4] != b'glTF':
        return False, 'not a glb'
    version, total = struct.unpack('<II', data[4:12])
    if version != 2:
        return False, f'unexpected version {version}'

    # Chunk 0 — JSON
    json_len, json_type = struct.unpack('<I4s', data[12:20])
    if json_type != b'JSON':
        return False, f'first chunk type {json_type!r}, not JSON'
    json_bytes = data[20:20 + json_len]
    # Trailing space-padding per spec.
    j = json.loads(json_bytes.rstrip(b'\x20'))

    images = j.get('images') or []
    textures = j.get('textures') or []
    if not images or not textures:
        return False, 'no images/textures'

    # Identify Basis-encoded images by their .ktx2 URI suffix.
    ktx2_image_idx = set()
    for i, img in enumerate(images):
        uri = img.get('uri', '')
        if uri.lower().endswith('.ktx2'):
            ktx2_image_idx.add(i)
    if not ktx2_image_idx:
        return False, 'no .ktx2 images'

    changed = False
    for tex in textures:
        src = tex.get('source')
        if src is None or src not in ktx2_image_idx:
            continue
        # Already moved into extension? Then nothing to do.
        ext = tex.setdefault('extensions', {})
        basisu = ext.get('KHR_texture_basisu')
        if basisu and basisu.get('source') == src:
            # Top-level source still present is invalid per spec; remove.
            if 'source' in tex:
                del tex['source']
                changed = True
            continue
        ext['KHR_texture_basisu'] = {'source': src}
        del tex['source']
        changed = True

    if not changed:
        return False, 'already compliant'

    # Re-encode JSON with 4-byte alignment + 0x20 (space) padding.
    new_json = json.dumps(j, separators=(',', ':')).encode('utf-8')
    pad = (4 - (len(new_json) % 4)) % 4
    new_json += b'\x20' * pad

    # Chunk 1 — BIN (optional). Preserve verbatim so vertex data isn't
    # touched. Also preserve any further chunks the source had.
    rest = data[20 + json_len:]

    new_total = 12 + 8 + len(new_json) + len(rest)
    out = bytearray()
    out += b'glTF'
    out += struct.pack('<II', 2, new_total)
    out += struct.pack('<I4s', len(new_json), b'JSON')
    out += new_json
    out += rest

    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(out)
    os.replace(tmp, path)
    return True, f'rewrote {len(textures)} texture(s)'


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    if not os.path.isdir(root):
        print(f'not a directory: {root}', file=sys.stderr)
        return 1

    changed = 0
    skipped = 0
    errored = 0
    for dirpath, _, files in os.walk(root):
        for name in files:
            if not name.endswith('.glb'):
                continue
            path = os.path.join(dirpath, name)
            try:
                did, msg = patch_glb(path)
            except Exception as e:
                errored += 1
                print(f'[ERR ] {path}: {e}')
                continue
            if did:
                changed += 1
                if changed <= 5:
                    print(f'[fix] {os.path.relpath(path, root)}: {msg}')
            else:
                skipped += 1
    print(f'done: {changed} changed, {skipped} skipped, {errored} errored')
    return 0 if errored == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
