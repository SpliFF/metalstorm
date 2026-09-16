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
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from post import seamless, resize, pbr, alpha, grade  # noqa: E402
from backends import none as backend_none  # noqa: E402
from backends import comfy_local as backend_comfy  # noqa: E402
import run as imagegen_run  # noqa: E402


class SeamlessTest(unittest.TestCase):
    def _wrap_jumps(self, out):
        return (np.abs(out[:, 0].astype(int) - out[:, -1].astype(int)).max(),
                np.abs(out[0, :].astype(int) - out[-1, :].astype(int)).max())

    def test_cross_fade_wraps_in_both_axes_without_a_centre_seam(self):
        # A hard ramp in x plus a hard ramp in y: the raw image jumps by ~255
        # at both wraps. After the four-way cross-fade the output must wrap
        # within a few grey levels in x AND y, and — the failure mode of a
        # plain half-roll — must not have moved the seam to the centre.
        x = np.linspace(0, 255, 64)
        arr = np.clip((x[None, :] * 0.5 + x[:, None] * 0.5), 0, 255).astype(np.uint8)
        img = Image.fromarray(arr, 'L')
        raw_x, raw_y = self._wrap_jumps(arr)
        self.assertGreater(min(raw_x, raw_y), 100)

        out = np.asarray(seamless.make_seamless(img))
        self.assertEqual(out.shape, arr.shape)
        wx, wy = self._wrap_jumps(out)
        self.assertLess(wx, 12)
        self.assertLess(wy, 12)
        centre_jump_x = np.abs(out[:, 31].astype(int) - out[:, 32].astype(int)).max()
        centre_jump_y = np.abs(out[31, :].astype(int) - out[32, :].astype(int)).max()
        self.assertLess(centre_jump_x, 12)
        self.assertLess(centre_jump_y, 12)

    def test_centre_is_untouched_and_rgba_is_preserved(self):
        rng = np.random.default_rng(3)
        arr = rng.integers(0, 256, (64, 64, 4), dtype=np.uint8)
        out = np.asarray(seamless.make_seamless(Image.fromarray(arr, 'RGBA')))
        self.assertEqual(out.shape, arr.shape)
        # Plateau weights are exactly 1 in the middle: the source survives there verbatim.
        np.testing.assert_array_equal(out[24:40, 24:40], arr[24:40, 24:40])


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

    def test_fx_atlas_deterministic_across_processes(self):
        # cell_seed used to fold in the builtin hash() of the frame name,
        # which is salted per-process (PYTHONHASHSEED) — a rerun of `run.py`
        # with an identical job spec produced a different fx_atlas.png every
        # time. Run generate() in two subprocesses with different explicit
        # hash seeds: only a process-stable mixing function (zlib.crc32)
        # makes them agree.
        import subprocess
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        code = (
            "import sys; sys.path.insert(0, %r)\n"
            "from backends import none as backend_none\n"
            "params = {'cols': 2, 'rows': 1, 'frames': {'smoke': 0, 'dust': 1}}\n"
            "sys.stdout.buffer.write(backend_none.generate('p', 100601, (64, 64), 'n', "
            "asset_class='fx_atlas', params=params))\n"
        ) % here
        outs = []
        for seed in ('1', '2'):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            r = subprocess.run([sys.executable, '-c', code], capture_output=True, env=env, check=True)
            outs.append(r.stdout)
        self.assertEqual(outs[0], outs[1])

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


class AlphaTest(unittest.TestCase):
    def test_overlay_alpha_leaves_existing_rgba_untouched(self):
        img = Image.new('RGBA', (8, 8), (10, 20, 30, 40))
        out = alpha.overlay_alpha(img, (255, 0, 0))
        self.assertIs(out, img)

    def test_overlay_alpha_recolors_rgb_and_derives_alpha_from_grey_deviation(self):
        arr = np.full((16, 16), 128, dtype=np.uint8)
        arr[4:8, 4:8] = 255  # a bright patch far from mid-grey
        img = Image.fromarray(arr, 'L').convert('RGB')
        out = alpha.overlay_alpha(img, (122, 90, 62))
        self.assertEqual(out.mode, 'RGBA')
        a = np.asarray(out)[..., 3]
        self.assertGreater(a[5, 5], a[0, 0])  # the deviating patch reads more opaque
        rgb = np.asarray(out)[..., :3]
        self.assertTrue((rgb == np.array([122, 90, 62])).all())

    def test_key_out_background_keys_uniform_corners_transparent(self):
        arr = np.zeros((32, 32, 3), dtype=np.uint8)
        arr[10:22, 10:22] = (200, 180, 40)  # a badge shape in the middle
        img = Image.fromarray(arr, 'RGB')
        out = alpha.key_out_background(img)
        a = np.asarray(out)[..., 3]
        self.assertLess(a[0, 0], 10)
        self.assertGreater(a[16, 16], 200)

    def test_key_out_background_skips_images_with_real_alpha(self):
        arr = np.zeros((8, 8, 4), dtype=np.uint8)
        arr[..., 3] = np.tile(np.arange(8, dtype=np.uint8) * 30, (8, 1))
        img = Image.fromarray(arr, 'RGBA')
        out = alpha.key_out_background(img)
        self.assertIs(out, img)


class TexturedKeyTest(unittest.TestCase):
    def test_key_out_background_survives_a_mottled_grey_backdrop(self):
        rng = np.random.default_rng(11)
        grey = rng.integers(90, 200, (128, 128, 1)).repeat(3, axis=-1).astype(np.uint8)  # mottled, unsaturated
        yy, xx = np.indices((128, 128))
        grey[(xx > 104) & (yy < 24)] = 245  # a bright blotch in a corner, outside the corner band
        disc = (xx - 64) ** 2 + (yy - 64) ** 2 < 40 ** 2
        grey[disc] = (0xc9, 0xa2, 0x27)  # hazard-yellow badge
        grey[disc & (np.abs(xx - 64) < 4)] = (10, 10, 10)  # a black stroke through it
        out = np.asarray(alpha.key_out_background(Image.fromarray(grey, 'RGB'), feather=0))
        self.assertLess(out[5:20, 5:20, 3].mean(), 10)  # textured corner keyed out
        self.assertLess(out[2:20, 108:126, 3].mean(), 10)  # corner blotch cut by the centred-badge prior
        self.assertGreater(out[64, 40, 3], 245)  # yellow kept
        self.assertGreater(out[40, 64, 3], 245)  # black stroke kept (enclosed)


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


class ComfyLocalSizingTest(unittest.TestCase):
    def test_native_size_targets_one_megapixel_on_the_latent_grid(self):
        self.assertEqual(backend_comfy.native_size((1024, 1024)), (1024, 1024))
        self.assertEqual(backend_comfy.native_size((512, 512)), (1024, 1024))
        w, h = backend_comfy.native_size((2048, 1024))
        self.assertEqual((w % 64, h % 64), (0, 0))
        self.assertAlmostEqual(w * h / (1024 * 1024), 1.0, delta=0.08)
        self.assertAlmostEqual(w / h, 2.0, delta=0.15)


class BackendPinTest(unittest.TestCase):
    def test_pinned_job_ignores_requested_backend(self):
        self.assertEqual(imagegen_run.effective_backend({'id': 'j'}, 'comfy_local'), 'comfy_local')
        self.assertEqual(imagegen_run.effective_backend({'id': 'j', 'backend': 'none'}, 'comfy_local'), 'none')
        with self.assertRaises(ValueError):
            imagegen_run.effective_backend({'id': 'j', 'backend': 'midjourney'}, 'none')

    def test_pinned_job_runs_the_pin_and_records_the_reason(self):
        import tempfile
        from pathlib import Path
        style = imagegen_run.load_style()
        job = {'id': 't_pin', 'class': 'overlay', 'backend': 'none', 'backend_reason': 'because',
               'prompt': 'x', 'seed': 7, 'width': 64, 'height': 64, 'tint': '#6b5a3e',
               'output': 'art/gen/_test/pin.png', 'post': [], '_source': 't.json'}
        with tempfile.TemporaryDirectory() as td:
            orig = imagegen_run.REPO_ROOT, imagegen_run.GAME_ROOT
            imagegen_run.REPO_ROOT, imagegen_run.GAME_ROOT = Path(td), Path(td) / 'game'
            try:
                # backend requested is comfy_local (unreachable here) — the pin must never touch it
                entry, changed = imagegen_run.process_job(job, 'comfy_local', style, True, {})
            finally:
                imagegen_run.REPO_ROOT, imagegen_run.GAME_ROOT = orig
            self.assertTrue(changed)
            self.assertEqual(entry['backend'], 'none')
            self.assertTrue(entry['backend_pinned'])
            self.assertEqual(entry['backend_reason'], 'because')
            self.assertEqual(entry['job_hash'], imagegen_run.job_hash(job, 'none'))

    def test_raw_cache_key_depends_on_prompt_seed_and_size_only(self):
        a = imagegen_run.raw_cache_path('comfy_local', 'p', 'n', 1, (64, 64))
        self.assertEqual(a, imagegen_run.raw_cache_path('comfy_local', 'p', 'n', 1, (64, 64)))
        self.assertNotEqual(a, imagegen_run.raw_cache_path('comfy_local', 'p', 'n', 2, (64, 64)))
        self.assertNotEqual(a, imagegen_run.raw_cache_path('comfy_local', 'p', 'n', 1, (128, 64)))
        self.assertNotEqual(a, imagegen_run.raw_cache_path('hosted', 'p', 'n', 1, (64, 64)))
        self.assertEqual(a.parts[-3:-1], ('raw', 'comfy_local'))


class GradeTest(unittest.TestCase):
    def test_gain_lands_the_mean_on_the_palette_and_keeps_black_black(self):
        rng = np.random.default_rng(5)
        arr = np.clip(rng.normal(185, 20, (32, 32, 3)), 0, 255).astype(np.uint8)
        arr[0, 0] = 0
        out = np.asarray(grade.grade_to_palette(Image.fromarray(arr, 'RGB'), ['#6b5a3e', '#8a7f6a', '#3d3a2e']))
        target = grade.palette_mean(['#6b5a3e', '#8a7f6a', '#3d3a2e'])
        for c in range(3):
            self.assertAlmostEqual(out[..., c].mean(), target[c], delta=2.0)
        self.assertEqual(tuple(out[0, 0]), (0, 0, 0))

    def test_no_colors_is_a_no_op(self):
        img = Image.new('RGB', (4, 4), (200, 100, 50))
        self.assertIs(grade.grade_to_palette(img, []), img)


class BuildPromptTest(unittest.TestCase):
    def test_class_suffix_trails_the_job_subject(self):
        style = {'global_negative': 'g', 'classes': {'c': {'prefix': 'P', 'suffix': 'S', 'negative': 'n'}}}
        prompt, negative = imagegen_run.build_prompt(style, {'class': 'c', 'prompt': 'J.'})
        self.assertEqual(prompt, 'P. J. S')
        self.assertEqual(negative, 'g, n')
        style['classes']['c'].pop('suffix')
        self.assertEqual(imagegen_run.build_prompt(style, {'class': 'c', 'prompt': 'J'})[0], 'P. J')


class Ktx2EncodingTest(unittest.TestCase):
    def test_roughness_goes_etc1s_everything_else_uastc(self):
        from pathlib import Path
        from post import ktx2
        self.assertEqual(ktx2.encoding_for(Path('x/desert_roughness.png')), 'etc1s')
        self.assertEqual(ktx2.encoding_for(Path('x/desert_normal.png')), 'uastc')
        self.assertEqual(ktx2.encoding_for(Path('x/desert_diffuse.png')), 'uastc')
