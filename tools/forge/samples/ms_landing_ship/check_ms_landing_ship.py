"""check_ms_landing_ship — spec-level checks for the landing ship build.

Beyond validate.py: buffer/bin byte agreement, bufferView bounds,
spec pieces (ramp, link1..link4) and spec clips (unload) present,
clip channels resolve to real nodes.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []

for stem in ('ms_landing_ship', 'ms_landing_ship_png'):
    path = os.path.join(HERE, 'out', f'{stem}.gltf')
    doc = json.load(open(path))                       # parses as JSON
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
    print(f'{stem}: {tris} tris (budget 2500)')
    if tris > 2500:
        fails.append(f'{stem}: over tri budget ({tris})')

    names = {n.get('name') for n in doc['nodes']}
    for req in ('body', 'ramp', 'radar', 'link1', 'link2', 'link3', 'link4',
                'exhaust'):
        if req not in names:
            fails.append(f'{stem}: missing node {req}')
    clips = {a.get('name') for a in doc.get('animations', [])}
    print(f'{stem}: nodes ok, clips {sorted(clips)}')
    for req in ('idle', 'unload'):
        if req not in clips:
            fails.append(f'{stem}: missing clip {req}')
    for a in doc.get('animations', []):
        for ch in a['channels']:
            if not (0 <= ch['target']['node'] < len(doc['nodes'])):
                fails.append(f'{stem}: clip {a["name"]} bad node target')

    geo = doc['extensions']['SPRINGRTS_geometry']
    gnames = {p['name'] for p in geo['pieces']}
    for req in ('ramp', 'link1', 'link2', 'link3', 'link4'):
        if req not in gnames:
            fails.append(f'{stem}: SPRINGRTS_geometry missing piece {req}')

print('=' * 40)
if fails:
    print('FAILED:', '; '.join(fails))
    sys.exit(1)
print('SPEC CHECKS PASSED')
