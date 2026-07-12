"""weathering — gritty, physically-placed weathering pass for the forge.

Runs AFTER the base zone painting and deposits four layers where they
would occur in reality, keeping all four PBR maps consistent:

  grime — auto-detected crevices: any pixel meaningfully darker than its
          neighbourhood (panel seams, vents, slots) collects a soft brown
          -black halo. Zero per-seam bookkeeping.
  mud   — height-graded dirt + spatter: heavy near the ground, fading up
          (or along a limb toward the foot). Noise-broken, never uniform.
  rust  — around logged bolt heads (paint helpers record positions) with
          gravity streaks on vertical zones, plus blotch clusters along
          the bottom edges of vertical plates where water sits.
  oil   — dark SHINY grease on joints (roughness goes DOWN, not up).
  soot  — powder burn at muzzles/exhausts; also dims emissive beneath.

Map consistency: dirt/rust/soot raise roughness, kill metallic, darken
AO, and PUNCH THROUGH THE TEAM MASK (mix(base,team,mask) would otherwise
paint team colour over the dirt); oil lowers roughness; soot multiplies
emissive down.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W = 1024

DIRT_COL = np.array([74.0, 60.0, 45.0])
DUST_COL = np.array([110.0, 99.0, 80.0])
RUST_DK = np.array([84.0, 48.0, 30.0])
RUST_LT = np.array([150.0, 95.0, 52.0])
OIL_COL = np.array([26.0, 26.0, 28.0])
SOOT_COL = np.array([24.0, 22.0, 21.0])


def _noise(shape, rng, octaves=((64, 0.5), (128, 0.3), (256, 0.2))):
    """Cheap fractal value noise in [0,1]."""
    h, w = shape
    out = np.zeros(shape, dtype=np.float32)
    for res, amp in octaves:
        base = rng.random((res, res)).astype(np.float32)
        img = Image.fromarray((base * 255).astype(np.uint8)).resize(
            (w, h), Image.BILINEAR)
        out += amp * (np.asarray(img, dtype=np.float32) / 255.0)
    out -= out.min()
    m = out.max()
    return out / m if m > 0 else out


class Weather:
    def __init__(self, seed=7):
        self.rng = np.random.default_rng(seed)
        self.dirt = np.zeros((W, W), dtype=np.float32)   # alpha layers
        self.rust = np.zeros((W, W), dtype=np.float32)
        self.oil = np.zeros((W, W), dtype=np.float32)
        self.soot = np.zeros((W, W), dtype=np.float32)
        self.rust_tone = self.rng.random((W, W)).astype(np.float32)

    # ── layer builders ───────────────────────────────────────────────────

    def crevice_grime(self, dif_img, strength=0.5):
        """Grime wherever the diffuse is darker than its neighbourhood —
        seams, slots, vents collect dirt automatically."""
        lum = np.asarray(dif_img.convert('L'), dtype=np.float32)
        blur = np.asarray(
            Image.fromarray(lum.astype(np.uint8)).filter(
                ImageFilter.GaussianBlur(4)), dtype=np.float32)
        crevice = np.clip((blur - lum) / 40.0, 0, 1)          # darker than hood
        halo = Image.fromarray((crevice * 255).astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(2.2))
        a = np.asarray(halo, dtype=np.float32) / 255.0 * strength
        self.dirt = np.maximum(self.dirt, a.astype(np.float32))

    def mud_band(self, rect, strength=0.8, fade='down', spatter=True,
                 dust=0.0):
        """Height-graded mud in a rect. fade: 'down' = heaviest at rect
        bottom (zones map v-down to lower world height), 'right'/'left'
        for limb wraps (u runs along the limb), None = uniform."""
        x0, y0, x1, y1 = [int(v) for v in rect]
        h, w = y1 - y0, x1 - x0
        if h <= 2 or w <= 2:
            return
        n = _noise((h, w), self.rng)
        yy, xx = np.mgrid[0:h, 0:w]
        if fade == 'down':
            g = (yy / max(1, h - 1)) ** 1.7
        elif fade == 'right':
            g = (xx / max(1, w - 1)) ** 1.7
        elif fade == 'left':
            g = (1 - xx / max(1, w - 1)) ** 1.7
        else:
            g = np.ones((h, w), dtype=np.float32)
        a = np.clip((n * 0.75 + 0.25) * g * strength, 0, 0.92)
        # break the top edge of the band with noise so it never reads flat
        a *= np.clip(n * 1.6, 0, 1)
        if spatter:
            spots = np.zeros((h, w), dtype=np.float32)
            count = int(w * h / 900 * strength)
            sy = (self.rng.random(count) ** 0.5)      # denser near bottom
            for i in range(count):
                cy = int((1 - sy[i] * (0.55 if fade == 'down' else 1.0)) * (h - 1)) \
                    if fade == 'down' else int(self.rng.random() * (h - 1))
                cx = int(self.rng.random() * (w - 1))
                r = 1 + int(self.rng.random() * 2.4)
                spots[max(0, cy - r):cy + r, max(0, cx - r):cx + r] = \
                    0.55 + 0.4 * self.rng.random()
            a = np.maximum(a, spots * g ** 0.5)
        region = self.dirt[y0:y1, x0:x1]
        self.dirt[y0:y1, x0:x1] = np.maximum(region, a.astype(np.float32))
        if dust > 0:  # thin dry film higher up
            film = np.clip(n * dust * (1 - g), 0, 0.35)
            self.dirt[y0:y1, x0:x1] = np.maximum(
                self.dirt[y0:y1, x0:x1], film.astype(np.float32))

    def rust_blotch(self, cx, cy, r, strength=0.85):
        h = w = int(r * 2 + 4)
        y0, x0 = int(cy - h / 2), int(cx - w / 2)
        if y0 < 0 or x0 < 0 or y0 + h >= W or x0 + w >= W:
            return
        n = _noise((h, w), self.rng, octaves=((8, 0.6), (16, 0.4)))
        yy, xx = np.mgrid[0:h, 0:w]
        d = np.sqrt((yy - h / 2) ** 2 + (xx - w / 2) ** 2) / max(1.0, r)
        a = np.clip((1 - d) * 1.4, 0, 1) * np.clip(n * 1.5 - 0.25, 0, 1) * strength
        self.rust[y0:y0 + h, x0:x0 + w] = np.maximum(
            self.rust[y0:y0 + h, x0:x0 + w], a.astype(np.float32))

    def rust_streak(self, cx, cy, length, width=2.2, strength=0.5):
        """Gravity streak running down from a rust source."""
        steps = int(length)
        x = float(cx)
        for i in range(steps):
            t = i / max(1, steps - 1)
            a = strength * (1 - t) ** 1.5
            x += (self.rng.random() - 0.5) * 0.8
            y = int(cy + i)
            if y >= W:
                break
            half = max(1, int(width * (1 - t * 0.6)))
            x0, x1 = int(x - half), int(x + half)
            if x0 < 0 or x1 >= W:
                continue
            self.rust[y, x0:x1] = np.maximum(self.rust[y, x0:x1], a)

    def bolt_rust(self, bolts, vertical_rects, fraction=0.45, seed_extra=0):
        """Rust rings on a random subset of logged bolts; streaks only in
        zones where image-down == world-down."""
        rng = np.random.default_rng(1234 + seed_extra)
        for (bx, by) in bolts:
            if rng.random() > fraction:
                continue
            self.rust_blotch(bx, by, 4 + rng.random() * 3,
                             strength=0.5 + rng.random() * 0.35)
            if any(r[0] <= bx < r[2] and r[1] <= by < r[3]
                   for r in vertical_rects):
                if rng.random() < 0.7:
                    self.rust_streak(bx, by + 3, 10 + rng.random() * 26,
                                     strength=0.3 + rng.random() * 0.25)

    def plate_bottom_rust(self, rect, n=6, band=10, strength=0.7):
        """Blotch clusters along the bottom edge of a vertical plate."""
        x0, y0, x1, y1 = [int(v) for v in rect]
        for _ in range(n):
            cx = x0 + self.rng.random() * (x1 - x0)
            cy = y1 - self.rng.random() * band
            self.rust_blotch(cx, cy, 3 + self.rng.random() * 6, strength)
            if self.rng.random() < 0.4:
                self.rust_streak(cx, cy, 6 + self.rng.random() * 12,
                                 strength=0.3)

    def oily(self, rect, strength=0.5):
        x0, y0, x1, y1 = [int(v) for v in rect]
        h, w = y1 - y0, x1 - x0
        if h <= 2 or w <= 2:
            return
        n = _noise((h, w), self.rng, octaves=((16, 0.6), (32, 0.4)))
        a = np.clip(n * 1.3 - 0.25, 0, 1) * strength
        self.oil[y0:y1, x0:x1] = np.maximum(self.oil[y0:y1, x0:x1],
                                            a.astype(np.float32))

    def soot_patch(self, rect, strength=0.75, fade=None):
        x0, y0, x1, y1 = [int(v) for v in rect]
        h, w = y1 - y0, x1 - x0
        if h <= 2 or w <= 2:
            return
        n = _noise((h, w), self.rng)
        if fade == 'right':
            yy, xx = np.mgrid[0:h, 0:w]
            g = (xx / max(1, w - 1)) ** 2.0
        else:
            g = 1.0
        a = np.clip((n * 0.7 + 0.3) * g * strength, 0, 0.9)
        self.soot[y0:y1, x0:x1] = np.maximum(self.soot[y0:y1, x0:x1],
                                             a.astype(np.float32))

    # ── composite ────────────────────────────────────────────────────────

    def apply(self, m):
        """Composite layers onto Maps m (diffuse/orm/emissive/team)."""
        dif = np.asarray(m.dif, dtype=np.float32)
        orm = np.asarray(m.orm, dtype=np.float32)
        emi = np.asarray(m.emi, dtype=np.float32)
        tea = np.asarray(m.tea, dtype=np.float32)

        def blend(base, col, a):
            return base * (1 - a[..., None]) + col[None, None, :] * a[..., None]

        # dirt: brown low, dusty high — mix tone by a second noise
        tone = _noise((W, W), self.rng, octaves=((32, 1.0),))[..., None]
        dirt_col = DIRT_COL[None, None, :] * (1 - tone) + DUST_COL[None, None, :] * tone
        a = self.dirt[..., None]
        dif = dif * (1 - a * 0.9) + dirt_col * (a * 0.9)

        rust_col = (RUST_DK[None, None, :] * (1 - self.rust_tone[..., None])
                    + RUST_LT[None, None, :] * self.rust_tone[..., None])
        a = self.rust[..., None]
        dif = dif * (1 - a) + rust_col * a

        dif = blend(dif, OIL_COL, self.oil * 0.8)
        dif = blend(dif, SOOT_COL, self.soot * 0.9)

        # ORM: R=AO, G=rough, B=metal
        ao, rough, metal = orm[..., 0], orm[..., 1], orm[..., 2]
        ao = ao - self.dirt * 26 - self.rust * 38 - self.soot * 30
        rough = (rough + self.dirt * 46 + self.rust * 62 + self.soot * 50
                 - self.oil * 70)
        metal = metal * (1 - self.dirt * 0.75) * (1 - self.rust * 0.85) \
            * (1 - self.soot * 0.6)
        orm = np.stack([ao, rough, metal], axis=-1)

        # team mask: weathering punches through team paint
        punch = np.clip(self.dirt * 0.9 + self.rust + self.soot, 0, 1)
        tea[..., 0] = tea[..., 0] * (1 - punch * 0.85)

        # soot dims emissive beneath it
        emi = emi * (1 - self.soot[..., None] * 0.8)

        m.dif = Image.fromarray(np.clip(dif, 0, 255).astype(np.uint8))
        m.orm = Image.fromarray(np.clip(orm, 0, 255).astype(np.uint8))
        m.emi = Image.fromarray(np.clip(emi, 0, 255).astype(np.uint8))
        m.tea = Image.fromarray(np.clip(tea, 0, 255).astype(np.uint8))
        # redraw handles for any caller that keeps painting
        m.d = ImageDraw.Draw(m.dif)
        m.o = ImageDraw.Draw(m.orm)
        m.e = ImageDraw.Draw(m.emi)
        m.t = ImageDraw.Draw(m.tea)


def vertical_rects_of(module):
    """Rects of every Zone in a layout module whose v-axis maps world
    height (image-down == world-down) — where gravity streaks make sense."""
    from meshlib import Zone
    out = []
    for name in dir(module):
        z = getattr(module, name)
        if isinstance(z, Zone) and z.axes[1] == 'y' and z.win[1][0] > z.win[1][1]:
            out.append(z.rect)
    return out
