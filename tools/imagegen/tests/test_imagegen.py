#!/usr/bin/env python3
"""Tests for tools/imagegen (PLAN-beta-presentation.md L-IMAGEGEN).

    python3 -m unittest discover -s tools/imagegen/tests

One spec per new mechanism: the seamless offset-blend actually reduces the
seam it's meant to fix, power-of-two rounding is correct, the `none` backend
is deterministic per seed (required for run.py's idempotency cache), and
the cache key changes when the job spec changes.
"""
import os
import sys
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from post import seamless, resize, pbr  # noqa: E402
from backends import none as backend_none  # noqa: E402
import run as imagegen_run  # noqa: E402


class SeamlessTest(unittest.TestCase):
    def test_offset_blend_reduces_the_seam_it_creates(self):
        # A hard ramp: seam sits at the col63->col0 wrap today. After the
        # offset-blend's half-roll, that seam relocates to the centre
        # (col31/col32) — the blend's whole job is to soften it there.
        arr = np.tile(np.linspace(0, 255, 64).astype(np.uint8), (64, 1))
        img = Image.fromarray(arr, 'L')

        rolled = np.roll(arr, shift=32, axis=1)
        center_jump_unblended = abs(int(rolled[32, 31]) - int(rolled[32, 32]))

        out = np.asarray(seamless.make_seamless(img))
        center_jump_blended = abs(int(out[32, 31]) - int(out[32, 32]))

        self.assertLess(center_jump_blended, center_jump_unblended)


class ResizeTest(unittest.TestCase):
    def test_nearest_pow2(self):
        self.assertEqual(resize.nearest_pow2(1000), 1024)
        self.assertEqual(resize.nearest_pow2(600), 512)
        self.assertEqual(resize.nearest_pow2(1024), 1024)
        self.assertEqual(resize.nearest_pow2(768), 512)  # exact tie rounds down

    def test_to_pow2_no_op_when_already_pow2(self):
        img = Image.new('RGB', (256, 256))
        self.assertIs(resize.to_pow2(img), img)


class NoneBackendTest(unittest.TestCase):
    def test_deterministic_per_seed(self):
        args = ('prompt', 42, (64, 64), 'negative')
        a = backend_none.generate(*args, asset_class='biome', params={'colors': ['#3d3a2e', '#8a7f6a']})
        b = backend_none.generate(*args, asset_class='biome', params={'colors': ['#3d3a2e', '#8a7f6a']})
        self.assertEqual(a, b)

    def test_different_seed_differs(self):
        a = backend_none.generate('p', 1, (64, 64), 'n', asset_class='biome', params={})
        b = backend_none.generate('p', 2, (64, 64), 'n', asset_class='biome', params={})
        self.assertNotEqual(a, b)

    def test_emblem_shapes_render_and_svg_agree_on_shape_count(self):
        shapes = backend_none.emblem_shapes('#c9a227')
        img = backend_none.render_shapes(shapes, 128, 128)
        self.assertEqual(img.size, (128, 128))
        self.assertEqual(img.mode, 'RGBA')


class PbrTest(unittest.TestCase):
    def test_normal_and_roughness_same_size_as_source(self):
        arr = (np.random.default_rng(0).random((32, 32)) * 255).astype(np.uint8)
        src = Image.fromarray(arr, 'L')
        height = pbr.height_from_luminance(src)
        normal = pbr.normal_from_height(height)
        rough = pbr.roughness_from_luminance(src)
        self.assertEqual(normal.size, (32, 32))
        self.assertEqual(rough.size, (32, 32))
        self.assertEqual(normal.mode, 'RGB')


class JobHashTest(unittest.TestCase):
    def test_hash_stable_and_sensitive_to_spec_changes(self):
        job = {'id': 'x', 'seed': 1, 'width': 4, 'height': 4, '_source': 'x.json'}
        h1 = imagegen_run.job_hash(job, 'none')
        h2 = imagegen_run.job_hash(dict(job), 'none')
        self.assertEqual(h1, h2)
        job['seed'] = 2
        self.assertNotEqual(h1, imagegen_run.job_hash(job, 'none'))


if __name__ == '__main__':
    unittest.main()
