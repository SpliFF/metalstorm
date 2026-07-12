"""strip_model — produce a reduced fable_colossus for piece-by-piece bring-up.

Reads the FULL backup model and emits a stripped variant into the game
data dir. Purely stdlib (no numpy). Deterministic clean rebuild of
bin/bufferViews/accessors/meshes/nodes so indices stay valid.

Two reductions, both for isolating the in-game thin-instance render bug:
  1. DROP a set of pieces (and their subtrees) entirely — default: the legs.
  2. Collapse the material to a SINGLE texture reference (baseColor/diffuse),
     dropping orm/emissive/team/normal + the SPRINGRTS_team_color extension
     and all animations (they target dropped nodes).

To add a piece back, delete it from DROP and re-run.

    python3 strip_model.py
"""
import json
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'backup/fable_colossus_200525/fable_colossus.gltf')
DST = os.path.join(HERE, '../../data/games/metalstorm/models/fable_colossus.gltf')

# ── bring-up knobs (edit these, re-run) ────────────────────────────────
# Pieces (and their whole subtree) to remove. Empty set = keep every piece.
LEGS = {'thigh_l', 'shin_l', 'foot_l', 'toes_l',
        'thigh_r', 'shin_r', 'foot_r', 'toes_r'}
DROP = set()          # <-- isolation step: legs BACK IN, single texture
# Which textures to bind on the material. Add back one at a time to find
# which one breaks the in-game thin-instance render. Order in the backup
# is diffuse, orm, emissive, team, normal.
#   {'diffuse'}                     -> known-good (full model renders)
#   {'diffuse','normal'}            -> normal-map hypothesis test
#   {'diffuse','orm','emissive','team','normal'} -> the original (broken)
TEXTURES = {'diffuse', 'orm', 'emissive', 'normal', 'team'}

COMPSIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

g = json.load(open(SRC))
old_bin = open(SRC.replace('.gltf', '.bin'), 'rb').read()
old_bv, old_acc, old_meshes, old_nodes = (
    g['bufferViews'], g['accessors'], g['meshes'], g['nodes'])

new_bin = bytearray()
new_bv, new_acc, new_meshes, new_nodes = [], [], [], []


def pad4():
    while len(new_bin) % 4:
        new_bin.append(0)


def copy_accessor(oai):
    """Copy one accessor's data (de-interleaved to tight packing) into the
    new buffer; return the new accessor index."""
    a = old_acc[oai]
    bv = old_bv[a['bufferView']]
    elem = NCOMP[a['type']] * COMPSIZE[a['componentType']]
    stride = bv.get('byteStride', elem)
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    pad4()
    off = len(new_bin)
    for k in range(a['count']):
        s = base + k * stride
        new_bin.extend(old_bin[s:s + elem])
    view = dict(buffer=0, byteOffset=off, byteLength=len(new_bin) - off)
    if 'target' in bv:
        view['target'] = bv['target']
    new_bv.append(view)
    na = dict(bufferView=len(new_bv) - 1, byteOffset=0,
              componentType=a['componentType'], count=a['count'], type=a['type'])
    if 'min' in a:
        na['min'] = a['min']
    if 'max' in a:
        na['max'] = a['max']
    new_acc.append(na)
    return len(new_acc) - 1


def copy_mesh(omi):
    m = old_meshes[omi]
    prims = []
    for p in m['primitives']:
        attrs = {k: copy_accessor(v) for k, v in p['attributes'].items()}
        np_ = dict(attributes=attrs, mode=p.get('mode', 4), material=0)
        if 'indices' in p:
            np_['indices'] = copy_accessor(p['indices'])
        prims.append(np_)
    new_meshes.append(dict(primitives=prims))
    return len(new_meshes) - 1


old_to_new_node = {}


def emit_node(oni):
    n = old_nodes[oni]
    if n.get('name', '') in DROP:
        return None
    ni = len(new_nodes)
    nn = dict(name=n.get('name', ''))
    for k in ('translation', 'rotation', 'scale'):
        if k in n:
            nn[k] = n[k]
    new_nodes.append(nn)
    old_to_new_node[oni] = ni
    if 'mesh' in n:
        nn['mesh'] = copy_mesh(n['mesh'])
    kids = [c for c in (emit_node(ci) for ci in n.get('children', []))
            if c is not None]
    if kids:
        nn['children'] = kids
    return ni


root = g['scenes'][g.get('scene', 0)]['nodes'][0]
emit_node(root)

# ── SPRINGRTS_geometry: drop legs, re-index parents, recompute bounds ──
geo = g['extensions']['SPRINGRTS_geometry']
old_pieces = geo['pieces']
kept = [i for i, p in enumerate(old_pieces) if p['name'] not in DROP]
remap = {oi: ni for ni, oi in enumerate(kept)}
new_pieces = []
for oi in kept:
    p = dict(old_pieces[oi])
    p['parent'] = remap.get(p['parent'], -1) if p['parent'] != -1 else -1
    new_pieces.append(p)


def world_offset(pieces, i):
    off = [0.0, 0.0, 0.0]
    while i >= 0:
        o = pieces[i]['offset']
        off = [off[0] + o[0], off[1] + o[1], off[2] + o[2]]
        i = pieces[i]['parent']
    return off


gmin = [1e9, 1e9, 1e9]
gmax = [-1e9, -1e9, -1e9]
for i, p in enumerate(new_pieces):
    mn, mx = p.get('mins'), p.get('maxs')
    if not mn or mn == mx:  # empty/structural piece
        continue
    w = world_offset(new_pieces, i)
    for c in range(3):
        gmin[c] = min(gmin[c], mn[c] + w[c])
        gmax[c] = max(gmax[c], mx[c] + w[c])
height = gmax[1]
midpos = [(gmin[0] + gmax[0]) / 2, height / 2, (gmin[2] + gmax[2]) / 2]
radius = sum((gmax[c] - midpos[c]) ** 2 for c in range(3)) ** 0.5
geo.update(height=round(height, 4), midpos=[round(v, 5) for v in midpos],
           mins=[round(v, 5) for v in gmin], maxs=[round(v, 5) for v in gmax],
           radius=round(radius, 4), pieces=new_pieces)

# ── material: bind only the selected textures ──
# Backup image order: diffuse=0, orm=1, emissive=2, team=3, normal=4.
IMG = {'diffuse': 0, 'orm': 1, 'emissive': 2, 'team': 3, 'normal': 4}
backup_images = g['images']
sel = [k for k in ('diffuse', 'orm', 'emissive', 'team', 'normal') if k in TEXTURES]
g['images'] = [backup_images[IMG[k]] for k in sel]
g['textures'] = [dict(sampler=0, extensions=dict(KHR_texture_basisu=dict(source=i)))
                 for i in range(len(sel))]
ti = {k: i for i, k in enumerate(sel)}
pbr = dict(metallicFactor=1.0 if 'orm' in ti else 0.0, roughnessFactor=1.0)
if 'diffuse' in ti:
    pbr['baseColorTexture'] = dict(index=ti['diffuse'])
if 'orm' in ti:
    pbr['metallicRoughnessTexture'] = dict(index=ti['orm'])
mat = dict(name='fable_colossus', pbrMetallicRoughness=pbr)
if 'orm' in ti:
    mat['occlusionTexture'] = dict(index=ti['orm'])
if 'emissive' in ti:
    mat['emissiveTexture'] = dict(index=ti['emissive'])
    mat['emissiveFactor'] = [1.0, 1.0, 1.0]
if 'normal' in ti:
    mat['normalTexture'] = dict(index=ti['normal'])
ext_used = ['KHR_texture_basisu', 'SPRINGRTS_geometry']
if 'team' in ti:
    mat['extensions'] = dict(SPRINGRTS_team_color=dict(maskTexture=dict(index=ti['team'])))
    ext_used.append('SPRINGRTS_team_color')
g['materials'] = [mat]
g['extensionsUsed'] = ext_used
g['extensionsRequired'] = ['KHR_texture_basisu']
# Bring-up is a static render test; clips target nodes we re-index, so drop them.
g.pop('animations', None)

# ── assemble ──
g['nodes'] = new_nodes
g['meshes'] = new_meshes
g['accessors'] = new_acc
g['bufferViews'] = new_bv
g['buffers'] = [dict(byteLength=len(new_bin), uri='fable_colossus.bin')]

with open(DST.replace('.gltf', '.bin'), 'wb') as f:
    f.write(bytes(new_bin))
with open(DST, 'w') as f:
    json.dump(g, f, indent=1)

print(f'stripped: dropped {sorted(DROP) or "(none)"}, textures={sel}')
print(f'  nodes {len(old_nodes)}->{len(new_nodes)}, '
      f'meshes {len(old_meshes)}->{len(new_meshes)}, '
      f'pieces {len(old_pieces)}->{len(new_pieces)}')
print(f'  bin {len(old_bin)}->{len(new_bin)} bytes, '
      f'images {len(g["images"])}, height {height:.2f}, radius {radius:.2f}')
print(f'  bounds {[round(v,2) for v in gmin]} .. {[round(v,2) for v in gmax]}')
