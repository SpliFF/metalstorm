"""check_ms_barricade_set — spec-compliance checks for the barricade kit.

Complements validate.py (whose clip whitelist is walk/idle/death and so
flags the spec-mandated `open` clip): JSON parse, buffer/bin byte
consistency, accessor bounds inside the bin, tri budget 1500, the three
spec ROOT pieces + animated `gate` child, and an `open` clip whose
rotation channel targets the `gate` node.
Usage: python3 check_ms_barricade_set.py out/ms_barricade_set.gltf
"""
import json
import os
import sys

path = sys.argv[1] if len(sys.argv) > 1 else 'out/ms_barricade_set.gltf'
doc = json.load(open(path))          # 1. parses as JSON
fails = []

# 2. buffer byteLength vs .bin, and every bufferView inside it
bin_path = os.path.join(os.path.dirname(path), doc['buffers'][0]['uri'])
bin_len = os.path.getsize(bin_path)
decl = doc['buffers'][0]['byteLength']
if decl != bin_len:
    fails.append(f'buffer byteLength {decl} != bin size {bin_len}')
for i, bv in enumerate(doc['bufferViews']):
    if bv.get('byteOffset', 0) + bv['byteLength'] > bin_len:
        fails.append(f'bufferView {i} overruns bin')
print(f'bin bytes       : {bin_len} declared {decl} '
      f"-> {'OK' if decl == bin_len else 'FAIL'}")

# 3. tri budget
tris = sum(doc['accessors'][p['indices']]['count'] // 3
           for mesh in doc['meshes'] for p in mesh['primitives'])
print(f"tri budget      : {tris} / 1500 -> {'OK' if tris <= 1500 else 'FAIL'}")
if tris > 1500:
    fails.append('tri budget')

# 4. spec pieces: three roots + animated gate child
names = [n.get('name') for n in doc['nodes']]
geo = doc['extensions']['SPRINGRTS_geometry']
parent = {p['name']: p['parent'] for p in geo['pieces']}
order = [p['name'] for p in geo['pieces']]
for root in ('wall', 'corner', 'gate_frame'):
    ok = root in names and parent.get(root) == -1
    print(f"root piece      : {root:<10} -> {'OK' if ok else 'FAIL'}")
    if not ok:
        fails.append(f'root {root}')
gate_ok = 'gate' in names and order[parent.get('gate', -1)] == 'gate_frame'
print(f"gate child      : parent=gate_frame -> {'OK' if gate_ok else 'FAIL'}")
if not gate_ok:
    fails.append('gate child')

# 5. `open` clip targeting the gate node with a rotation channel
anims = {a['name']: a for a in doc.get('animations', [])}
ok = False
if 'open' in anims:
    a = anims['open']
    gate_node = names.index('gate')
    ok = any(c['target']['node'] == gate_node and
             c['target']['path'] == 'rotation' for c in a['channels'])
print(f"clip `open`     : rotation on gate -> {'OK' if ok else 'FAIL'}")
if not ok:
    fails.append('open clip')

print('=' * 40)
if fails:
    print('FAILED:', ', '.join(fails))
    sys.exit(1)
print('SPEC CHECKS PASSED')
