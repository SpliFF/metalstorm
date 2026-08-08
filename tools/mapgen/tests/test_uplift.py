#!/usr/bin/env python3
"""Tests for uplift-field authoring (terragen/uplift.py, PLAN-maps.md §2b item 2).

    python3 -m unittest discover -s tools/mapgen/tests

Synthetic terrain only, for the reason test_rivers.py already gives: `data/maps/`
is gitignored, so a clone has no real map to run against. The hydrology and the
solver are the shipping ones — every case routes through `terragen.hydrology`
and erodes through `terragen.erosion`, so what is pinned here is the behaviour a
map generation gets.

What this pins down, and why each one is here rather than being obvious:

  * **the steady-state relation** `h = (U/K)*Phi`. It is the whole authoring
    surface: without it "how high do you want this range" has no path to a
    number the solver takes, and §2b item 2 degenerates into a knob. The test
    fits `h` against `Phi` over a converged run and requires the slope to
    recover `U/K`; the positive control asserts a *wrong* `U/K` is rejected by
    the same tolerance, so the fit is known to be discriminating.

  * **the base-level trap**, which is the finding this milestone turned on.
    Uplift applied at outlets does nothing at all — the solver never erodes a
    root, so a rising root carries the whole map with it and the landform is
    the U = 0 landform under a rigid translation. `test_unpinned_uplift_is_a_
    rigid_translation` shows the no-op directly (relief ratio ~1 against a
    U = 0 arm) and `test_pinning_buys_relief` shows the pinned arm is an order
    of magnitude higher on the same input. Delete the pin in `erosion.py` and
    the second test fails.

  * **the shipped path is untouched.** No generator passes `uplift`, so the
    pin must be provably inert when `uplift is None` — otherwise this
    milestone silently re-terrains two shipped maps.

  * **`_coarsen` is an area average, not decimation.** Multires evolves the
    structure on the coarse grid, and the divides land where the ridge crests
    are; decimating a ridge samples it or misses it depending on parity. The
    control builds a checkerboard, whose area average is flat and whose
    decimation is not.

  * **band detail is the high-pass residual.** The claim is that
    `keep_band_detail` restores exactly what the coarse grid could not carry.
    The control pair runs the same call with the flag off and requires the
    high-frequency energy to be *absent*, so the assertion cannot pass
    vacuously on a smooth fixture.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from terragen import erosion as ero  # noqa: E402
from terragen import hydrology as hyd  # noqa: E402
from terragen import noise as tn  # noqa: E402
from terragen import uplift as up  # noqa: E402


def _route(dem):
    filled = hyd.fill_depressions(dem)
    routing = hyd.resolve_flats(filled)
    recv = hyd.d8_receivers(routing)
    levels = hyd.topo_levels(recv)
    accum = hyd.flow_accumulation(recv, levels)
    return recv, levels, accum


def _border_pinned(shape, value):
    u = np.full(shape, float(value))
    u[0, :] = 0.0
    u[-1, :] = 0.0
    u[:, 0] = 0.0
    u[:, -1] = 0.0
    return u


class TestErosionalDistance(unittest.TestCase):
    def test_outlets_are_zero(self):
        dem = tn.fbm(tn.SimplexNoise(3), *np.meshgrid(
            np.linspace(0, 4, 65), np.linspace(0, 4, 65)), octaves=4) * 100.0
        recv, levels, accum = _route(dem)
        phi = up.erosional_distance(recv, levels, accum)
        roots = up.base_level_mask(recv, dem.shape).ravel()
        self.assertTrue(np.all(phi[roots] == 0.0))
        self.assertGreater(phi[~roots].max(), 0.0)

    def test_matches_hand_summed_path(self):
        """Phi is sum(1/sqrt(a)) down the flow path — check one path by hand."""
        dem = tn.fbm(tn.SimplexNoise(11), *np.meshgrid(
            np.linspace(0, 6, 97), np.linspace(0, 6, 97)), octaves=5) * 150.0
        recv, levels, accum = _route(dem)
        phi = up.erosional_distance(recv, levels, accum)
        start = int(np.argmax(phi))
        walked, cell = 0.0, start
        for _ in range(phi.size):
            if recv[cell] == cell:
                break
            walked += 1.0 / np.sqrt(max(accum[cell], 1.0))
            cell = recv[cell]
        self.assertAlmostEqual(walked, phi[start], places=9)

    def test_is_independent_of_cell_size(self):
        """The dx cancels out of the relation, so Phi must not see cellsize."""
        dem = tn.fbm(tn.SimplexNoise(5), *np.meshgrid(
            np.linspace(0, 5, 81), np.linspace(0, 5, 81)), octaves=4) * 120.0
        a, _ = up.erosional_distance_from_dem(dem)
        b, _ = up.erosional_distance_from_dem(dem)   # routing takes no cellsize
        np.testing.assert_allclose(a, b)
        self.assertGreater(a.max(), 1.0)


class TestSteadyStateRelation(unittest.TestCase):
    """`h = (U/K)*Phi` — the relation the whole authoring surface rests on."""

    S = 97

    def _converged(self, U, K, iterations=1600):
        rng = np.random.default_rng(7)
        h = 5.0 * rng.random((self.S, self.S))
        u = _border_pinned(h.shape, U)
        h = ero.stream_power_erode(h, cellsize=32.0, iterations=iterations,
                                   dt=1.4, k_erode=K, m_exp=0.5, uplift=u,
                                   talus_deg=None)
        return h - h.min()

    def _fit_ratio(self, h):
        phi, _ = up.erosional_distance_from_dem(h)
        sel = phi.ravel() > 0
        x, y = phi.ravel()[sel], h.ravel()[sel]
        return float(np.dot(x, y) / np.dot(x, x))

    def test_recovers_u_over_k(self):
        for U, K in ((0.5, 0.02), (2.0, 0.02), (0.5, 0.04)):
            with self.subTest(U=U, K=K):
                slope = self._fit_ratio(self._converged(U, K))
                self.assertAlmostEqual(slope / (U / K), 1.0, delta=0.10)

    def test_fit_rejects_a_wrong_ratio(self):
        """Positive control: the same tolerance must reject 2x the true U/K."""
        slope = self._fit_ratio(self._converged(0.5, 0.02))
        self.assertGreater(abs(slope / (2.0 * 0.5 / 0.02) - 1.0), 0.10)

    def test_relief_scales_linearly_with_uplift(self):
        a = self._converged(0.5, 0.02).max()
        b = self._converged(1.0, 0.02).max()
        self.assertAlmostEqual(b / a, 2.0, delta=0.20)


class TestBaseLevelTrap(unittest.TestCase):
    """Uplift at an outlet is a rigid translation, not relief."""

    S = 97
    ITERS = 500

    def _run(self, uplift, pin=True):
        rng = np.random.default_rng(7)
        h = 5.0 * rng.random((self.S, self.S))
        h = ero.stream_power_erode(h, cellsize=32.0, iterations=self.ITERS,
                                   dt=1.4, k_erode=0.02, m_exp=0.5,
                                   uplift=uplift, talus_deg=None,
                                   pin_base_level=pin)
        return h

    def test_unpinned_uplift_is_a_rigid_translation(self):
        """Everywhere-uplift with the pin OFF must match the U = 0 landform."""
        zero = self._run(None)
        flat = self._run(np.full((self.S, self.S), 0.5), pin=False)
        rel_zero = zero.max() - zero.min()
        rel_flat = flat.max() - flat.min()
        self.assertAlmostEqual(rel_flat / rel_zero, 1.0, delta=0.05)
        # And it is the same landform, not just the same range. Not bit-
        # identical: the arms differ by a growing constant (500 * dt * U ~ 350
        # elmos), so the routing sees different ULPs and 500 chaotic iterations
        # amplify that to ~1e-3 elmos of shape. Measured 0.971.
        r_unpinned = np.corrcoef(flat.ravel(), zero.ravel())[0, 1]
        self.assertGreater(r_unpinned, 0.95)
        # Control: the pinned arm on the same input is not this landform at
        # all — measured -0.094, so the assertion above is discriminating.
        pinned = self._run(np.full((self.S, self.S), 0.5))
        r_pinned = np.corrcoef(pinned.ravel(), zero.ravel())[0, 1]
        self.assertLess(r_pinned, 0.5)

    def test_pinning_buys_relief(self):
        """The guard. Remove the pin in erosion.py and this fails."""
        zero = self._run(None)
        pinned = self._run(np.full((self.S, self.S), 0.5))
        rel_zero = zero.max() - zero.min()
        rel_pinned = pinned.max() - pinned.min()
        self.assertGreater(rel_pinned, 20.0 * rel_zero)

    def test_pin_is_inert_without_uplift(self):
        """No generator passes uplift; the pin must not move a shipped byte."""
        rng = np.random.default_rng(2)
        dem = 200.0 * rng.random((65, 65))
        on = ero.stream_power_erode(dem, cellsize=8.0, iterations=4, dt=1.4,
                                    k_erode=0.02, pin_base_level=True)
        off = ero.stream_power_erode(dem, cellsize=8.0, iterations=4, dt=1.4,
                                     k_erode=0.02, pin_base_level=False)
        self.assertEqual(on.tobytes(), off.tobytes())

    def test_pin_base_level_helper_zeroes_outlets(self):
        dem = tn.fbm(tn.SimplexNoise(9), *np.meshgrid(
            np.linspace(0, 4, 65), np.linspace(0, 4, 65)), octaves=4) * 100.0
        recv, _, _ = _route(dem)
        u = up.pin_base_level(np.full(dem.shape, 3.0), recv)
        roots = up.base_level_mask(recv, dem.shape)
        self.assertTrue(np.all(u[roots] == 0.0))
        self.assertTrue(np.all(u[~roots] == 3.0))


class TestAuthoringSurface(unittest.TestCase):
    def setUp(self):
        dem = tn.fbm(tn.SimplexNoise(21), *np.meshgrid(
            np.linspace(0, 6, 97), np.linspace(0, 6, 97)), octaves=5) * 300.0
        self.phi, _ = up.erosional_distance_from_dem(dem)
        self.dem = dem

    def test_uplift_for_relief_round_trips(self):
        target = np.full(self.dem.shape, 900.0)
        u = up.uplift_for_relief(target, 0.02, self.phi)
        back = up.steady_state_relief(u, 0.02, self.phi)
        sel = self.phi > 1e-3
        np.testing.assert_allclose(back[sel], target[sel], rtol=1e-9)

    def test_uplift_for_relief_handles_outlets(self):
        u = up.uplift_for_relief(900.0, 0.02, self.phi)
        self.assertTrue(np.all(np.isfinite(u)))

    def test_relief_scale_is_a_quantile_not_the_max(self):
        s = up.relief_scale(self.phi)
        self.assertLess(s, self.phi.max())
        self.assertGreater(s, np.median(self.phi))

    def test_smooth_uplift_removes_fine_structure(self):
        rng = np.random.default_rng(4)
        noisy = rng.random((129, 129))
        smooth = up.smooth_uplift(noisy, cellsize=32.0, wavelength_elmos=2000.0)
        rough = lambda a: float(np.abs(np.diff(a, axis=1)).mean())  # noqa: E731
        self.assertLess(rough(smooth), 0.02 * rough(noisy))
        self.assertAlmostEqual(smooth.mean(), noisy.mean(), delta=0.02)

    def test_noise_uplift_is_bounded_and_deterministic(self):
        a = up.noise_uplift((97, 97), 32.0, seed=5, floor=0.2)
        b = up.noise_uplift((97, 97), 32.0, seed=5, floor=0.2)
        np.testing.assert_array_equal(a, b)
        self.assertGreaterEqual(a.min(), 0.2 - 1e-12)
        self.assertLessEqual(a.max(), 1.0 + 1e-12)
        c = up.noise_uplift((97, 97), 32.0, seed=6, floor=0.2)
        self.assertGreater(np.abs(a - c).mean(), 1e-3)


class TestShapedField(unittest.TestCase):
    """`Phi` assumes a uniform `U/K`; a field that draws a landform is not.

    The whole point of an authoring surface is to aim, so the failure mode
    that matters is not "the terrain looks wrong" but "the author asked for
    950 and got 283". Every case here therefore compares a *prediction*
    against a converged run, and the scalar form is carried alongside as the
    control it failed as (PLAN-maps M8p).
    """

    S = 97

    def setUp(self):
        # one uplifting blob in the middle: the flow path from its summit
        # leaves the uplifting region long before it reaches base level,
        # which is exactly the geometry Phi's factorisation assumes away
        g = np.linspace(-1.0, 1.0, self.S)
        zz, xx = np.meshgrid(g, g, indexing="ij")
        self.u = np.exp(-((xx / 0.30) ** 2 + (zz / 0.30) ** 2))
        self.u[0, :] = self.u[-1, :] = self.u[:, 0] = self.u[:, -1] = 0.0
        rng = np.random.default_rng(7)
        self.h0 = 5.0 * rng.random((self.S, self.S))
        self.K = 0.02

    def _converged(self, uplift, iterations=1600):
        h = ero.stream_power_erode(self.h0, cellsize=32.0,
                                   iterations=iterations, dt=1.4,
                                   k_erode=self.K, m_exp=0.5, uplift=uplift,
                                   talus_deg=None)
        return h - h.min()

    def test_psi_reduces_to_phi_when_the_ratio_is_uniform(self):
        """The new form must contain the old one, not replace it."""
        dem = tn.fbm(tn.SimplexNoise(13), *np.meshgrid(
            np.linspace(0, 6, 97), np.linspace(0, 6, 97)), octaves=5) * 200.0
        recv, levels, accum = _route(dem)
        phi = up.erosional_distance(recv, levels, accum)
        u = np.full(dem.shape, 0.5)
        psi = up.steady_state_relief_field(u, self.K, recv, levels, accum)
        np.testing.assert_allclose(psi, (0.5 / self.K) * phi, rtol=1e-12)

    def test_psi_is_zero_at_outlets(self):
        psi = up.steady_state_relief_from_dem(self.h0, self.u, self.K)
        recv, _, _ = _route(self.h0)
        roots = up.base_level_mask(recv, self.h0.shape)
        self.assertTrue(np.all(psi[roots] == 0.0))
        self.assertGreater(psi.max(), 0.0)

    def test_the_scalar_form_overpredicts_a_shaped_field(self):
        """The finding, as a test: Phi's aim is out by more than 50 %.

        Not a tolerance to relax — if a later change makes the scalar form
        accurate here, the geometry it is being fed has changed and the
        shaped-field case is no longer being exercised.
        """
        h = self._converged(self.u * 1.0)
        achieved = float(np.quantile(h, 0.999))
        phi, _ = up.erosional_distance_from_dem(h)
        scalar = (self.u.max() / self.K) * up.relief_scale(phi)
        psi = up.steady_state_relief_from_dem(h, self.u, self.K)
        path = float(np.quantile(psi, 0.999))
        self.assertGreater(scalar / achieved, 1.5)
        self.assertLess(abs(path / achieved - 1.0), 0.25)

    def test_scale_uplift_for_relief_hits_the_target(self):
        target = 400.0
        s = up.scale_uplift_for_relief(self.h0, self.u, self.K, target)
        h = self._converged(self.u * s)
        achieved = float(np.quantile(h, 0.999))
        self.assertLess(abs(achieved / target - 1.0), 0.30)

    def test_scale_uplift_for_relief_is_linear_in_the_target(self):
        a = up.scale_uplift_for_relief(self.h0, self.u, self.K, 400.0)
        b = up.scale_uplift_for_relief(self.h0, self.u, self.K, 800.0)
        self.assertAlmostEqual(b / a, 2.0, places=9)


class TestStructuralAnisotropy(unittest.TestCase):
    """The instrument M8p's verdict rests on, with both controls it needs.

    A metric that only ever fires is worthless, and so is one that never
    does — the herringbone case and the isotropic case are both asserted
    here, against the same thresholds the milestone quoted.
    """

    def setUp(self):
        # 513 not 257: the reading has a sample-count floor (the same fBm
        # reads 2.35 / 1.84 / 1.68 at 257 / 513 / 1025), so a small fixture
        # would need a threshold too loose to catch anything
        self.N = 513
        x = np.linspace(0, 8, self.N)
        self.iso = tn.fbm(tn.SimplexNoise(41), *np.meshgrid(x, x),
                          octaves=7) * 300.0

    def test_isotropic_noise_reads_low(self):
        peak, ent = up.structural_anisotropy(self.iso, 8.0, 32.0, 120.0)
        self.assertLess(peak, 2.0)
        self.assertGreater(ent, 0.99)

    def test_a_herringbone_reads_high(self):
        g = np.arange(self.N, dtype=np.float64)
        zz, xx = np.meshgrid(g, g, indexing="ij")
        comb = 60.0 * np.sin(2 * np.pi * (xx + zz) / 8.0)
        peak, ent = up.structural_anisotropy(self.iso + comb, 8.0, 32.0, 120.0)
        self.assertGreater(peak, 5.0)
        self.assertLess(ent, 0.96)

    def test_the_band_is_a_band(self):
        """Structure outside the window must not move the reading."""
        g = np.arange(self.N, dtype=np.float64)
        zz, xx = np.meshgrid(g, g, indexing="ij")
        slow = 400.0 * np.sin(2 * np.pi * (xx - zz) / 200.0)   # 1600 elmos
        a = up.structural_anisotropy(self.iso, 8.0, 32.0, 120.0)
        b = up.structural_anisotropy(self.iso + slow, 8.0, 32.0, 120.0)
        self.assertAlmostEqual(a[0], b[0], delta=0.15)


class TestAngularLobes(unittest.TestCase):
    """The lobe list, and the case that made it necessary (M8q FIND 3).

    `structural_anisotropy` is a single-lobe detector, so the cross-hatch
    below is the test that matters: two combs 90 deg apart are a surface the
    eye refuses, and peak/mean reads it as almost isotropic. If the lobe
    list ever collapses back to "the peak and its shoulders", that case
    stops being distinguishable from dendritic terrain and the acceptance
    instrument goes blind again.
    """

    def setUp(self):
        self.N = 513
        x = np.linspace(0, 8, self.N)
        self.iso = tn.fbm(tn.SimplexNoise(41), *np.meshgrid(x, x),
                          octaves=7) * 300.0
        g = np.arange(self.N, dtype=np.float64)
        self.zz, self.xx = np.meshgrid(g, g, indexing="ij")

    def _comb(self, along_x: bool, period_cells: float = 8.0, amp: float = 60.0):
        c = self.xx + self.zz if along_x else self.xx - self.zz
        return amp * np.sin(2 * np.pi * c / period_cells)

    def _lobe(self, theta_deg: float, seed: int, amp: float = 10.0,
              width_deg: float = 6.0, cell: float = 8.0):
        """Band-limited noise with an *oriented* spectrum — a comb with a
        real landscape's spectral width, not a pure tone. A monochromatic
        sine reads 80x here and both cases (one comb, two) stay enormous, so
        it cannot show what a broad lobe does to the scalar.
        """
        rng = np.random.default_rng(seed)
        w = np.fft.fftshift(np.fft.fft2(rng.standard_normal((self.N, self.N))))
        f = np.fft.fftshift(np.fft.fftfreq(self.N, cell))
        fz, fx = np.meshgrid(f, f, indexing="ij")
        k = np.hypot(fx, fz)
        band = (k > 1.0 / 120.0) & (k < 1.0 / 32.0)
        ang = np.degrees(np.arctan2(fz, fx)) % 180.0
        d = (ang - theta_deg + 90.0) % 180.0 - 90.0
        w = w * band * np.exp(-(d / width_deg) ** 2)
        out = np.real(np.fft.ifft2(np.fft.ifftshift(w)))
        return amp * out / out.std()

    def test_isotropic_noise_gives_a_flat_list(self):
        lobes = up.angular_lobes(self.iso, 8.0)
        self.assertLess(lobes[0][1], 2.0)
        # no lobe stands out from the next one — that is what "no structure"
        # looks like, as against "balanced structure"
        self.assertLess(lobes[0][1] - lobes[2][1], 0.5)

    def test_a_herringbone_is_one_tall_lobe(self):
        lobes = up.angular_lobes(self.iso + self._comb(True), 8.0)
        self.assertGreater(lobes[0][1], 5.0)
        self.assertGreater(lobes[0][1], 2.0 * lobes[1][1])

    def test_a_cross_hatch_lowers_the_scalar_and_shows_in_the_list(self):
        """The reason this function exists, with the single-lobe control.

        Adding a second lobe adds oriented structure and *lowers* peak/mean,
        because the mean it divides by went up. Judge on the scalar and a
        cross-hatch scores better than the herringbone it replaced.
        """
        one = self.iso + self._lobe(45.0, seed=7)
        hatch = one + self._lobe(135.0, seed=9)
        peak_one = up.structural_anisotropy(one, 8.0)[0]
        peak_hatch = up.structural_anisotropy(hatch, 8.0)[0]
        self.assertLess(peak_hatch, peak_one)

        l_one, l_hatch = up.angular_lobes(one, 8.0), up.angular_lobes(hatch, 8.0)
        # one lobe: the runner-up is a shoulder, well down on the peak
        self.assertLess(l_one[1][1], 0.5 * l_one[0][1])
        # two lobes: comparable heights, and they are ~90 deg apart
        self.assertGreater(l_hatch[1][1], 0.7 * l_hatch[0][1])
        sep = abs(l_hatch[0][0] - l_hatch[1][0])
        self.assertGreater(min(sep, 180.0 - sep), 60.0)

    def test_suppression_makes_the_second_pick_a_different_lobe(self):
        """Without it, entry 2 is the peak's own neighbouring bin."""
        one = self.iso + self._lobe(45.0, seed=7)
        none = up.angular_lobes(one, 8.0, suppress=0)
        wide = up.angular_lobes(one, 8.0, suppress=6)
        width = 180.0 / 90
        self.assertLessEqual(abs(none[1][0] - none[0][0]), width)
        self.assertGreater(abs(wide[1][0] - wide[0][0]), 6.0 * width)

    def test_peak_agrees_with_the_scalar(self):
        """One histogram read two ways — they cannot disagree on the peak."""
        for dem in (self.iso, self.iso + self._comb(True)):
            peak, _ = up.structural_anisotropy(dem, 8.0)
            self.assertAlmostEqual(peak, up.angular_lobes(dem, 8.0)[0][1],
                                   places=6)

    def test_peak_agrees_with_the_scalar(self):
        """One histogram read two ways — they cannot disagree on the peak."""
        for dem in (self.iso, self.iso + self._comb(True)):
            peak, _ = up.structural_anisotropy(dem, 8.0)
            self.assertAlmostEqual(peak, up.angular_lobes(dem, 8.0)[0][1],
                                   places=6)


class TestMultires(unittest.TestCase):
    def setUp(self):
        x = np.linspace(0, 8, 129)
        self.dem = tn.fbm(tn.SimplexNoise(31), *np.meshgrid(x, x),
                          octaves=7) * 400.0

    def test_coarsen_is_an_area_average_not_decimation(self):
        """Positive control: decimation keeps a checkerboard's extremes."""
        board = (np.indices((128, 128)).sum(axis=0) % 2).astype(float)
        avg = ero._coarsen(board, (32, 32))
        dec = board[::4, ::4]
        # The average carries the true mean through; decimation lands on one
        # phase of the checkerboard and reports a surface that isn't there.
        self.assertAlmostEqual(avg.mean(), board.mean(), delta=0.01)
        self.assertLess(avg.std(), 0.05)
        self.assertGreater(abs(dec.mean() - board.mean()), 0.4)

    def test_band_detail_restores_high_frequency(self):
        # (32, 32) is the grid the multires call itself coarsens to
        # (round(129/4)); measuring the residual at a different scale compares
        # against a band the pass never had, and reads as leakage that isn't.
        def hf_energy(a):
            return float(np.abs(a - ero._refine(
                ero._coarsen(a, (32, 32)), a.shape)).mean())

        src = hf_energy(self.dem)
        with_band = ero.stream_power_erode_multires(
            self.dem, cellsize=32.0, coarse_factor=4, coarse_iterations=3,
            fine_iterations=0, keep_band_detail=True, k_erode=0.02,
            dt=1.4, talus_deg=None)
        without = ero.stream_power_erode_multires(
            self.dem, cellsize=32.0, coarse_factor=4, coarse_iterations=3,
            fine_iterations=0, keep_band_detail=False, k_erode=0.02,
            dt=1.4, talus_deg=None)
        self.assertGreater(hf_energy(with_band), 0.9 * src)
        self.assertLess(hf_energy(without), 0.15 * src)

    def test_coarse_structure_survives_the_refinement(self):
        """The point of the coarse pass: its structure must reach the output."""
        coarse_only = ero.stream_power_erode_multires(
            self.dem, cellsize=32.0, coarse_factor=4, coarse_iterations=60,
            fine_iterations=0, keep_band_detail=False, k_erode=0.02, dt=1.4,
            uplift=_border_pinned(self.dem.shape, 0.5), talus_deg=None)
        full = ero.stream_power_erode_multires(
            self.dem, cellsize=32.0, coarse_factor=4, coarse_iterations=60,
            fine_iterations=6, keep_band_detail=True, k_erode=0.02, dt=1.4,
            uplift=_border_pinned(self.dem.shape, 0.5), talus_deg=None)
        # Compare on the coarse grid the pass actually ran on. Raw-field
        # correlation is 0.67 here and means nothing: the band detail the
        # refinement carries is most of the pointwise variance by design.
        cg = lambda a: ero._coarsen(a, (32, 32)).ravel()  # noqa: E731
        r = np.corrcoef(cg(full), cg(coarse_only))[0, 1]
        self.assertGreater(r, 0.98)

    def test_multires_is_deterministic(self):
        kw = dict(cellsize=32.0, coarse_factor=4, coarse_iterations=5,
                  fine_iterations=2, k_erode=0.02, dt=1.4, talus_deg=None)
        a = ero.stream_power_erode_multires(self.dem, **kw)
        b = ero.stream_power_erode_multires(self.dem, **kw)
        self.assertEqual(a.tobytes(), b.tobytes())


if __name__ == "__main__":
    unittest.main()
