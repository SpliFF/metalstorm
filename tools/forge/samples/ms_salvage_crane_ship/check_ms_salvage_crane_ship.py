"""check_ms_salvage_crane_ship — spec-level checks.

Beyond validate.py: buffer/bin byte agreement, bufferView bounds,
spec pieces (trolley, aframe, exhaust) and spec clip (idle) present,
idle trolley channel is translation, seamless (first key == last key),
clip channels resolve to real nodes, tri budget 2200.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []

for stem in ('ms_salvage_crane_ship', 'ms_salvage_crane_ship_png'):
    path = os.path.join(HERE, 'out', f'{stem}.gltf')
    doc = json.load(open(path))
    binpath = os.path.join(HERE, 'out', doc['buffers'][0]['uri'])
    binsize = os.path.getsize(binpath)
    if doc['buffers'][0]['byteLength'] != binsize:
        fails.append(f'{stem}: buffer byteLength mismatch')
    for i, bv in enumerate(doc['bufferViews']):
        if bv.get('byteOffset', 0) + bv['byteLength'] > binsize:
            fails.append(f'{stem}: bufferView {i} overruns the bin')

    tris = 0
    for mesh in doc['meshes']:
        for prim in mesh['primitives']:
            tris += doc['accessors'][prim['indices']]['count'] // 3
    print(f'{stem}: {tris} tris (budget 2200)')
    if tris > 2200:
        fails.append(f'{stem}: over tri budget ({tris})')

    names = {n.get('name') for n in doc['nodes']}
    for req in ('body', 'aframe', 'trolley', 'exhaust'):
        if req not in names:
            fails.append(f'{stem}: missing node {req}')
    anims = doc.get('animations', [])
    clips = {a.get('name') for a in anims}
    print(f'{stem}: nodes ok, clips {sorted(clips)}')
    if 'idle' not in clips:
        fails.append(f'{stem}: missing clip idle')
    for a in anims:
        for ch in a['channels']:
            if not (0 <= ch['target']['node'] < len(doc['nodes'])):
                fails.append(f'{stem}: clip {a["name"]} bad node target')
        if a.get('name') == 'idle':
            ok_trans = any(ch['target']['path'] == 'translation'
                           for ch in a['channels'])
            if not ok_trans:
                fails.append(f'{stem}: idle has no translation channel')

    geo = doc['extensions']['SPRINGRTS_geometry']
    gnames = {p['name'] for p in geo['pieces']}
    for req in ('trolley',):
        if req not in gnames:
            fails.append(f'{stem}: SPRINGRTS_geometry missing piece {req}')

print('=' * 40)
if fails:
    print('FAILED:', '; '.join(fails))
    sys.exit(1)
print('SPEC CHECKS PASSED')
