"""ktx2 encoding for terrain textures via the project's own tools/textureconverter
binary (UASTC, the canonical GPU texture format — see textureconverter's
main.cpp header comment). The binary is a machine-local C++ build product,
not checked in, so this degrades to "PNG only, report what's missing"
rather than failing the run — same policy as the ComfyUI backend not
downloading models.
"""
from __future__ import annotations
import os
import shutil
import subprocess
from pathlib import Path

_CANDIDATE_RELPATHS = [
    'build/debug/tools/textureconverter/textureconverter',
    'build/release/tools/textureconverter/textureconverter',
    'build/prod/tools/textureconverter/textureconverter',
    'build/prod-check/tools/textureconverter/textureconverter',
]


def find_binary(repo_root: Path) -> Path | None:
    for rel in _CANDIDATE_RELPATHS:
        p = repo_root / rel
        if p.is_file() and os.access(p, os.X_OK):
            return p
    found = shutil.which('textureconverter')
    return Path(found) if found else None


def encode_ktx2(repo_root: Path, png_path: Path, ktx2_path: Path,
                 mipmaps: bool = True) -> tuple[bool, str]:
    binary = find_binary(repo_root)
    if binary is None:
        return False, ('textureconverter binary not found under build/*/tools/textureconverter/ — '
                        'build it first (it is not checked in); PNG-only output kept')
    ktx2_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [str(binary), str(png_path), str(ktx2_path), '--encoding', 'uastc']
    if mipmaps:
        cmd.append('--mipmaps')
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return False, f'textureconverter failed: {(result.stderr or result.stdout).strip()[:300]}'
    return True, str(ktx2_path)
