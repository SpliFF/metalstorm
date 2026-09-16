"""SVG for faction emblems. The `none` backend already knows its shapes as
vector primitives (backends/none.emblem_shapes) so it writes real SVG
markup directly — no tracing needed. A raster backend (comfy_local/hosted)
has no vector source, so this traces its PNG with `potrace` when present;
without it (TOOLING GAP: potrace not installed) it falls back to an SVG
that embeds the raster, which is a valid .svg file but not a vector trace.
"""
from __future__ import annotations
import base64
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import Image


def write_geometric_svg(shapes: list[dict], out_path: Path, size: int = 100) -> None:
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">']
    for shp in shapes:
        if shp['type'] == 'circle':
            cx, cy, r = shp['cx'] * size, shp['cy'] * size, shp['r'] * size
            attrs = [f'fill="{shp["fill"]}"' if shp.get('fill') else 'fill="none"']
            if shp.get('stroke'):
                attrs.append(f'stroke="{shp["stroke"]}" stroke-width="{shp.get("width", 0.02) * size:.2f}"')
            parts.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" {" ".join(attrs)}/>')
        elif shp['type'] == 'polygon':
            pts = ' '.join(f'{px * size:.2f},{py * size:.2f}' for px, py in shp['points'])
            parts.append(f'<polygon points="{pts}" fill="{shp.get("fill") or "none"}"/>')
    parts.append('</svg>')
    Path(out_path).write_text('\n'.join(parts) + '\n')


def _write_embedded_svg(png_path: Path, svg_path: Path) -> None:
    data = base64.b64encode(Path(png_path).read_bytes()).decode('ascii')
    w, h = Image.open(png_path).size
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
           f'viewBox="0 0 {w} {h}"><image width="{w}" height="{h}" '
           f'href="data:image/png;base64,{data}"/></svg>\n')
    Path(svg_path).write_text(svg)


def trace_to_svg(png_path: Path, svg_path: Path) -> tuple[bool, str]:
    potrace = shutil.which('potrace')
    if potrace is None:
        _write_embedded_svg(png_path, svg_path)
        return False, 'potrace not installed — wrote an embedded-raster .svg fallback (TOOLING GAP)'
    bw = Image.open(png_path).convert('L').point(lambda p: 255 if p > 128 else 0, mode='1')
    fd, pbm_path = tempfile.mkstemp(suffix='.pbm')
    os.close(fd)
    try:
        bw.save(pbm_path)
        result = subprocess.run([potrace, '-s', '-o', str(svg_path), pbm_path],
                                 capture_output=True, text=True)
        if result.returncode != 0:
            _write_embedded_svg(png_path, svg_path)
            return False, f'potrace failed: {result.stderr.strip()[:200]}'
        return True, str(svg_path)
    finally:
        os.unlink(pbm_path)
