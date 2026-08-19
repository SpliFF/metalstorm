"""paintlib — high-level painter helpers shared across models.

Sits ON TOP of the toolkit's paint.py / weathering.py / normals.py (which hold
the low-level ops: Maps, fill, seams, bolts, wear, Weather, HeightMap). This
module captures the patterns every batch-1 painter re-derived by hand: zone
coordinate closures, team panels, lights, hazard bands, wheel/hub cells,
scrap patchwork, and the standard weather→normals→save finish ritual.

Usage (workspace painter, after `import <stem>_layout as L`):

    import paint as P; P.W = 1024
    import weathering; weathering.W = 1024
    import normals as NM; NM.W = 1024
    import paintlib as PL

    m = P.Maps()
    u, v = PL.zone_fns(L.CAB_SIDE)
    PL.team_panel(m, PL.nbox(u(-2.4), v(2.0), u(-2.0), v(1.4)), outline=OLIVE_DK)
    ...
    PL.finish(m, L, 'ms_thing', hm=hm)      # saves all five maps to out/
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import paint as P
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade, jit,
                   BOLT_LOG, GLASS, YELLOW, BLACKISH, TEAMGREY, RUBBER,
                   TRACK_MET, STEEL, STEEL_DK,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS)

LAMP = (222, 226, 210)
TAIL_RED = (150, 34, 26)


# ------------------------------------------------------------- coordinates

def zone_fns(zone, W=None):
    """Return (u, v) closures mapping a WORLD coordinate along the zone's
    first/second axis to atlas pixels — the `def u(wz)/def v(wy)` pair every
    painter wrote per zone. Works for any axes pair."""
    W = W or P.W
    ax_u, ax_v = zone.axes
    iu, iv = 'xyz'.index(ax_u), 'xyz'.index(ax_v)

    def u(w):
        pt = [0.0, 0.0, 0.0]
        pt[iu] = w
        return zone.uv(tuple(pt))[0] * W

    def v(w):
        pt = [0.0, 0.0, 0.0]
        pt[iv] = w
        return zone.uv(tuple(pt))[1] * W
    return u, v


def nbox(x0, y0, x1, y1):
    """Normalised pixel rect — flipped-u zones (front/rear faces) may hand
    coordinates in either order."""
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def font(size):
    """Bold truetype with macOS fallbacks — now just paint.font (one source)."""
    return P.font(size)


# ------------------------------------------------------------- stamps

def team_panel(m, box, outline=None, width=2, base=None):
    """Team-owned respray: full-R team mask + a neutral diffuse underneath
    (never bake team colour into diffuse).

    `base` is the diffuse fill under the mask. It defaults to TEAMGREY
    (168,172,176), which is ~90% brighter than the usual gunmetal hull — and
    because the impostor baker flat-shades each triangle from the diffuse at
    its UV centroid, a TEAMGREY fill FLOODS large panels pale in the impostor
    sheet. Pass a colour held near the model's own base grey for any panel
    covering a big quad; six shipped models hand-rolled a local team_zone()
    to do exactly this before `base=` existed."""
    b = nbox(*box)
    m.t.rectangle(b, fill=(255, 0, 0))
    m.d.rectangle(b, fill=base if base is not None else TEAMGREY)
    if outline is not None:
        m.d.rectangle(b, outline=shade(outline, 0.6), width=width)


def glass_rect(m, box, outline=None):
    b = nbox(*box)
    m.d.rectangle(b, fill=GLASS)
    m.o.rectangle(b, fill=(AO_BASE, R_GLASS, M_GLASS))
    if outline is not None:
        m.d.rectangle(b, outline=shade(outline, 0.65), width=2)


def hazard_band(m, box, step=14):
    """Alternating yellow/black chevron band (bumpers, dock edges)."""
    x0, y0, x1, y1 = nbox(*box)
    for i in range(int((x1 - x0) / step) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0 + i * step, y0, min(x0 + (i + 1) * step, x1), y1],
                      fill=c)


def headlight(m, box, on=True, lamp=LAMP):
    """Glass housing + emissive core (functional lights only)."""
    b = nbox(*box)
    m.d.rectangle(b, fill=GLASS)
    m.o.rectangle(b, fill=(AO_SEAM, R_GLASS, M_GLASS))
    if on:
        pad = max(2, int((b[2] - b[0]) * 0.15))
        m.e.rectangle([b[0] + pad, b[1] + pad, b[2] - pad, b[3] - pad],
                      fill=lamp)


def taillight(m, box, on=True, red=TAIL_RED):
    b = nbox(*box)
    m.d.rectangle(b, fill=(52, 22, 20))
    if on:
        pad = max(2, int((b[2] - b[0]) * 0.2))
        m.e.rectangle([b[0] + pad, b[1] + pad, b[2] - pad, b[3] - pad],
                      fill=red)


def wheel_cell(m, rect):
    """Tyre tread cell: near-black rubber + faint banding."""
    x0, y0, x1, y1 = rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 16, rough=R_RUBBER,
         metal=10)
    for gy in range(y0 + 4, y1 - 2, 10):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(RUBBER, 0.8),
                 width=2)


def hub_cell(m, rect, spokes=8, lugs=6):
    """Wheel-hub cell: steel disc, radial spokes, lug bolts. Keep the paint
    N-fold symmetric so a quaternion-looping spin clip reads seamless."""
    x0, y0, x1, y1 = rect
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 10, rough=140,
         metal=M_TRACK)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2 - 10
    for a in np.linspace(0, 2 * np.pi, spokes, endpoint=False):
        m.d.line([(cx + np.cos(a) * rr * 0.2, cy + np.sin(a) * rr * 0.2),
                  (cx + np.cos(a) * rr * 0.85, cy + np.sin(a) * rr * 0.85)],
                 fill=shade(TRACK_MET, 0.6), width=4)
    m.d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=STEEL_DK)
    bolts(m, [(cx + np.cos(a) * 15, cy + np.sin(a) * 15)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, lugs,
                                   endpoint=False)], base=TRACK_MET)


def panel_patchwork(m, box, palette, cols=4, rows=3, bolt_every=2, seed=90210):
    """Mismatched scrap plates (Anarchic register): subdivide the rect into
    panels, each a jittered colour from `palette`, with seams and sparse
    bolts. Deterministic via `seed`."""
    rng = np.random.default_rng(seed)
    x0, y0, x1, y1 = nbox(*box)
    xs = np.linspace(x0, x1, cols + 1)
    ys = np.linspace(y0, y1, rows + 1)
    k = 0
    for i in range(cols):
        for j in range(rows):
            col = palette[int(rng.integers(0, len(palette)))]
            b = [xs[i], ys[j], xs[i + 1], ys[j + 1]]
            m.d.rectangle(b, fill=jit(col, 5))
            m.o.rectangle(b, fill=(AO_BASE - int(rng.integers(0, 14)),
                                   R_ARMOR + int(rng.integers(0, 26)), 40))
            m.d.rectangle(b, outline=shade(col, 0.55), width=2)
            if k % bolt_every == 0:
                bolts(m, [(b[0] + 6, b[1] + 6), (b[2] - 6, b[3] - 6)],
                      base=col)
            k += 1


def roundel_star(m, cx, cy, r, col, ring=True):
    """Five-point star roundel (military stencil)."""
    pts = []
    for i in range(10):
        a = -np.pi / 2 + i * np.pi / 5
        rr = r if i % 2 == 0 else r * 0.42
        pts.append((cx + rr * np.cos(a), cy + rr * np.sin(a)))
    if ring:
        m.d.ellipse([cx - r * 1.3, cy - r * 1.3, cx + r * 1.3, cy + r * 1.3],
                    outline=col, width=3)
    m.d.polygon(pts, fill=col)


# ------------------------------------------------------------- finish ritual

def standard_weather(m, L, ground_rects=(), side_zones=(), seed=41,
                     mud=0.5, grime=0.55, rust_fraction=0.5):
    """Build a Weather with the standard recipe: crevice grime, mud on
    ground-contact cells, fading dust on vertical faces, rust on logged
    bolts. Returns wx so the caller can add extras BEFORE wx.apply(m).

    ground_rects: raw rects of wheel/skirt/base cells (hard mud).
    side_zones:   Zone objects of vertical hull faces (fade-down mud+dust).
    """
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=seed)
    wx.crevice_grime(m.dif, grime)
    for r in ground_rects:
        wx.mud_band(r, mud * 1.4, fade=None)
    for z in side_zones:
        wx.mud_band(z.rect, mud, fade='down', dust=0.3)
    if BOLT_LOG:
        wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=rust_fraction)
    return wx


def finish(m, L, stem, hm=None, wx=None, emissive_blur=0.6, outdir='out'):
    """The standard ending: apply weathering, blur emissive, write ALL FIVE
    maps (normals included). Pass hm=normals.HeightMap() with your proud
    plates/straps already stamped; with hm=None a default HeightMap is built
    from crevices + logged bolts + weathering alone."""
    if wx is not None:
        wx.apply(m)
    if hm is None:
        from normals import HeightMap
        hm = HeightMap()
    hm.crevices_from(m.dif, 0.55)
    if BOLT_LOG:
        hm.bolts_from(BOLT_LOG, 0.5)
    if wx is not None:
        hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save(f'{outdir}/{stem}_normals.png')
    m.emi = m.emi.filter(ImageFilter.GaussianBlur(emissive_blur))
    m.dif.save(f'{outdir}/{stem}_diffuse.png')
    m.orm.save(f'{outdir}/{stem}_orm.png')
    m.emi.save(f'{outdir}/{stem}_emissive.png')
    m.tea.save(f'{outdir}/{stem}_team.png')
    print(f'[paint_{stem}] texture set written to {outdir}/')
