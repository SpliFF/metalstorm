"""gen_ms_port_crane — assemble ms_port_crane and export .gltf/.bin.

Named resource site (spec: 20 m rail-mounted port gantry crane — portal
legs, box-girder jib, traversing trolley + hanging hook block, operator
cab with warm emissive windows, <=1800 tris, map prop, no team).
Two pieces: static `body` and the traversing `trolley` (idle clip:
ABSOLUTE translation keys along the jib z axis, seamless sinusoid loop).
Run: python3 gen_ms_port_crane.py -> out/ms_port_crane{,_png}.gltf + .bin
"""
import numpy as np

import ms_port_crane_layout as F       # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export

STEM = 'ms_port_crane'
OUT = 'out'


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def build_rails(p):
    for sz in (-1, 1):
        z = sz * F.RAIL_Z
        box(p, (0.0, F.RAIL_H / 2, z), (F.RAIL_LEN, F.RAIL_H, F.RAIL_W),
            F.R_RAIL, ch=0.03, skip=('-y',))
        for sx in (-1, 1):  # end stops
            box(p, (sx * F.STOP_X, F.RAIL_H + 0.22, z), (0.5, 0.45, 0.5),
                F.R_DARK, ch=0.04)


def build_portal(p):
    bw, bh, bd = F.BOGIE
    for sx in (-1, 1):
        for sz in (-1, 1):
            bx, bz = sx * F.BOGIE_X, sz * F.RAIL_Z
            box(p, (bx, F.BOGIE_CY, bz), (bw, bh, bd), F.R_BOGIE, ch=0.05)
            # portal leg: bogie top -> portal corner (tapers inward)
            limb(p, (bx, F.BOGIE_CY + bh / 2 - 0.1, bz),
                 (sx * F.LEG_TOP_X, F.LEG_TOP_Y, sz * F.LEG_TOP_Z),
                 F.LEG_R0, F.LEG_R1, F.R_LEG, n=4)
    # sill beams linking bogies along each rail
    for sz in (-1, 1):
        z = sz * F.RAIL_Z
        limb(p, (-F.BOGIE_X, F.BOGIE_CY + 0.2, z),
             (F.BOGIE_X, F.BOGIE_CY + 0.2, z), F.SILL_R, F.SILL_R,
             F.R_SILL, n=4)
    # X-bracing on both x-side faces (between front and back legs)
    for sx in (-1, 1):
        lo = (F.BOGIE_X * 0.82, 3.2)
        hi = (F.LEG_TOP_X * 1.25, 9.5)
        for (za, zb) in ((-1, 1), (1, -1)):
            limb(p, (sx * lo[0], lo[1], za * (F.RAIL_Z - 0.15)),
                 (sx * hi[0], hi[1], zb * (F.LEG_TOP_Z + 0.1)),
                 F.BRACE_R, F.BRACE_R, F.R_SILL, n=4)
    # portal top beams
    pw, ph, pd = F.PORTAL
    for sx in (-1, 1):
        box(p, (sx * F.LEG_TOP_X, F.PORTAL_CY, 0.0), (pw, ph, pd),
            F.R_PORTAL, ch=0.05)
    # cross beams tying portal tops under the boom
    for sz in (-1, 1):
        box(p, (0.0, F.PORTAL_CY + 0.15, sz * 2.2),
            (2 * F.LEG_TOP_X + 0.95, 0.5, 0.8), F.R_PORTAL, ch=0.04)


def build_boom(p):
    x, y, z, w, h, d = F.BOOM
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': F.R_BOOM_S, '-x': F.R_BOOM_S, '+y': F.R_BOOM_T,
                 '-y': F.R_BOOM_T, '+z': F.R_STEELG, '-z': F.R_STEELG})
    # A-frame apex above the portal
    for sx in (-1, 1):
        limb(p, (sx * 1.8, 14.55, 1.0), (0.0, 19.55, 1.0),
             F.APEX_R0, F.APEX_R1, F.R_TIE, n=4)
    ax, ay, az, aw, ah, ad = F.APEX
    box(p, (ax, ay, az), (aw, ah, ad), F.R_STEELG, ch=0.05)
    # aviation beacon on the apex (emissive amber)
    box(p, (0.0, 20.05, 1.0), (0.22, 0.22, 0.22), F.R_BEACON, ch=0.03)
    # tie rods apex -> jib tip and apex -> backreach
    limb(p, (0.0, 19.5, 1.0), (0.0, 14.7, F.BOOM_TIP_Z + 0.4),
         F.TIE_R, F.TIE_R, F.R_TIE, n=4)
    limb(p, (0.0, 19.5, 1.0), (0.0, 14.7, 4.6), F.TIE_R, F.TIE_R,
         F.R_TIE, n=4)
    # machinery house on the backreach
    hx, hy, hz, hw, hh, hd = F.HOUSE
    chamfer_box(p, (hx, hy, hz), (hw, hh, hd), 0.05,
                {'+x': F.R_HOUSE_S, '-x': F.R_HOUSE_S, '+y': F.R_HOUSE_T,
                 '-y': F.R_DARK, '+z': F.R_HOUSE_F, '-z': F.R_HOUSE_F})
    sx_, sz_ = F.STACK
    limb(p, (sx_, 16.25, sz_), (sx_, 17.0, sz_), 0.09, 0.09, F.R_TIE,
         n=4, cap_end=F.R_DARK)


def build_cab(p):
    cx, cy, cz, cw, ch_, cd = F.CAB
    chamfer_box(p, (cx, cy, cz), (cw, ch_, cd), 0.05,
                {'+x': F.R_CAB_S, '-x': F.R_CAB_S, '+y': F.R_CAB_T,
                 '-y': F.R_DARK, '+z': F.R_CAB_F, '-z': F.R_CAB_F})
    # hanger struts from boom underside to cab roof
    for dz in (-0.8, 0.8):
        limb(p, (0.85, F.BOOM_BOT, cz + dz), (cx, cy + ch_ / 2, cz + dz),
             0.08, 0.08, F.R_SILL, n=4)


def build_body():
    p = Part('body')
    build_rails(p)
    build_portal(p)
    build_boom(p)
    build_cab(p)
    return p


def build_trolley():
    p = Part('trolley')
    x, y, z, w, h, d = F.TR_FRAME
    box(p, (x, y, z), (w, h, d), F.R_TROLLEY, ch=0.04)
    # sheave housings under the frame
    for sx in (-1, 1):
        box(p, (sx * F.TR_SHEAVE, -0.45, 0.0), (0.35, 0.45, 0.9),
            F.R_MECH, ch=0.03)
    # hoist cables down to the hook block
    for sx in (-1, 1):
        limb(p, (sx * F.TR_SHEAVE, -0.62, 0.0), (sx * 0.16, F.HOOK_Y, 0.0),
             0.035, 0.035, F.R_CABLE, n=3)
    # hook block + hook
    hx, hy, hz, hw, hh, hd = F.HOOK_BLK
    box(p, (hx, hy, hz), (hw, hh, hd), F.R_HOOK, ch=0.04)
    limb(p, (0.0, hy - hh / 2, 0.0), (0.0, hy - hh / 2 - 0.3, 0.05),
         0.08, 0.07, F.R_HOOK.rect, n=4)
    limb(p, (0.0, hy - hh / 2 - 0.3, 0.05), (0.05, hy - hh / 2 - 0.42, -0.22),
         0.07, 0.05, F.R_HOOK.rect, n=4)
    return p


def build_clips():
    """Idle traverse: ABSOLUTE node-translation keys, sinusoid along z.
    Last key equals the first -> seamless loop."""
    ox, oy, oz = F.TROLLEY_OFF
    T, A, N = F.TRAV_PERIOD, F.TRAV_AMP, 16
    keys = [(T * i / N, (ox, oy, oz + A * float(np.sin(2 * np.pi * i / N))))
            for i in range(N + 1)]
    return [{'name': 'idle', 'channels': [('trolley', 'translation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='trolley', parent=0, offset=F.TROLLEY_OFF,
             part=build_trolley()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
