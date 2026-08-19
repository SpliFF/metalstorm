"""paint_ms_subs_s1 — 2048² PBR set for ms_subs_s1 (coastal sub pack boat).

Continuous dark anti-foul finish over the whole boat (runs submerged —
no waterline/boot-top). Near-black grey-green plating, tone-on-tone
patchwork (coastal pack boats are cheap and crudely maintained),
painted limber holes along the casing flank, pale hull-number stencil
+ team panel on the sail flanks, bronze open screw, one tiny emissive
periscope-head dot. Weathering: rust under fittings and limber holes,
algae/salt streaking along the flank, grime at the sail root.
"""
from __future__ import annotations
import numpy as np

import ms_subs_s1_layout as L        # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade, jit,
                   BOLT_LOG, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, M_ARMOR)

W = 2048
STEM = 'ms_subs_s1'

# dark anti-foul register (grey-greens/charcoal, tone-on-tone)
HULL  = (57, 62, 57)
TOPC  = (52, 57, 53)
BELLY = (45, 49, 46)
CASC  = (63, 67, 62)
DECKC = (55, 59, 54)
SAILC = (61, 65, 60)
FINC  = (49, 53, 50)
MASTC = (66, 70, 66)
PROPC = (94, 78, 56)
HOLE  = (26, 28, 27)
STENC = (188, 192, 186)
WARM  = (255, 190, 120)


def near(base, f):
    return tuple(int(c * f) for c in base)


def paint_hull(m):
    # flank: base + tone-on-tone patchwork plating (±15% max)
    z = L.Z_FLANK
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=HULL, ao=AO_BASE - 8, rough=R_ARMOR + 15,
         metal=M_ARMOR - 20)
    PL.panel_patchwork(m, (x0 + 4, y0 + 30, x1 - 4, y1 - 30),
                       [HULL, near(HULL, 1.10), near(HULL, 0.90),
                        near(HULL, 1.05)], cols=9, rows=3, bolt_every=3)
    u, v = PL.zone_fns(z)
    # frame verticals, faint
    for wz in np.arange(-7.5, 8.5, 2.0):
        seam_v(m, int(u(wz)), int(v(1.55)), int(v(-1.55)), HULL, hi=False)

    # top: darker, spine seam
    zt = L.Z_TOP
    r = zt.rect
    fill(m, r, dif=TOPC, ao=AO_BASE - 10, rough=R_ARMOR + 20,
         metal=M_ARMOR - 25)
    ut, vt = PL.zone_fns(zt)
    seam_h(m, r[0] + 3, r[2] - 3, int(vt(0.0)), TOPC, hi=False)
    for wz in np.arange(-7.0, 8.5, 2.0):
        seam_v(m, int(ut(wz)), r[1] + 4, r[3] - 4, TOPC, hi=False)

    # belly: darkest anti-foul, sparse seams
    r = L.Z_BELLY.rect
    fill(m, r, dif=BELLY, ao=AO_BASE - 16, rough=R_ARMOR + 30, metal=30)
    ub, vb = PL.zone_fns(L.Z_BELLY)
    for wz in np.arange(-6.5, 8.0, 3.0):
        seam_v(m, int(ub(wz)), r[1] + 4, r[3] - 4, BELLY, hi=False)


def paint_casing(m):
    # casing flank: limber holes (free-flooding) along the strip
    z = L.Z_CAS_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CASC, ao=AO_BASE - 10, rough=R_ARMOR + 10,
         metal=M_ARMOR - 15)
    u, v = PL.zone_fns(z)
    ym = (y0 + y1) / 2
    for wz in np.arange(-7.0, 6.8, 0.85):
        cx = u(wz)
        m.d.rounded_rectangle([cx - 26, ym - 14, cx + 26, ym + 14],
                              radius=12, fill=HOLE)
        m.o.rounded_rectangle([cx - 26, ym - 14, cx + 26, ym + 14],
                              radius=12, fill=(AO_DEEP, 210, 20))
    seam_h(m, x0 + 3, x1 - 3, y0 + 10, CASC, hi=False)

    # casing deck: transverse tread slats, tone-on-tone
    z = L.Z_CAS_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 8, rough=R_ARMOR + 20,
         metal=M_ARMOR - 20)
    u, v = PL.zone_fns(z)
    for wz in np.arange(-7.9, 7.5, 0.42):
        m.d.line([(u(wz), y0 + 3), (u(wz), y1 - 3)],
                 fill=shade(DECKC, 0.88), width=2)
    # centreline walk lane, slightly paler
    m.d.rectangle([x0 + 3, (y0 + y1) / 2 - 9, x1 - 3, (y0 + y1) / 2 + 9],
                  fill=shade(DECKC, 1.10))


def paint_sail(m):
    # sail flanks (Z_SAIL_S serves both sides; twin zone only re-projects)
    z = L.Z_SAIL_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=SAILC, ao=AO_BASE - 6, rough=R_ARMOR + 10,
         metal=M_ARMOR - 15)
    u, v = PL.zone_fns(z)
    seam_h(m, x0 + 3, x1 - 3, int(v(2.1)), SAILC, hi=False)
    seam_h(m, x0 + 3, x1 - 3, int(v(3.1)), SAILC, hi=False)
    # team panel on the sail flank (base= stops the TEAMGREY flood)
    PL.team_panel(m, PL.nbox(u(-4.35), v(3.62), u(-3.55), v(3.18)),
                  outline=near(SAILC, 0.8), base=(120, 124, 128))
    # pale hull number + class stencil
    f = PL.font(96)
    m.d.text((u(-4.30) + 2, v(2.95) + 2), 'P-07', font=f,
             fill=shade(SAILC, 0.55))
    m.d.text((u(-4.30), v(2.95)), 'P-07', font=f, fill=STENC)
    f2 = PL.font(40)
    m.d.text((u(-4.28), v(2.05)), 'PIKE', font=f2, fill=near(STENC, 0.75))
    # handholds row near the top
    for wz in np.arange(-4.4, -2.8, 0.28):
        m.d.rectangle([u(wz), v(3.75), u(wz) + 10, v(3.68)],
                      fill=shade(SAILC, 0.7))
    wear_edges(m, (x0, y0, x1, y1), SAILC, 40)

    # sail wrap (leading/trailing faces) + top
    r = L.Z_SAIL_WRAP.rect
    fill(m, r, dif=near(SAILC, 0.94), ao=AO_BASE - 8, rough=R_ARMOR + 15,
         metal=M_ARMOR - 15)
    r = L.Z_SAIL_TOP.rect
    fill(m, r, dif=near(TOPC, 1.05), ao=AO_BASE - 8, rough=R_ARMOR + 20,
         metal=M_ARMOR - 20)
    m.d.rectangle([r[0] + 8, r[1] + 8, r[2] - 8, r[3] - 8],
                  outline=shade(TOPC, 0.8), width=2)


def paint_fittings(m):
    # planes: darkest plating
    for zz in (L.Z_PLANE_H, L.Z_PLANE_V):
        r = zz.rect
        fill(m, r, dif=FINC, ao=AO_BASE - 12, rough=R_ARMOR + 20,
             metal=M_ARMOR - 10)
        seam_h(m, r[0] + 4, r[2] - 4, (r[1] + r[3]) // 2, FINC, hi=False)

    # masts / cleats wrap
    fill(m, L.Z_MAST, dif=MASTC, ao=AO_BASE - 8, rough=170, metal=150)
    # periscope wrap: dark steel + single tiny emissive head dot at the tip
    x0, y0, x1, y1 = L.Z_PERI
    fill(m, (x0, y0, x1, y1), dif=near(MASTC, 0.9), ao=AO_BASE - 8,
         rough=160, metal=160)
    m.e.ellipse([x1 - 14, (y0 + y1) / 2 - 4, x1 - 6, (y0 + y1) / 2 + 4],
                fill=WARM)

    # screw: worn bronze; hub darker
    r = L.Z_PROP.rect
    fill(m, r, dif=PROPC, ao=AO_BASE - 10, rough=150, metal=200)
    for fx in (0.3, 0.62):
        seam_v(m, int(r[0] + (r[2] - r[0]) * fx), r[1] + 4, r[3] - 4, PROPC,
               hi=False)
    fill(m, L.Z_HUB, dif=near(PROPC, 0.8), ao=AO_BASE - 12, rough=160,
         metal=190)
    fill(m, L.Z_DARK.rect, dif=(30, 32, 31), ao=AO_DEEP, rough=200, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_casing(m)
    paint_sail(m)
    paint_fittings(m)

    # ── weathering: submerged coastal boat ──
    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.Z_FLANK,), mud=0.35, grime=0.5)
    # rust streaks under the limber holes (casing flank)
    zc = L.Z_CAS_SIDE
    uc, vc = PL.zone_fns(zc)
    ymid = (zc.rect[1] + zc.rect[3]) / 2
    for i, wz in enumerate(np.arange(-7.0, 6.8, 0.85)):
        if i % 2 == 0:
            wx.rust_streak(uc(wz), ymid + 14, 30 + (i % 3) * 14, width=2.6,
                           strength=0.45)
    # salt/algae streaking along the upper flank, under the casing edge
    zf = L.Z_FLANK
    uf, vf = PL.zone_fns(zf)
    for wz in np.arange(-7.6, 8.4, 1.35):
        wx.rust_streak(uf(wz), vf(1.35), 40, width=3.2, strength=0.3)
    wx.mud_band((zf.rect[0], int(vf(1.6)), zf.rect[2], int(vf(0.7))),
                0.35, fade='down', spatter=False)
    # grime at the sail root
    zs = L.Z_SAIL_S
    wx.mud_band((zs.rect[0], int(zs.rect[3] - 60), zs.rect[2], zs.rect[3]),
                0.5, fade=None, spatter=False)
    # prop-wash grime on the aft belly
    zb = L.Z_BELLY
    ubz, _ = PL.zone_fns(zb)
    wx.mud_band((int(ubz(5.0)), zb.rect[1], zb.rect[2], zb.rect[3]), 0.3,
                fade=None, spatter=False)

    PL.finish(m, L, STEM, wx=wx)


if __name__ == '__main__':
    paint_all()
