"""Multi-receiver flow routers (D-infinity / MFD) — PLAN-maps M8q.

The load-bearing test here is `test_d8_weights_reproduce_d8_receivers` and its
siblings: the new machinery is only trustworthy as a comparison arm if,
pointed at the D8 graph, it reproduces the old machinery's answer exactly. The
rest gate the two properties the milestone was fired for — that D-infinity
actually leaves the 45-degree lattice, and that a solver run through it comes
out *less* structurally anisotropic than the D8 arm on the same input.
"""
import unittest

import numpy as np

from terragen import erosion as ero
from terragen import hydrology as hyd
from terragen import noise as tn
from terragen import uplift as up


def _routing(h):
    return hyd.resolve_flats(hyd.fill_depressions(h))


def _fbm_dem(seed, n, cellsize=8.0, wavelength=900.0, amp=300.0):
    zz, xx = np.mgrid[0:n, 0:n].astype(np.float64) * cellsize
    f = tn.fbm(tn.SimplexNoise(seed), xx / wavelength, zz / wavelength, octaves=5)
    return amp * (f - f.min())


class TestD8Equivalence(unittest.TestCase):
    """`router="d8"` must be the same graph as `d8_receivers`, not a
    second implementation that happens to look similar."""

    def setUp(self):
        self.dem = _fbm_dem(7, 65)
        self.routing = _routing(self.dem)

    def test_d8_weights_reproduce_d8_receivers(self):
        w = hyd.flow_weights(self.routing, router="d8")
        recv = hyd.d8_receivers(self.routing)
        H, W = self.routing.shape
        idx = np.arange(H * W)
        flat = w.reshape(H * W, 8)

        # exactly one receiver per non-root cell, weight 1.0
        n_recv = (flat > 0).sum(axis=1)
        roots = recv == idx
        self.assertTrue(np.all(n_recv[~roots] == 1))
        self.assertTrue(np.all(n_recv[roots] == 0))
        self.assertTrue(np.allclose(flat.sum(axis=1)[~roots], 1.0))

        # ...and it is the *same* neighbour
        k = flat.argmax(axis=1)
        target = ((idx // W + hyd._D8_DR[k]) * W + (idx % W + hyd._D8_DC[k]))
        self.assertTrue(np.array_equal(target[~roots], recv[~roots]))

    def test_has_receiver_matches_base_level_mask(self):
        w = hyd.flow_weights(self.routing, router="d8")
        recv = hyd.d8_receivers(self.routing)
        self.assertTrue(np.array_equal(
            ~hyd.has_receiver(w),
            up.base_level_mask(recv, self.routing.shape).ravel()))

    def test_multi_accumulation_matches_d8_accumulation(self):
        w = hyd.flow_weights(self.routing, router="d8")
        order = hyd.flow_order(self.routing)
        recv = hyd.d8_receivers(self.routing)
        levels = hyd.topo_levels(recv)
        self.assertTrue(np.allclose(
            hyd.flow_accumulation_multi(w, order),
            hyd.flow_accumulation(recv, levels)))

    def test_path_sum_matches_erosional_distance(self):
        phi_d8, accum = up.erosional_distance_from_dem(self.dem)
        w = hyd.flow_weights(self.routing, router="d8")
        order = hyd.flow_order(self.routing)
        step = 1.0 / np.sqrt(np.maximum(accum.ravel(), 1.0))
        phi_multi = hyd.path_sum_multi(w, order, step).reshape(self.dem.shape)
        self.assertTrue(np.allclose(phi_d8, phi_multi))

    def test_solver_router_d8_is_the_untouched_path(self):
        """The `router` kwarg must not perturb the default arm at all."""
        a = ero.stream_power_erode(self.dem, cellsize=8.0, iterations=4,
                                   k_erode=0.02)
        b = ero.stream_power_erode(self.dem, cellsize=8.0, iterations=4,
                                   k_erode=0.02, router="d8")
        self.assertTrue(np.array_equal(a, b))


class TestRouterProperties(unittest.TestCase):
    def setUp(self):
        self.dem = _fbm_dem(11, 65)
        self.routing = _routing(self.dem)

    def test_weights_partition_flow(self):
        for router in ("dinf", "mfd"):
            w = hyd.flow_weights(self.routing, router=router)
            s = w.reshape(-1, 8).sum(axis=1)
            live = s > 0
            self.assertTrue(np.allclose(s[live], 1.0, atol=1e-6), router)

    def test_receivers_are_strictly_lower(self):
        """The precondition `flow_order` relies on: ascending routing
        elevation is a topological order only if no cell drains sideways."""
        H, W = self.routing.shape
        e = self.routing.ravel()
        for router in ("dinf", "mfd"):
            w = hyd.flow_weights(self.routing, router=router).reshape(H * W, 8)
            src, k = np.nonzero(w)
            dst = ((src // W + hyd._D8_DR[k]) * W + (src % W + hyd._D8_DC[k]))
            self.assertTrue(np.all(e[dst] < e[src]), router)

    def test_same_roots_as_d8(self):
        """A multi router must not invent or lose outlets — the uplift pin
        and every base-level check downstream keys off that set."""
        recv = hyd.d8_receivers(self.routing)
        d8_roots = recv == np.arange(recv.size)
        for router in ("dinf", "mfd"):
            w = hyd.flow_weights(self.routing, router=router)
            self.assertTrue(np.array_equal(~hyd.has_receiver(w), d8_roots),
                            router)

    def test_dinf_leaves_the_lattice(self):
        """The whole point: D8 can only send flow at 45-degree multiples;
        D-infinity sends most cells' flow at an angle in between (which shows
        up as two non-zero weights, neither of them 1)."""
        w8 = hyd.flow_weights(self.routing, router="d8").reshape(-1, 8)
        wi = hyd.flow_weights(self.routing, router="dinf").reshape(-1, 8)
        live = wi.sum(axis=1) > 0
        split8 = ((w8 > 0).sum(axis=1) > 1)[live].mean()
        spliti = ((wi > 0).sum(axis=1) > 1)[live].mean()
        self.assertEqual(split8, 0.0)
        self.assertGreater(spliti, 0.5)
        self.assertLessEqual((wi > 0).sum(axis=1).max(), 2)  # D-inf: at most 2

    def test_mfd_disperses_more_than_dinf(self):
        wi = hyd.flow_weights(self.routing, router="dinf").reshape(-1, 8)
        wm = hyd.flow_weights(self.routing, router="mfd").reshape(-1, 8)
        live = wm.sum(axis=1) > 0
        self.assertGreater((wm > 0).sum(axis=1)[live].mean(),
                           (wi > 0).sum(axis=1)[live].mean())

    def test_accumulation_conserves_mass(self):
        """Everything upstream reaches the outlets exactly once."""
        for router in ("d8", "dinf", "mfd"):
            w = hyd.flow_weights(self.routing, router=router)
            order = hyd.flow_order(self.routing)
            accum = hyd.flow_accumulation_multi(w, order)
            roots = ~hyd.has_receiver(w)
            self.assertAlmostEqual(accum[roots].sum() / accum.size, 1.0,
                                   places=6, msg=router)

    def test_unknown_router_rejected(self):
        with self.assertRaises(ValueError):
            hyd.flow_weights(self.routing, router="d4")
        with self.assertRaises(ValueError):
            ero.stream_power_erode(self.dem, cellsize=8.0, iterations=1,
                                   router="d4")


class TestSolverThroughMultiRouter(unittest.TestCase):
    """The solver has to stay a solver: stable, conservative of base level,
    and (the milestone's actual claim) less lattice-locked than D8."""

    def setUp(self):
        n = 129
        self.cell = 8.0
        self.dem = _fbm_dem(3, n, cellsize=self.cell, wavelength=1400.0,
                            amp=120.0)
        self.uplift = np.full((n, n), 0.02)

    def _run(self, router, iterations=60):
        return ero.stream_power_erode(
            self.dem, cellsize=self.cell, iterations=iterations, dt=1.0,
            k_erode=0.02, uplift=self.uplift, talus_deg=None, router=router)

    def test_solve_is_stable_and_bounded(self):
        for router in ("dinf", "mfd"):
            h = self._run(router)
            self.assertTrue(np.all(np.isfinite(h)), router)
            # implicit scheme: no cell may be driven below its receiver
            self.assertGreater(h.max() - h.min(), 0.0, router)
            self.assertLess(h.max(), self.dem.max() + 1e4, router)

    def test_multi_router_lowers_structural_anisotropy(self):
        """The M8q claim, as a gate. Converge the same field through both
        routers and compare with M8p's instrument at identical grid size."""
        a8, _ = up.structural_anisotropy(self._run("d8", 400), self.cell)
        ai, _ = up.structural_anisotropy(self._run("dinf", 400), self.cell)
        self.assertLess(ai, a8)


if __name__ == "__main__":
    unittest.main()
