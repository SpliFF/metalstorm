"""pie_to_glb.py — Warzone 2100 `.pie` → engine-ready `.glb` converter +
normaliser (PLAN-metalstorm-beta-units.md §1/§6).

WHY THIS EXISTS (and why it is NOT the Blender path)
----------------------------------------------------
§6's nominal normalisation step is a Blender-CLI script
(`tools/scripts/normalize_model.py`) that ingests glTF/FBX/OBJ/DAE. Two facts
make that the wrong tool for the WZ2100 conversion wave:

  1. Blender imports none of WZ2100's `.pie` format, so a `.pie` parser is
     needed *regardless* — there is no "just feed it to the existing script".
  2. Blender is not installed in this environment, and `.pie` geometry is
     trivially simple (flat lists of int/float points + triangle indices).

The task brief says to pick "WMIT or a direct .pie parser, whichever proves
less fragile". WMIT is an interactive GUI tool (no headless build here); a
self-contained pure-Python parser with **zero third-party dependencies**
(no Blender, no numpy, no pygltflib — direct glTF-2.0 GLB authoring from the
stdlib) is by far the least fragile, and it makes the harness capture loop
reproducible in CI. So the WZ path gets its own normaliser here, which performs
the same §6 operations the Blender script does for other sources:

  * RH orient   — WZ is Y-up / +Z-forward / left-handed; we negate Z and
                  reverse triangle winding to land in glTF's Y-up RH space
                  (objects3d/README.md: legacyCoordSystem = false).
  * real scale  — uniform scale so the assembly's dominant dimension matches
                  the art/STYLE.md class-scale table (--target-metres).
  * piece names — each part becomes a named glTF node (body / turret /
                  tracks_l / tracks_r / muzzle …) per the §2 convention, so
                  the engine's piece lookup + the model-viewer harness resolve
                  them.
  * budget check — triangle total vs art/STYLE.md budget; warns, never
                  silently truncates.

DELIBERATE DIVERGENCES (called out per the CLAUDE.md no-silent-deviation rule)
-----------------------------------------------------------------------------
  * **No texture bake / faithful WZ colours.** WZ's texture atlas pages
    (`page-14-droid-hubs.png` …) live in a *separate* upstream submodule, not
    the main source tree, and the Metalstorm house style (art/STYLE.md) is
    flat-shaded low-poly with the shared palette anyway. Each part is given a
    flat per-face colour from a STYLE.md palette swatch (chosen by piece role).
    This is intentional for the PoC *comparison baseline*: rendering the WZ
    silhouettes in the same flat-shaded Metalstorm style as the generated
    tank/mech makes them apples-to-apples (they differ only in geometry, which
    is the thing being judged). Faithful WZ texturing would make the
    comparison apples-to-oranges.
  * **doubleSided materials.** Baseline robustness over strict back-face
    culling — a winding mistake shows geometry, not a black hole. Documented,
    revisitable.
  * **SPRINGRTS_geometry not embedded here.** That is `tools/modelimporter`'s
    job (a separate pass, same as the Blender path — see normalize_model.py's
    closing note). ModelConfigLoader derives bounds from the mesh AABB when the
    extension is absent, so a bare multi-node `.glb` still loads; running the
    importer is an optional hardening pass, not a gate.

USAGE
-----
    python3 tools/scripts/pie_to_glb.py \
        --spec tools/scripts/wz_assemblies.json \
        --pie-dir <dir with the .pie parts> \
        --out-dir data/games/metalstorm/objects3d

The spec is a JSON list of model assemblies; see wz_assemblies.json for the
shape. One `.glb` is written per model.
"""
import argparse
import json
import math
import os
import struct
import sys


# ── art/STYLE.md palette atlas (unittextures/atlas_palette.ktx2) ─────────────
# The engine renders units through a ShaderMaterial that samples a *diffuse
# texture* (COLOR_0 vertex colours are ignored — entity-renderer.ts). So flat
# colour is delivered exactly the way native Metalstorm models get it: UV each
# piece onto a swatch cell of the shared 4×4 palette atlas (the same grid
# tools/scripts/make_palette_atlas.py bakes, mirrored from art/STYLE.md). No
# team mask is shipped → the shader's hasTeamMask=0 path makes the sampled
# swatch the final colour.
PALETTE_COLS, PALETTE_ROWS = 4, 4
ROLE_SWATCH = {           # role -> (row, col) in the atlas grid
    'hull_light': (0, 0), 'hull_mid': (0, 1), 'hull_dark': (0, 2), 'armor_plate': (0, 3),
    'accent': (1, 0), 'hazard': (1, 1), 'worn_steel': (1, 2), 'rust': (1, 3),
    'canopy': (2, 0), 'emissive': (2, 1), 'exhaust': (2, 2), 'muzzle_white': (2, 3),
    'concrete': (3, 0), 'building_steel': (3, 1), 'civ_tan': (3, 2), 'contact_dark': (3, 3),
}
PALETTE_ATLAS_URI = 'wz_palette.ktx2'   # copied beside the .gltf in models/


def swatch_uv(role):
    """glTF UV of the swatch cell centre for a colour role (V origin top-left,
    matching the atlas image's top-first row order)."""
    row, col = ROLE_SWATCH.get(role, ROLE_SWATCH['hull_mid'])
    return ((col + 0.5) / PALETTE_COLS, (row + 0.5) / PALETTE_ROWS)


# ── .pie parser ─────────────────────────────────────────────────────────────
class PieMesh:
    """One parsed .pie part: triangles in WZ coordinate space (Y-up, +Z
    forward, left-handed) + its connectors (attachment/muzzle points)."""
    def __init__(self, name):
        self.name = name
        self.tris = []          # list of (v0, v1, v2), each a (x, y, z) tuple
        self.connectors = []    # list of (x, y, z)
        self.tex_w = 256.0
        self.tex_h = 256.0
        self.pie_version = 2


def parse_pie(path):
    with open(path, 'r', errors='replace') as f:
        lines = [ln.strip() for ln in f.read().splitlines()]

    mesh = PieMesh(os.path.splitext(os.path.basename(path))[0])
    i = 0
    n = len(lines)
    points = None
    took_level = False

    def toks(s):
        return s.split()

    while i < n:
        ln = lines[i]
        if not ln:
            i += 1
            continue
        up = ln.upper()

        if up.startswith('PIE '):
            mesh.pie_version = int(toks(ln)[1])
        elif up.startswith('TEXTURE '):
            t = toks(ln)
            # PIE2: "TEXTURE 0 page.png 256 256"; PIE3/4 may omit dims (0/absent)
            if len(t) >= 5:
                try:
                    w, h = float(t[3]), float(t[4])
                    if w > 0 and h > 0:
                        mesh.tex_w, mesh.tex_h = w, h
                except ValueError:
                    pass
        elif up.startswith('POINTS '):
            count = int(toks(ln)[1])
            # Only ingest the FIRST level's points (level 1 = intact model;
            # later levels are damage states / LOD we don't want stacked).
            if took_level:
                i += 1 + count
                continue
            pts = []
            for j in range(count):
                i += 1
                p = toks(lines[i])
                pts.append((float(p[0]), float(p[1]), float(p[2])))
            points = pts
        elif up.startswith('POLYGONS '):
            count = int(toks(ln)[1])
            if took_level:
                i += 1 + count
                continue
            for j in range(count):
                i += 1
                p = toks(lines[i])
                flags = int(p[0], 0) if p[0].lower().startswith('0x') else int(p[0])
                npts = int(p[1])
                idx = [int(p[2 + k]) for k in range(npts)]
                # fan-triangulate polys with >3 vertices; ignore UVs / anim
                # trailer entirely (we flat-colour, so texcoords are unused).
                if points is None:
                    continue
                for k in range(1, npts - 1):
                    a, b, c = idx[0], idx[k], idx[k + 1]
                    if max(a, b, c) < len(points):
                        mesh.tris.append((points[a], points[b], points[c]))
            took_level = True  # ignore any further LEVELs
        elif up.startswith('CONNECTORS '):
            count = int(toks(ln)[1])
            for j in range(count):
                i += 1
                p = toks(lines[i])
                mesh.connectors.append((float(p[0]), float(p[1]), float(p[2])))
        # NORMALS / EVENT / TCMASK / LEVELS / LEVEL / TYPE / SHADOWPOINTS etc.
        # are skipped: NORMALS we recompute (flat), the rest are metadata we
        # don't need. NORMALS has its own count line — skip its data rows too.
        elif up.startswith('NORMALS '):
            count = int(toks(ln)[1])
            i += count  # skip the normal rows (3 per line in PIE3, still 1 row each)
        i += 1

    return mesh


# ── coordinate conversion: WZ (Y-up, +Z fwd, LH) → glTF (Y-up, RH) ──────────
def wz_to_gltf_point(p):
    x, y, z = p
    return (x, y, -z)          # negate Z: LH→RH


def wz_to_gltf_tri(tri):
    a, b, c = (wz_to_gltf_point(v) for v in tri)
    return (a, c, b)           # reverse winding to keep faces outward after Z flip


def face_normal(a, b, c):
    ux, uy, uz = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    vx, vy, vz = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    nx, ny, nz = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return (nx / ln, ny / ln, nz / ln)


# ── GLB writer (stdlib only) ─────────────────────────────────────────────────
class GlbBuilder:
    def __init__(self):
        self.bin = bytearray()
        self.buffer_views = []
        self.accessors = []
        self.meshes = []
        self.nodes = []
        self.materials = []
        self._atlas_mat = None

    def _align(self):
        while len(self.bin) % 4:
            self.bin.append(0)

    def _add_view(self, data, target=None):
        self._align()
        off = len(self.bin)
        self.bin += data
        view = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target is not None:
            view['target'] = target
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def _add_vec3(self, verts, with_minmax=False):
        data = bytearray()
        for v in verts:
            data += struct.pack('<3f', *v)
        view = self._add_view(data, target=34962)  # ARRAY_BUFFER
        acc = {'bufferView': view, 'componentType': 5126, 'count': len(verts), 'type': 'VEC3'}
        if with_minmax and verts:
            mn = [min(v[k] for v in verts) for k in range(3)]
            mx = [max(v[k] for v in verts) for k in range(3)]
            acc['min'], acc['max'] = mn, mx
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def _add_vec2(self, uvs):
        data = bytearray()
        for u, v in uvs:
            data += struct.pack('<2f', u, v)
        view = self._add_view(data, target=34962)
        self.accessors.append({'bufferView': view, 'componentType': 5126,
                               'count': len(uvs), 'type': 'VEC2'})
        return len(self.accessors) - 1

    def atlas_material(self):
        """One shared material for every piece: samples the palette atlas
        (entity-renderer reads materials[0].baseColorTexture as the diffuse).
        Per-piece colour comes from each piece's UVs, not the material."""
        if self._atlas_mat is None:
            self._atlas_mat = len(self.materials)
            self.materials.append({
                'name': 'wz_palette',
                'pbrMetallicRoughness': {
                    'baseColorTexture': {'index': 0},
                    'metallicFactor': 0.0,
                    'roughnessFactor': 0.85,
                },
                'doubleSided': True,
            })
        return self._atlas_mat

    def add_mesh_node(self, name, tris_gltf, role):
        """tris_gltf: list of (a,b,c) already in glTF space. Emits a
        non-indexed flat-shaded primitive; every vertex UVs onto the role's
        palette swatch cell centre (flat per-piece colour)."""
        positions, normals, uvs = [], [], []
        uv = swatch_uv(role)
        for (a, b, c) in tris_gltf:
            nrm = face_normal(a, b, c)
            for v in (a, b, c):
                positions.append(v)
                normals.append(nrm)
                uvs.append(uv)
        pos_acc = self._add_vec3(positions, with_minmax=True)
        nrm_acc = self._add_vec3(normals)
        uv_acc = self._add_vec2(uvs)
        prim = {'attributes': {'POSITION': pos_acc, 'NORMAL': nrm_acc, 'TEXCOORD_0': uv_acc},
                'material': self.atlas_material()}
        mesh_idx = len(self.meshes)
        self.meshes.append({'name': name, 'primitives': [prim]})
        node = {'name': name, 'mesh': mesh_idx}
        self.nodes.append(node)
        return len(self.nodes) - 1

    def add_empty_node(self, name, translation):
        node = {'name': name}
        if translation and any(translation):
            node['translation'] = list(translation)
        self.nodes.append(node)
        return len(self.nodes) - 1

    def _gltf_dict(self, root_nodes, buffer_uri=None, extras=None):
        buf = {'byteLength': len(self.bin)}
        if buffer_uri is not None:
            buf['uri'] = buffer_uri
        gltf = {
            'asset': {'version': '2.0', 'generator': 'pie_to_glb.py (Metalstorm)'},
            'scene': 0,
            'scenes': [{'nodes': root_nodes}],
            'nodes': self.nodes,
            'meshes': self.meshes,
            'materials': self.materials,
            'accessors': self.accessors,
            'bufferViews': self.buffer_views,
            'buffers': [buf],
        }
        # Palette atlas as a KTX2 diffuse texture (KHR_texture_basisu — the
        # form entity-renderer's resolveTextureUri prefers for .ktx2).
        if self._atlas_mat is not None:
            gltf['extensionsUsed'] = ['KHR_texture_basisu']
            gltf['samplers'] = [{'magFilter': 9728, 'minFilter': 9728}]  # NEAREST: no swatch bleed
            gltf['images'] = [{'uri': PALETTE_ATLAS_URI, 'mimeType': 'image/ktx2'}]
            gltf['textures'] = [{'sampler': 0,
                                 'extensions': {'KHR_texture_basisu': {'source': 0}}}]
        if extras:
            gltf['asset']['extras'] = extras
        return gltf

    def write_glb(self, path, root_nodes, extras=None):
        """Single-file GLB (the authored-source artifact for objects3d/)."""
        gltf = self._gltf_dict(root_nodes, buffer_uri=None, extras=extras)
        json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
        while len(json_bytes) % 4:
            json_bytes += b' '
        bin_bytes = bytes(self.bin)
        while len(bin_bytes) % 4:
            bin_bytes += b'\x00'
        total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A))
            f.write(json_bytes)
            f.write(struct.pack('<II', len(bin_bytes), 0x004E4942))
            f.write(bin_bytes)

    def write_gltf_separate(self, gltf_path, root_nodes, extras=None):
        """glTF Separate form (.gltf + sibling .bin) — the form the engine
        actually serves from data/games/<game>/models/ (see A1 of the load-path
        research: the server gate is fs::exists(stem + '.gltf'))."""
        bin_name = os.path.splitext(os.path.basename(gltf_path))[0] + '.bin'
        gltf = self._gltf_dict(root_nodes, buffer_uri=bin_name, extras=extras)
        with open(os.path.join(os.path.dirname(gltf_path), bin_name), 'wb') as f:
            f.write(bytes(self.bin))
        with open(gltf_path, 'w') as f:
            json.dump(gltf, f, separators=(',', ':'))


# ── assembly driver ──────────────────────────────────────────────────────────
def build_model(spec, pie_dir):
    """Returns (GlbBuilder, root_nodes, tri_total, report_lines)."""
    parts = spec['parts']
    parsed = {}          # node name -> PieMesh
    by_pie = {}          # pie filename -> PieMesh (connector lookups)
    for part in parts:
        m = parse_pie(os.path.join(pie_dir, part['pie']))
        parsed[part['node']] = m
        by_pie[part['pie']] = m

    gb = GlbBuilder()
    node_index = {}       # node name -> gltf node idx
    children = {}         # parent name -> [child idx]
    muzzle_added = []     # parent node names that got a muzzle child
    tri_total = 0
    report = []

    # First pass: emit mesh nodes; compute each part's WZ-space world offset so
    # we can measure the assembly bbox for scaling.
    world_offset = {}     # node name -> (x,y,z) accumulated WZ offset
    for part in parts:
        name = part['node']
        m = parsed[name]
        # mount offset (WZ space) from a body connector, else explicit, else 0
        off = (0.0, 0.0, 0.0)
        mount = part.get('mount')
        if mount:
            host = by_pie[mount['pie']]
            ci = mount.get('connector', 0)
            if ci < len(host.connectors):
                off = host.connectors[ci]
        elif 'offset' in part:
            off = tuple(part['offset'])
        world_offset[name] = off

        tris_gltf = [wz_to_gltf_tri(t) for t in m.tris]
        tri_total += len(tris_gltf)
        idx = gb.add_mesh_node(name, tris_gltf, part.get('color', 'hull_mid'))
        node_index[name] = idx
        # node translation = mount offset, converted to glTF space
        if any(off):
            gb.nodes[idx]['translation'] = list(wz_to_gltf_point(off))

        parent = part.get('parent')
        if parent:
            children.setdefault(parent, []).append(idx)

        # optional muzzle empty node: prefer the weapon's authored connector,
        # else derive the barrel tip from the mesh (forward-most = max +Z in
        # WZ space, X centred) so weapons whose .pie ships no CONNECTORS still
        # get a muzzle marker.
        if part.get('add_muzzle'):
            if m.connectors:
                muzzle_wz = m.connectors[0]
            elif m.tris:
                zmax = max(v[2] for t in m.tris for v in t)
                ys = [v[1] for t in m.tris for v in t]
                muzzle_wz = (0.0, (min(ys) + max(ys)) / 2.0, zmax)
            else:
                muzzle_wz = None
            if muzzle_wz is not None:
                mz = gb.add_empty_node('muzzle', wz_to_gltf_point(muzzle_wz))
                children.setdefault(name, []).append(mz)
                muzzle_added.append(name)

    # wire parent→child
    for parent_name, kids in children.items():
        if parent_name in node_index:
            gb.nodes[node_index[parent_name]].setdefault('children', []).extend(kids)

    # roots = parts with no parent
    root_names = [p['node'] for p in parts if not p.get('parent')]
    root_nodes = [node_index[n] for n in root_names]

    # ── scale: measure dominant dimension of the assembled, converted mesh ──
    axis = {'x': 0, 'y': 1, 'z': 2}[spec.get('dominant_axis', 'z')]
    mn, mx = math.inf, -math.inf
    for part in parts:
        name = part['node']
        base = wz_to_gltf_point(world_offset[name])
        for t in parsed[name].tris:
            for v in (wz_to_gltf_tri(t)):
                coord = v[axis] + base[axis]
                mn, mx = min(mn, coord), max(mx, coord)
    extent = (mx - mn) if mx > mn else 1.0
    factor = spec['target_metres'] / extent
    for r in root_nodes:
        gb.nodes[r]['scale'] = [factor, factor, factor]
    report.append(f'  scale: dominant {spec.get("dominant_axis","z")} extent '
                  f'{extent:.1f} wz-units -> {spec["target_metres"]}m (x{factor:.4f})')

    # ── budget check ──
    budget = spec.get('tri_budget')
    if budget:
        status = 'OK' if tri_total <= budget else 'OVER BUDGET'
        report.append(f'  tris: {tri_total} / {budget} budget [{status}]')
        if tri_total > budget:
            report.append(f'  WARNING: {spec["name"]} exceeds tri budget '
                          f'({tri_total} > {budget}) — no auto-decimation; retopo needed')
    else:
        report.append(f'  tris: {tri_total} (unbudgeted — building)')

    pieces = [p['node'] for p in parts] + (['muzzle'] if muzzle_added else [])
    report.append(f'  pieces: {", ".join(pieces)}')
    return gb, root_nodes, tri_total, report


def main():
    ap = argparse.ArgumentParser(prog='pie_to_glb.py')
    ap.add_argument('--spec', required=True, help='JSON assembly spec (list of models)')
    ap.add_argument('--pie-dir', required=True, help='directory holding the source .pie parts')
    ap.add_argument('--models-dir', required=True,
                    help='output dir for the engine-served .gltf + .bin (Separate form)')
    ap.add_argument('--objects3d-dir',
                    help='optional output dir for the single-file .glb authored artifact')
    args = ap.parse_args()

    with open(args.spec) as f:
        specs = json.load(f)
    if isinstance(specs, dict):
        specs = [specs]

    os.makedirs(args.models_dir, exist_ok=True)
    if args.objects3d_dir:
        os.makedirs(args.objects3d_dir, exist_ok=True)

    for spec in specs:
        gb, roots, tris, report = build_model(spec, args.pie_dir)
        extras = {
            'source': 'Warzone 2100 (GPL-2.0-or-later)',
            'parts': [p['pie'] for p in spec['parts']],
            'pipeline': 'tools/scripts/pie_to_glb.py',
        }
        gltf_out = os.path.join(args.models_dir, spec['name'] + '.gltf')
        gb.write_gltf_separate(gltf_out, roots, extras=extras)
        print(f'[pie_to_glb] {spec["name"]} -> {gltf_out} (+ .bin)')
        if args.objects3d_dir:
            glb_out = os.path.join(args.objects3d_dir, spec['name'] + '.glb')
            gb.write_glb(glb_out, roots, extras=extras)
            print(f'[pie_to_glb] {spec["name"]} -> {glb_out}')
        for line in report:
            print(line)
    print('[pie_to_glb] done')


if __name__ == '__main__':
    main()
