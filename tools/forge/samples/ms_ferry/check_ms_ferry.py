"""check_ms_ferry — spec-level checks for the ferry build.

Beyond validate.py: buffer/bin byte agreement, bufferView bounds,
spec pieces (ramp, ramp2, link1..link4) and spec clip (unload) present,
clip channels resolve to real nodes.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []

for stem in ('ms_ferry', 'ms_ferry_png'):
    path = os.path.join(HERE, 'out', f'{stem}.gltf')
    doc = json.load(open(path))
    binpath = os.path.join(HERE, 'out', doc['buffers'][0]['uri'])
    binsize = os.path.getsize(binpath)
    decl = doc['buffers'][0]['byteLength']
    if decl != binsize:
        fails.append(f'{stem}: buffer byteLength {decl} != bin size {binsize}')
    for i, bv in enumerate(doc['bufferViews']):
        if bv.get('byteOffset', 0) + bv['byteLength'] > binsize:
            fails.append(f'{stem}: bufferView {i} overruns the bin')

    tris = 0
    for mesh in doc['meshes']:
        for prim in mesh['primitives']:
            tris += doc['accessors'][prim['indices']]['count'] // 3
    print(f'{stem}: {tris} tris (budget 1800)')
    if tris > 1800:
        fails.append(f'{stem}: over tri budget ({tris})')

    names = {n.get('name') for n in doc['nodes']}
    for req in ('body', 'ramp', 'ramp2', 'link1', 'link2', 'link3', 'link4'):
        if req not in names:
            fails.append(f'{stem}: missing node {req}')
    clips = {a.get('name') for a in doc.get('animations', [])}
    print(f'{stem}: nodes ok, clips {sorted(clips)}')
    if 'unload' not in clips:
        fails.append(f'{stem}: missing clip unload')
    for a in doc.get('animations', []):
        for ch in a['channels']:
            if not (0 <= ch['target']['node'] < len(doc['nodes'])):
                fails.append(f'{stem}: clip {a["name"]} bad node target')

    geo = doc['extensions']['SPRINGRTS_geometry']
    gnames = {p['name'] for p in geo['pieces']}
    for req in ('ramp', 'ramp2', 'link1', 'link2', 'link3', 'link4'):
        if req not in gnames:
            fails.append(f'{stem}: SPRINGRTS_geometry missing piece {req}')

print('=' * 40)
if fails:
    print('FAILED:', '; '.join(fails))
    sys.exit(1)
print('SPEC CHECKS PASSED')
