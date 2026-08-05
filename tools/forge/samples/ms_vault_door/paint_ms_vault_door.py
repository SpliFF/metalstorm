"""paint_ms_vault_door — 1024² PBR set for ms_vault_door.

Ancient-tech register: monolithic graphite door, precise segment seams
(8 radial + one concentric ring + hub outline) glowing emissive CYAN —
the only cyan in the game, reserved for exactly this. Nothing bolted,
nothing patched on the door itself. Surroundings are the scavenger world:
earth/rock berm, weathered toppled masonry, half-buried conduit, scorched
ground apron. NO team mask content (--no-team site).
"""
from __future__ import annotations
import os
import numpy as np

import ms_vault_door_layout as L   # sets meshlib.ATLAS = 1024
import paint as Pt
Pt.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

for _f in ('/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
           '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf',
           '/System/Library/Fonts/Supplemental/Arial Bold.ttf'):
    if os.path.exists(_f):
        Pt.FONT = _f
        break

from paint import (Maps, fill, seam_h, jit, shade,
                   AO_BASE, AO_SEAM, AO_DEEP, RNG)

W = 1024
OUT = ('/private/tmp/claude-501/-Users-shannon-WarriorHut-Projects-'
       'springrts-web/a3af7b17-2167-4d4d-9b46-0cec735eddd1/scratchpad/'
       'batch2/ms_vault_door/out')

# ancient graphite + scavenger-world surroundings
MONO     = (62, 64, 70)      # door monolith graphite
MONO_LT  = (70, 72, 78)
MONO_DK  = (46, 48, 54)
CYAN     = (72, 232, 255)    # ancient-tech glow (emissive only)
CYAN_DIM = (24, 66, 74)      # cold diffuse tint inside the seam channels
STONE    = (150, 143, 128)   # collar / masonry stone
STONE_DK = (118, 112, 99)
EARTH    = (112, 92, 66)     # berm earth
EARTH_DK = (88, 72, 52)
ROCKG    = (104, 100, 92)    # rock outcrop grey
SCORCH   = (38, 34, 30)

# door zone geometry in atlas px (Z_DOOR rect (0,0,600,600), win ±5.2 m)
DC = 300.0                        # centre px (x and y)
PXM = 600.0 / 10.4                # px per metre
R_PX = L.DOOR_R * PXM             # ~288
HUB_PX = L.HUB_R * PXM            # ~98
RING_PX = 3.3 * PXM               # concentric seam ring
SEG_N = 8


def _polar(r, a):
    return (DC + r * np.cos(a), DC + r * np.sin(a))


def paint_door(m):
    x0, y0, x1, y1 = L.Z_DOOR.rect
    # stone backing fills the corners (collar annulus + buried back share it)
    fill(m, (x0, y0, x1, y1), dif=STONE_DK, ao=AO_BASE - 14, rough=200,
         metal=10)
    # monolith disc — tone-on-tone segment wedges (baker-safe low contrast)
    for j in range(SEG_N):
        a0 = 2 * np.pi * j / SEG_N + np.pi / SEG_N
        a1 = 2 * np.pi * (j + 1) / SEG_N + np.pi / SEG_N
        pts = [(DC, DC)] + [_polar(R_PX, a0 + (a1 - a0) * t / 6)
                            for t in range(7)]
        tone = 1.0 + 0.05 * ((j % 3) - 1)
        m.d.polygon(pts, fill=jit(shade(MONO, tone), 2))
        m.o.polygon(pts, fill=(AO_BASE, 120, 180))   # smooth, half-metallic
    # precise seam channels: 8 radial + one ring + hub outline
    for j in range(SEG_N):
        a = 2 * np.pi * j / SEG_N + np.pi / SEG_N
        m.d.line([_polar(HUB_PX + 4, a), _polar(R_PX - 4, a)],
                 fill=CYAN_DIM, width=5)
        m.o.line([_polar(HUB_PX + 4, a), _polar(R_PX - 4, a)],
                 fill=(AO_DEEP, 90, 200), width=5)
        m.e.line([_polar(HUB_PX + 6, a), _polar(R_PX - 6, a)],
                 fill=CYAN, width=3)
    for rr, ew in ((RING_PX, 3), (HUB_PX + 2, 3)):
        m.d.ellipse([DC - rr - 2, DC - rr - 2, DC + rr + 2, DC + rr + 2],
                    outline=CYAN_DIM, width=5)
        m.o.ellipse([DC - rr - 2, DC - rr - 2, DC + rr + 2, DC + rr + 2],
                    outline=(AO_DEEP, 90, 200), width=5)
        m.e.ellipse([DC - rr, DC - rr, DC + rr, DC + rr],
                    outline=CYAN, width=ew)
    # outer edge shadow ring (reads as the door standing proud of the collar)
    m.d.ellipse([DC - R_PX, DC - R_PX, DC + R_PX, DC + R_PX],
                outline=MONO_DK, width=6)
    # hub: darker monolith + glyph ring (dim etched marks, faint glow)
    m.d.ellipse([DC - HUB_PX, DC - HUB_PX, DC + HUB_PX, DC + HUB_PX],
                fill=shade(MONO, 0.9))
    m.o.ellipse([DC - HUB_PX, DC - HUB_PX, DC + HUB_PX, DC + HUB_PX],
                fill=(AO_BASE, 110, 190))
    for k in range(12):
        a = 2 * np.pi * k / 12
        gx, gy = _polar(HUB_PX * 0.68, a)
        gl = 8 + (k * 5) % 9
        m.d.line([(gx - gl / 2, gy), (gx + gl / 2, gy)], fill=MONO_DK,
                 width=3)
        if k % 3 == 0:
            m.e.line([(gx - gl / 2, gy), (gx + gl / 2, gy)],
                     fill=shade(CYAN, 0.55), width=2)
    # central eye: brightest glow on the site
    m.d.ellipse([DC - 14, DC - 14, DC + 14, DC + 14], fill=CYAN_DIM)
    m.e.ellipse([DC - 12, DC - 12, DC + 12, DC + 12], fill=CYAN)
    m.o.ellipse([DC - 14, DC - 14, DC + 14, DC + 14], fill=(AO_BASE, 60, 220))

    # rim wrap: monolith flank, one glowing seam line down the middle
    x0, y0, x1, y1 = L.Z_RIM
    fill(m, (x0, y0, x1, y1), dif=MONO_DK, ao=AO_BASE - 10, rough=120,
         metal=180)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, MONO_DK, hi=False)
    m.e.line([(x0 + 2, (y0 + y1) // 2), (x1 - 2, (y0 + y1) // 2)],
             fill=shade(CYAN, 0.8), width=2)
    # hub rim wrap: same family, no glow
    x0, y0, x1, y1 = L.Z_HUBRIM
    fill(m, (x0, y0, x1, y1), dif=shade(MONO, 0.85), ao=AO_BASE - 12,
         rough=120, metal=180)


def paint_collar(m):
    x0, y0, x1, y1 = L.Z_COLLAR
    fill(m, (x0, y0, x1, y1), dif=STONE, ao=AO_BASE - 8, rough=205, metal=8)
    # megalithic joint lines (ancient masonry: precise, not patched)
    for fx in np.linspace(0.04, 0.96, 14):
        sx = int(x0 + (x1 - x0) * fx)
        m.d.line([(sx, y0 + 2), (sx, y1 - 2)], fill=STONE_DK, width=3)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, STONE, hi=False)


def paint_berm(m):
    for rect in (L.Z_BERM_F.rect, L.Z_BERM_B.rect):
        x0, y0, x1, y1 = rect
        fill(m, (x0, y0, x1, y1), dif=EARTH, ao=AO_BASE - 6, rough=225,
             metal=4)
        # rock outcrops + earth mottle
        for _ in range(46):
            bx = x0 + RNG.random() * (x1 - x0 - 60)
            by = y0 + RNG.random() * (y1 - y0 - 30)
            c = jit(ROCKG, 8) if RNG.random() < 0.4 else jit(EARTH_DK, 7)
            m.d.polygon([(bx, by + 10), (bx + 26 + RNG.random() * 34, by),
                         (bx + 52 + RNG.random() * 30, by + 14),
                         (bx + 20, by + 24)], fill=c)
        # scree drift toward the toe (bottom of each zone)
        m.d.rectangle([x0, y1 - 18, x1, y1], fill=jit(EARTH_DK, 4))
    # scorch halo on the front slope around the door (centre of the zone)
    x0, y0, x1, y1 = L.Z_BERM_F.rect
    cx = (x0 + x1) / 2
    for rr, alp in ((300, 0.0), ):
        pass
    for i, rr in enumerate((330, 250, 180)):
        col = jit(shade(EARTH_DK, 0.85 - i * 0.12), 4)
        m.d.ellipse([cx - rr, y1 - 90 - rr * 0.5, cx + rr,
                     y1 + 40 + rr * 0.2], outline=col, width=26)


def paint_rock(m):
    x0, y0, x1, y1 = L.Z_ROCK.rect
    fill(m, (x0, y0, x1, y1), dif=STONE, ao=AO_BASE - 10, rough=215, metal=6)
    # block edge chips + cracks + one carved groove band (ancient masonry)
    for _ in range(26):
        bx = x0 + RNG.random() * (x1 - x0 - 40)
        by = y0 + RNG.random() * (y1 - y0 - 20)
        m.d.line([(bx, by), (bx + 14 + RNG.random() * 30,
                             by + 8 + RNG.random() * 18)],
                 fill=STONE_DK, width=2)
    m.d.rectangle([x0, y0 + (y1 - y0) // 3 - 6, x1,
                   y0 + (y1 - y0) // 3 + 6], fill=STONE_DK)
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 10, 210, 6))


def paint_pipe_ground(m):
    # conduit: ancient dark alloy, one faint cyan tracer line
    x0, y0, x1, y1 = L.Z_PIPE
    fill(m, (x0, y0, x1, y1), dif=MONO_DK, ao=AO_BASE - 14, rough=140,
         metal=160)
    yy = (y0 + y1) // 2
    m.d.line([(x0 + 2, yy), (x1 - 2, yy)], fill=CYAN_DIM, width=3)
    m.e.line([(x0 + 2, yy), (x1 - 2, yy)], fill=shade(CYAN, 0.5), width=2)
    for fx in (0.2, 0.5, 0.8):
        sx = int(x0 + (x1 - x0) * fx)
        m.d.line([(sx, y0 + 2), (sx, y1 - 2)], fill=shade(MONO_DK, 0.7),
                 width=4)
    # scorched apron: dark burnt ground fading to earth at the far edge
    x0, y0, x1, y1 = L.Z_GROUND.rect
    fill(m, (x0, y0, x1, y1), dif=EARTH, ao=AO_BASE - 8, rough=230, metal=4)
    # v-down: near-door edge is y1 (world z1 = -0.5); scorch strongest there
    steps = 10
    for i in range(steps):
        t = i / (steps - 1)
        band_y0 = int(y1 - (y1 - y0) * 0.75 * (1 - t))
        col = tuple(int(s + (e - s) * t) for s, e in zip(SCORCH, EARTH))
        if i < steps - 1:
            m.d.rectangle([x0, band_y0, x1, y1], fill=jit(col, 3))
    # debris flecks on the burnt ground
    for _ in range(60):
        gx = x0 + RNG.random() * (x1 - x0)
        gy = y0 + (0.4 + 0.6 * RNG.random()) * (y1 - y0)
        m.d.ellipse([gx - 3, gy - 2, gx + 3, gy + 2],
                    fill=jit(ROCKG if RNG.random() < 0.5 else SCORCH, 8))


def paint_all():
    m = Maps()
    paint_door(m)
    paint_collar(m)
    paint_berm(m)
    paint_rock(m)
    paint_pipe_ground(m)

    # ── weathering: the world weathers, the door does not ──
    from weathering import Weather
    wx = Weather(seed=61)
    wx.crevice_grime(m.dif, 0.35)
    # dust film only on the buried lower arc of the door face
    x0, y0, x1, y1 = L.Z_DOOR.rect
    wx.mud_band((x0, int(y0 + (y1 - y0) * 0.7), x1, y1), 0.5, fade='up',
                dust=0.4)
    wx.mud_band(L.Z_COLLAR, 0.45, fade='down', dust=0.3)
    wx.soot_patch(L.Z_GROUND.rect, 0.5)
    wx.soot_patch((x0 + 120, y1 - 200, x1 - 120, y1 - 40), 0.25)
    wx.mud_band(L.Z_ROCK.rect, 0.5, fade='down', dust=0.35)
    wx.mud_band(L.Z_PIPE, 0.55, fade=None, dust=0.4)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # door seams recessed (radial + rings)
    for j in range(SEG_N):
        a = 2 * np.pi * j / SEG_N + np.pi / SEG_N
        hm.line(_polar(HUB_PX + 4, a), _polar(R_PX - 4, a), -0.6, width=4)
    for rr in (RING_PX, HUB_PX + 2):
        segs = 48
        for s in range(segs):
            a0 = 2 * np.pi * s / segs
            a1 = 2 * np.pi * (s + 1) / segs
            hm.line(_polar(rr, a0), _polar(rr, a1), -0.6, width=4)
    # collar joints recessed
    x0, y0, x1, y1 = L.Z_COLLAR
    for fx in np.linspace(0.04, 0.96, 14):
        sx = x0 + (x1 - x0) * fx
        hm.line((sx, y0 + 2), (sx, y1 - 2), -0.5, width=3)
    hm.crevices_from(m.dif, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.0).save(f'{OUT}/ms_vault_door_normals.png')

    # team mask stays empty (--no-team site); emissive holds the cyan life
    m.dif.save(f'{OUT}/ms_vault_door_diffuse.png')
    m.orm.save(f'{OUT}/ms_vault_door_orm.png')
    m.emi.save(f'{OUT}/ms_vault_door_emissive.png')
    m.tea.save(f'{OUT}/ms_vault_door_team.png')
    print('[paint_ms_vault_door] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
