"""gltf_export — generic .gltf/.bin writer for springrts-web native models.

Takes a flat `pieces` list (dicts of name/parent/offset/part where `part`
is a meshlib.Part or None for empty attachment pieces) and writes
<outdir>/<stem>.gltf (KTX2 URIs) or <stem>_png.gltf (PNG URIs, preview),
sharing one <stem>.bin. Computes the SPRINGRTS_geometry extension
(configVersion 8: bounds, height, midpos, radius, piece tree) from the
parts. Unit-agnostic — see gen.py for a worked assembly.
"""
from __future__ import annotations
import json
import numpy as np

# ── World-scale contract ────────────────────────────────────────────────
# 8 elmos = 1 metre (PLAN-world-scale.md §5 Option A, USER-DECIDED
# 2026-08-27; DESIGN-MODEL-BUILDING.md §4/§12). Forge layouts keep
# authoring at 1 unit = 1 METRE — that half was never in doubt — and this
# writer converts to ELMOS at export, because the sim consumes every
# SPRINGRTS_geometry quantity (radius/height/midpos/mins/maxs/piece
# offsets) as elmos and builds the collision AND selection volumes from
# them (ModelConfigLoader.cpp → Unit.cpp), so the scale cannot be
# render-only. Positions, offsets and animation *translation* channels
# scale; normals, UVs, rotations and times are dimensionless.
# Sources already authored in elmos (the map-feature corpus,
# tools/mapgen/gen_vegetation_models.py) pass units='elmo' and are NOT
# scaled — a blanket scale over them is a defect.
# The same constant lives in tools/modelimporter/GeometryExtractor.h
# (kElmosPerMetre) and tools/scripts/rescale_models_to_elmos.py.
ELMOS_PER_METRE = 8.0


def f3(v):
    return [round(float(x), 5) for x in v]


def abounds(arr):
    """Exact float32 bounds for an accessor min/max — NOT f3().

    The .bin stores float32; f3()'s round-to-5-decimals can move a bound
    *inside* the actual data (e.g. declared min -1.83 vs stored float32
    -1.8300000429), which the Khronos validator flags as "accessor element
    less than declared minimum" (742 such violations on fable_colossus, and
    the class of drift that corrupts Babylon's thin-instance bounding boxes).
    float(np.float32) yields the exact stored value, so the bound is tight
    and never crossed."""
    return [float(x) for x in arr]


def world_offset(pieces, i):
    off = np.zeros(3)
    while i >= 0:
        off += np.asarray(pieces[i]['offset'], dtype=float)
        i = pieces[i]['parent']
    return off


DEFAULT_TEXTURE_MAPS = ('diffuse', 'orm', 'emissive', 'team')


def export(pieces, stem, texmode='ktx2', outdir='out', clips=None,
           normal_map=False, texture_maps=DEFAULT_TEXTURE_MAPS,
           units='m'):
    """units: what the caller's `pieces` (and clips) are authored in.
    'm' (the default, DESIGN-MODEL-BUILDING.md §4 — every unit/building
    layout) converts by ELMOS_PER_METRE at write time so the emitted
    .gltf/.bin and SPRINGRTS_geometry land in ELMOS, the unit the sim
    consumes. 'elmo' passes through unscaled (the map-feature corpus,
    already on the engine's scale). The output always records
    SPRINGRTS_geometry.units = 'elmos'.

    texture_maps: which of the PBR set this model actually ships.
    Units use the full four (`DEFAULT_TEXTURE_MAPS`); map props such as
    the vegetation set (tools/mapgen/gen_vegetation_models.py) ship only
    ('diffuse', 'orm') — no emissive, and no team colour, since features
    are never team-owned. Slots that are absent are omitted from the
    material (and SPRINGRTS_team_color from extensionsUsed) rather than
    pointed at a black placeholder nobody has to download.

    clips (optional): authored animation clips —
        [{'name': 'walk',
          'channels': [(piece_name, 'rotation'|'translation'|'scale',
                        [(t_sec, value), ...]), ...]}, ...]
    Values: rotation = quaternion (x,y,z,w); translation/scale = (x,y,z).
    Translation values are ABSOLUTE node translations (rest offset + delta).
    Clip names must be walk/idle/death (model-validate.ts). For seamless
    loops the last key should repeat the first. Nodes are emitted with TRS
    (never `matrix`) so animation channels are spec-legal."""
    import os
    os.makedirs(outdir, exist_ok=True)

    if units not in ('m', 'elmo'):
        raise ValueError(f"units must be 'm' or 'elmo', got {units!r}")
    # metre→elmo world-scale (see ELMOS_PER_METRE above). Exact in
    # float32: ×8 only shifts the exponent.
    scale = ELMOS_PER_METRE if units == 'm' else 1.0

    # ── binary buffer ──
    blob = bytearray()
    views = []
    accessors = []
    meshes = []
    piece_mesh_index = {}

    def add_view(data_bytes, target):
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        blob.extend(data_bytes)
        v = dict(buffer=0, byteOffset=off, byteLength=len(data_bytes))
        if target is not None:  # animation data views carry no target
            v['target'] = target
        views.append(v)
        return len(views) - 1

    for pi, pc in enumerate(pieces):
        part = pc['part']
        if part is None or not part.pos:
            continue
        # positions carry the world scale; normals are dimensionless
        pos = np.array(part.pos, dtype=np.float32) * np.float32(scale)
        nrm = np.array(part.nrm, dtype=np.float32)
        uv = np.array(part.uv, dtype=np.float32)
        idx = np.array(part.idx, dtype=np.uint32)

        vp = add_view(pos.tobytes(), 34962)
        vn = add_view(nrm.tobytes(), 34962)
        vt = add_view(uv.tobytes(), 34962)
        vi = add_view(idx.tobytes(), 34963)

        ap = len(accessors)
        accessors.append(dict(bufferView=vp, byteOffset=0, componentType=5126,
                              count=len(pos), type='VEC3',
                              min=abounds(pos.min(axis=0)),
                              max=abounds(pos.max(axis=0))))
        an = len(accessors)
        accessors.append(dict(bufferView=vn, byteOffset=0, componentType=5126,
                              count=len(nrm), type='VEC3'))
        at = len(accessors)
        accessors.append(dict(bufferView=vt, byteOffset=0, componentType=5126,
                              count=len(uv), type='VEC2'))
        ai = len(accessors)
        accessors.append(dict(bufferView=vi, byteOffset=0, componentType=5125,
                              count=len(idx), type='SCALAR'))
        piece_mesh_index[pi] = len(meshes)
        meshes.append(dict(primitives=[dict(
            attributes=dict(POSITION=ap, NORMAL=an, TEXCOORD_0=at),
            indices=ai, material=0, mode=4)]))

    # ── nodes (TRS, never `matrix` — animated nodes forbid matrix) ──
    # The scene root adopts every parentless piece (parent == -1): a
    # hardcoded children=[1] would silently drop extra roots in a
    # multi-root assembly.
    root_node = dict(name=f'MS_{stem}')
    nodes = [root_node]
    node_of_piece = {}
    for pi in range(len(pieces)):
        node_of_piece[pi] = len(nodes)
        nodes.append(dict(name=pieces[pi]['name']))
    root_kids = [node_of_piece[pi] for pi, pc in enumerate(pieces)
                 if pc['parent'] < 0]
    if root_kids:
        root_node['children'] = root_kids
    for pi, pc in enumerate(pieces):
        nd = nodes[node_of_piece[pi]]
        kids = [node_of_piece[ci] for ci, c in enumerate(pieces)
                if c['parent'] == pi]
        if kids:
            nd['children'] = kids
        if pi in piece_mesh_index:
            nd['mesh'] = piece_mesh_index[pi]
        if any(abs(o) > 1e-9 for o in pc['offset']):
            nd['translation'] = [float(o) * scale for o in pc['offset']]

    # ── animations ──
    piece_index_by_name = {pc['name']: i for i, pc in enumerate(pieces)}
    animations = []
    for clip in (clips or []):
        samplers = []
        channels = []
        for (pname, path, keys) in clip['channels']:
            if pname not in piece_index_by_name:
                raise KeyError(f'clip {clip["name"]}: unknown piece {pname}')
            node_idx = node_of_piece[piece_index_by_name[pname]]
            times = np.array([k[0] for k in keys], dtype=np.float32)
            vals = np.array([k[1] for k in keys], dtype=np.float32)
            gpath = {'rotation': 'rotation', 'translation': 'translation',
                     'scale': 'scale'}[path]
            if gpath == 'translation':
                # absolute node translations are lengths → world scale
                vals = vals * np.float32(scale)
            vtype = 'VEC4' if gpath == 'rotation' else 'VEC3'
            vt_in = add_view(times.tobytes(), None)
            vt_out = add_view(vals.tobytes(), None)
            a_in = len(accessors)
            accessors.append(dict(bufferView=vt_in, byteOffset=0,
                                  componentType=5126, count=len(times),
                                  type='SCALAR',
                                  min=abounds([times.min()]),
                                  max=abounds([times.max()])))
            a_out = len(accessors)
            accessors.append(dict(bufferView=vt_out, byteOffset=0,
                                  componentType=5126, count=len(vals),
                                  type=vtype))
            samplers.append(dict(input=a_in, output=a_out,
                                 interpolation='LINEAR'))
            channels.append(dict(sampler=len(samplers) - 1,
                                 target=dict(node=node_idx, path=gpath)))
        animations.append(dict(name=clip['name'], samplers=samplers,
                               channels=channels))

    # bin write happens after animation data lands in the blob
    with open(f'{outdir}/{stem}.bin', 'wb') as f:
        f.write(bytes(blob))

    # ── SPRINGRTS_geometry ──
    geo_pieces = []
    gmin = np.array([1e9] * 3)
    gmax = np.array([-1e9] * 3)
    for pi, pc in enumerate(pieces):
        part = pc['part']
        if part is not None and part.pos:
            mn, mx = part.bounds()
            mn = tuple(v * scale for v in mn)
            mx = tuple(v * scale for v in mx)
        else:
            mn = mx = (0.0, 0.0, 0.0)
        geo_pieces.append(dict(name=pc['name'], parent=pc['parent'],
                               offset=f3(np.asarray(pc['offset'], dtype=float) * scale),
                               mins=f3(mn), maxs=f3(mx)))
        if part is not None and part.pos:
            woff = world_offset(pieces, pi) * scale
            gmin = np.minimum(gmin, np.asarray(mn) + woff)
            gmax = np.maximum(gmax, np.asarray(mx) + woff)
    height = float(gmax[1])
    midpos = np.array([(gmin[0] + gmax[0]) / 2, height / 2,
                       (gmin[2] + gmax[2]) / 2])
    radius = float(np.linalg.norm(gmax - midpos))
    # `units` is an additive field (older readers ignore it): records that
    # the emitted extents are in elmos, and lets one-shot rescale tooling
    # (tools/scripts/rescale_models_to_elmos.py) refuse to double-scale.
    springrts = dict(configVersion=8, height=round(height, 4),
                     midpos=f3(midpos), mins=f3(gmin), maxs=f3(gmax),
                     radius=round(radius, 4), pieces=geo_pieces,
                     units='elmos')

    # ── materials / textures ──
    ext = 'png' if texmode == 'png' else 'ktx2'
    if 'diffuse' not in texture_maps:
        raise ValueError('texture_maps must include "diffuse"')
    slots = list(texture_maps) + (['normals'] if normal_map else [])
    names = [f'{stem}_{s}.{ext}' for s in slots]
    slot_index = {s: i for i, s in enumerate(slots)}
    images = [dict(mimeType=f'image/{ "png" if texmode == "png" else "ktx2"}',
                   uri=n) for n in names]
    ntex = len(names)
    if texmode == 'png':
        textures = [dict(sampler=0, source=i) for i in range(ntex)]
    else:
        textures = [dict(sampler=0,
                         extensions=dict(KHR_texture_basisu=dict(source=i)))
                    for i in range(ntex)]
    pbr = dict(baseColorTexture=dict(index=slot_index['diffuse']),
               metallicFactor=1.0, roughnessFactor=1.0)
    material = dict(name=stem, pbrMetallicRoughness=pbr)
    if 'orm' in slot_index:
        pbr['metallicRoughnessTexture'] = dict(index=slot_index['orm'])
        material['occlusionTexture'] = dict(index=slot_index['orm'])
    if 'emissive' in slot_index:
        material['emissiveTexture'] = dict(index=slot_index['emissive'])
        material['emissiveFactor'] = [1.0, 1.0, 1.0]
    if 'team' in slot_index:
        material['extensions'] = dict(
            SPRINGRTS_team_color=dict(maskTexture=dict(index=slot_index['team'])))
    if normal_map:
        material['normalTexture'] = dict(index=slot_index['normals'])

    used = ['SPRINGRTS_geometry']
    if 'team' in slot_index:
        used.append('SPRINGRTS_team_color')
    required = []
    if texmode != 'png':
        used = ['KHR_texture_basisu'] + used
        required = ['KHR_texture_basisu']

    gltf = dict(
        asset=dict(version='2.0',
                   generator='fable-model-forge 1.0 (Claude Fable 5, hand-built glTF)'),
        scene=0,
        scenes=[dict(nodes=[0])],
        nodes=nodes,
        meshes=meshes,
        accessors=accessors,
        bufferViews=views,
        buffers=[dict(byteLength=len(blob), uri=f'{stem}.bin')],
        samplers=[dict()],
        images=images,
        textures=textures,
        materials=[material],
        extensions=dict(SPRINGRTS_geometry=springrts),
        extensionsUsed=used,
    )
    if animations:
        gltf['animations'] = animations
    if required:
        gltf['extensionsRequired'] = required

    suffix = '_png' if texmode == 'png' else ''
    with open(f'{outdir}/{stem}{suffix}.gltf', 'w') as f:
        json.dump(gltf, f, indent=1)

    tris = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen] {stem}{suffix}.gltf: {tris} tris, '
          f'{len(blob)} bin bytes, height {height:.2f} elmos '
          f'({height / ELMOS_PER_METRE:.2f} m), radius {radius:.2f} elmos')
    print(f'[gen] bounds {f3(gmin)} .. {f3(gmax)}')
    for pc in pieces:
        t = pc['part'].tri_count() if pc['part'] else 0
        print(f'    {pc["name"]:<10} {t:>5} tris')
    return tris


