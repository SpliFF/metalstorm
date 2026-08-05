"""validate — engine-readiness checks for a native model .gltf.

Reimplements client/src/core/model-validate.ts (tri budget, required
pieces, team mask on materials[0], clip names, SPRINGRTS_geometry) plus
piece/parent + POSITION min/max sanity. Usage:

    python3 validate.py out/fable_tank.gltf [tri_budget] [piece,piece,...]
                        [--no-team]

--no-team skips the team-mask check for models that are never team-owned:
map props (tools/mapgen/gen_vegetation_models.py) ship diffuse + ORM only.
"""
import json
import sys

argv = [a for a in sys.argv[1:] if not a.startswith('--')]
want_team = '--no-team' not in sys.argv

path = argv[0] if len(argv) > 0 else 'out/fable_tank.gltf'
budget = int(argv[1]) if len(argv) > 1 else 2000
required = (argv[2].split(',') if len(argv) > 2 else
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

if want_team:
    mat0 = (doc.get('materials') or [{}])[0]
    mask = mat0.get('extensions', {}).get('SPRINGRTS_team_color', {}) \
               .get('maskTexture', {}).get('index')
    print(f"team mask mat[0]: {'OK (texture %s)' % mask if isinstance(mask, int) else 'FAIL'}")
    if not isinstance(mask, int):
        fails.append('team mask')
else:
    print("team mask mat[0]: skipped (--no-team)")

geo = doc.get('extensions', {}).get('SPRINGRTS_geometry')
ok_geo = bool(geo) and 'SPRINGRTS_geometry' in doc.get('extensionsUsed', [])
ver = geo.get('configVersion') if geo else None
print(f"engine geometry : {'OK (configVersion %s)' % ver if ok_geo and (ver or 0) >= 8 else 'FAIL'}")
if not ok_geo or (ver or 0) < 8:
    fails.append('SPRINGRTS_geometry')

allowed = {'walk', 'idle', 'death', 'open', 'unload'}
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
