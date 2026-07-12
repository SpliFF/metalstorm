"""normals — height-map authoring + tangent-space normal map baking.

Heights are authored in the same atlas space as everything else (zone
rects from the layout modules), combined with automatic detail derived
from the painted maps (crevices become grooves, bolts become domes, mud
becomes lumps, rust becomes pitting), then Sobel-derived into a
tangent-space normal map (glTF/OpenGL convention; the engine reconstructs
the TBN from screen-space derivatives, entity-renderer.ts perturbNormal).

Height units are abstract; NORMAL_STRENGTH scales the final slope. Keep
maps soft — the engine comment explicitly targets "soft normal maps on
low-poly RTS units".
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W = 1024
G_SIGN = -1.0   # OpenGL-style green (flip to +1.0 if bumps render inverted)


class HeightMap:
    def __init__(self):
        self.h = np.zeros((W, W), dtype=np.float32)
        self._img = Image.new('F', (W, W), 0.0)
        self._d = ImageDraw.Draw(self._img)

    def _sync_from_img(self):
        arr = np.asarray(self._img, dtype=np.float32)
        self.h = np.where(np.abs(arr) > np.abs(self.h), arr, self.h)
        self._img = Image.new('F', (W, W), 0.0)
        self._d = ImageDraw.Draw(self._img)

    # ── authored features (draw-then-sync keeps overlaps sane) ──────────
    def rect(self, box, height):
        self._d.rectangle([box[0], box[1], box[2] - 1, box[3] - 1], fill=height)
        self._sync_from_img()

    def disc(self, cx, cy, r, height):
        self._d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=height)
        self._sync_from_img()

    def line(self, xy0, xy1, height, width=2):
        self._d.line([xy0, xy1], fill=height, width=width)
        self._sync_from_img()

    # ── automatic detail from the painted maps ──────────────────────────
    def crevices_from(self, dif_img, depth=0.55):
        """Painted seams/slots/vents (darker than neighbourhood) → grooves."""
        lum = np.asarray(dif_img.convert('L'), dtype=np.float32)
        blur = np.asarray(Image.fromarray(lum.astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(3)), dtype=np.float32)
        groove = np.clip((blur - lum) / 34.0, 0, 1)
        self.h -= groove.astype(np.float32) * depth

    def bolts_from(self, bolt_log, height=0.5, r=3):
        for (bx, by) in bolt_log:
            self._d.ellipse([bx - r, by - r, bx + r, by + r], fill=height)
        self._sync_from_img()

    def weather_from(self, wx, mud_lump=0.3, rust_pit=0.25):
        rng = np.random.default_rng(5150)
        fine = rng.random((W, W)).astype(np.float32)
        fine = np.asarray(Image.fromarray((fine * 255).astype(np.uint8))
                          .filter(ImageFilter.GaussianBlur(1.0)),
                          dtype=np.float32) / 255.0
        self.h += (fine - 0.5) * wx.dirt * 2 * mud_lump      # lumpy mud
        self.h -= np.clip(fine - 0.45, 0, 1) * wx.rust * rust_pit  # pitting

    # ── bake ─────────────────────────────────────────────────────────────
    def to_normal_image(self, strength=2.2, presmooth=0.8):
        h = self.h
        if presmooth > 0:
            h8 = ((h - h.min()) / max(1e-6, h.max() - h.min()) * 255)
            sm = np.asarray(Image.fromarray(h8.astype(np.uint8)).filter(
                ImageFilter.GaussianBlur(presmooth)), dtype=np.float32)
            h = sm / 255.0 * max(1e-6, h.max() - h.min()) + h.min()
        gx = np.zeros_like(h)
        gy = np.zeros_like(h)
        gx[:, 1:-1] = (h[:, 2:] - h[:, :-2]) * 0.5
        gy[1:-1, :] = (h[2:, :] - h[:-2, :]) * 0.5
        nx = -gx * strength
        ny = G_SIGN * gy * strength
        nz = np.ones_like(h)
        ln = np.sqrt(nx * nx + ny * ny + nz * nz)
        r = (nx / ln * 0.5 + 0.5) * 255
        g = (ny / ln * 0.5 + 0.5) * 255
        b = (nz / ln * 0.5 + 0.5) * 255
        return Image.fromarray(
            np.stack([r, g, b], axis=-1).astype(np.uint8))
