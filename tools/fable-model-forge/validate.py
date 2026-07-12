"""validate — engine-readiness checks for a native model .gltf.

Reimplements client/src/core/model-validate.ts (tri budget, required
pieces, team mask on materials[0], clip names, SPRINGRTS_geometry) plus
piece/parent + POSITION min/max sanity. Usage:

    python3 validate.py out/fable_tank.gltf [tri_budget] [piece,piece,...]
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else 'out/fable_tank.gltf'
budget = int(sys.argv[2]) if len(sys.argv) > 2 else 2000
required = (sys.argv[3].split(',') if len(sys.argv) > 3 else
            ['body', 'turret', 'barrel', 'muzzle'])

doc = json.load(open(path))
fails = []

tris = 0
for mesh in doc.get('meshes', []):
    for prim in mesh['primitives']:
        acc = doc['accessors']
        if 'indices' in prim:
            tris += acc[prim['indices']]['count'] // 3
        else:
            tris += acc[prim['attributes']['POSITION']]['count'] // 3
print(f"tri budget      : {tris} / {budget} -> {'OK' if tris <= budget else 'FAIL'}")
if tris > budget:
    fails.append('tri budget')

names = {(n.get('name') or '').lower() for n in doc.get('nodes', [])}
missing = [r for r in required if r.lower() not in names]
print(f"required pieces : {'OK' if not missing else 'MISSING ' + str(missing)}")
if missing:
    fails.append('pieces')

mat0 = (doc.get('materials') or [{}])[0]
mask = mat0.get('extensions', {}).get('SPRINGRTS_team_color', {}) \
           .get('maskTexture', {}).get('index')
print(f"team mask mat[0]: {'OK (texture %s)' % mask if isinstance(mask, int) else 'FAIL'}")
if not isinstance(mask, int):
    fails.append('team mask')

geo = doc.get('extensions', {}).get('SPRINGRTS_geometry')
ok_geo = bool(geo) and 'SPRINGRTS_geometry' in doc.get('extensionsUsed', [])
ver = geo.get('configVersion') if geo else None
print(f"engine geometry : {'OK (configVersion %s)' % ver if ok_geo and (ver or 0) >= 8 else 'FAIL'}")
if not ok_geo or (ver or 0) < 8:
    fails.append('SPRINGRTS_geometry')

allowed = {'walk', 'idle', 'death'}
bad = [a.get('name', '<unnamed>') for a in doc.get('animations', [])
       if a.get('name') not in allowed]
print(f"clips           : {'OK' if not bad else 'BAD ' + str(bad)}")
if bad:
    fails.append('clips')

if geo:
    pieces = geo.get('pieces', [])
    node_names = names
    for i, p in enumerate(pieces):
        par = p.get('parent', -1)
        if par != -1 and not (0 <= par < len(pieces)):
            fails.append(f'piece {p.get("name")} parent index')
        if (p.get('name') or '').lower() not in node_names:
            fails.append(f'piece {p.get("name")} has no matching node')
    print(f"piece tree      : {[(p['name'], p['parent']) for p in pieces]}")

for mesh in doc.get('meshes', []):
    for prim in mesh['primitives']:
        pa = doc['accessors'][prim['attributes']['POSITION']]
        if 'min' not in pa or 'max' not in pa:
            fails.append('POSITION accessor missing min/max')
print(f"POSITION min/max: {'OK' if not any('min/max' in f for f in fails) else 'FAIL'}")

req = doc.get('extensionsRequired', [])
extra = [e for e in req if e != 'KHR_texture_basisu']
print(f"extensionsReq   : {'OK' if not extra else 'FAIL — vanilla loaders will refuse: ' + str(extra)}")
if extra:
    fails.append('extensionsRequired')

print('=' * 40)
if fails:
    print('FAILED:', ', '.join(fails))
    sys.exit(1)
print('ALL CHECKS PASSED')
