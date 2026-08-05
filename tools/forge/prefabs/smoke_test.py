"""smoke_test.py — assemble every prefab on one pad, export, bake.
Run from a scratch dir:  python3 $FORGE/prefabs/smoke_test.py
"""
import os, sys
FORGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path[:0] = [os.path.join(os.path.dirname(FORGE), 'fable-model-forge'), os.path.join(FORGE, 'prefabs')]
import numpy as np
import meshlib as M
from meshlib import Part, chamfer_box
from gltf_export import export
import parts as P

Z = P.GREY
body = Part('body')
chamfer_box(body, (0, 0.1, 0), (26, 0.2, 18), 0.04, {k: Z for k in ('+x','-x','+y','+z','-z')}, skip=('-y',))
P.lattice_tower(body, 0.2, 6.0, 1.2, 0.7)
P.ladder(body, (1.35, 0.2, 0), (1.35, 5.8, 0))
P.railing(body, (-12.8, 0.2, -8.8), (12.8, 0.2, -8.8))
P.stairs(body, (-6, 0.2, 3.2), (-6, 2.0, 5.6))
P.crate_stack(body, (-9, 0.2, -3), rng=np.random.default_rng(90210))
P.drum_row(body, (-4.5, 0.2, -5.5))
P.tarp_over(body, (5, 0.2, -4), (3.2, 1.2, 2.6))
P.pipe_run(body, [(8, 0.5, -6), (8, 0.5, -2), (10.5, 0.5, -2), (10.5, 2.2, -2)])
P.tank_cylinder(body, (10.5, 0.2, 2.5))
P.sandbag_wall(body, (-12, 0.2, 7.5), (-4, 0.2, 7.5))
P.antenna(body, (0, 6.0, 0))
P.beacon(body, (0.45, 6.1, 0.45))
pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=body)]
t = P.turret_parts(body_index=0, mount=(6, 1.35, 5), twin=True)
base = len(pieces)
t[1]['parent'] = base
t[2]['parent'] = base + 1
pieces.extend(t)
ax = P.axle_piece('axle_demo', z_off=7.0, y=0.46, r=0.5)
ax['parent'] = 0
pieces.append(ax)
os.makedirs('out', exist_ok=True)
export(pieces, 'prefab_smoke', texmode='png', outdir='out')
tris = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
print('smoke tris:', tris)
