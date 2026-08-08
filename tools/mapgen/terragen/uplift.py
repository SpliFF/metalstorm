"""Uplift-field authoring: tectonics as the art-direction surface.

PLAN-maps.md §2b item 2. The generators author terrain by *drawing the
answer* — `region_fields()` blends a per-region target elevation, noise adds
mountains, and erosion runs afterwards as a finishing filter. The alternative
this module exposes is the one the landscape-evolution literature actually
uses: author the **uplift**, and let the stream-power solver produce the
landforms. Ridge spacing, valley density and channel concavity then come out
of the physics rather than out of a noise octave stack.

For that to be an *authoring* surface rather than a knob, an author needs to
be able to aim: "this range tops out at 1230 elmos" has to map to a number
the solver takes. It does, exactly, and the relation is derivable rather than
fitted — see below.


The steady-state relation (derived for `erosion.stream_power_erode`, n = 1)
--------------------------------------------------------------------------

The implicit Braun & Willett step in `_lem_solve_kernel` is

    h_i <- (h_i + dt*U_i + F_i*h_r) / (1 + F_i),   F_i = K_i * A_i^m * dt / dx

so a cell stops moving when `F_i * (h_i - h_r) == dt * U_i`, i.e.

    h_i - h_r = U_i * dx / (K_i * A_i^m)

With `m = 0.5` and `A = a * dx**2` for an accumulation of `a` *cells*, the
`dx` cancels completely:

    h_i - h_r = U_i / (K_i * sqrt(a_i))

Summing that along the flow path from a cell down to its outlet gives the
steady-state elevation as a pure product of the tectonic ratio and a
geometric term:

    h_i = (U / K) * Phi_i,     Phi_i = sum_{path i->outlet} 1 / sqrt(a_j)

`Phi` — `erosional_distance()` below — is a property of the drainage network
alone: no elevations and no rates. It is the single pass over
`hydrology.topo_levels` that turns "how high do you want this" into "how fast
is this rising".

⚠ The `dx` cancelling out of the *relation* does not make `Phi` itself
resolution-free, and reading it that way is the trap this module exists to
document. `Phi` sums `1/sqrt(a)` over the *cells* of a flow path, and a finer
grid resolves more headwater cells — precisely where `a` is smallest and each
step contributes most. (The continuum integral has a log divergence at the
divide; what cuts it off here is the grid, plus thermal erosion.) Measured on
one fBm surface, `Phi` at the 99.9th percentile runs

    128     256     512    1024    2049   cells across
    7.70   10.53   13.94   18.99   25.43

which is about `N**0.43`. So **measure `Phi` at the resolution the map will
ship at**, and if you evolve on a coarse grid first, rescale the uplift for
it — `erosion.stream_power_erode_multires(match_relief=True)` does exactly
that, and without it a quarter-resolution structure pass converges to about
half the intended relief.

Measured on this solver (`tests/test_uplift.py::test_steady_state_relation`
and the M8m field notes): fitting `h` against `Phi` over a converged run
recovers `U/K` to within 1-6 % across U in {0.5, 1, 2}, K in {0.01, 0.02,
0.04} and 1200-2400 iterations.


Cordonnier's constant is not a constant here
--------------------------------------------

The research note that queued this item quotes `h_max[km] = 2.244 * u/k`
(Cordonnier et al. 2016). In the form above that constant *is* `Phi_max` —
the erosional distance of the longest channel in the domain — so it is only
"2.244" for the drainage network of the domain it was measured on. On our
own content it is not close: `Phi_max` is 7-9 on a 129^2 noise square and
**33.4** on the full-res Meridian Basin surface. So this module never uses
the literature constant; it measures `Phi` on the terrain in hand.

A second reason not to reach for a scalar: on Meridian the cell with the
largest `Phi` sits at 132 elmos, nowhere near the 1367-elmo summit. `Phi_max`
answers "how high *could* the longest channel's head stand", which is not the
same question as "how high is the mountain". Author against a quantile
(`relief_scale()`) or per-region, not against the max.


What this surface is for, and what it is not for (M8m, measured)
----------------------------------------------------------------

Authoring uplift means asking the solver for *its* landscape. That is only
what you want on a map with no authored elevation skeleton. Neither shipping
generator is such a map, and the numbers are not close:

  * `meridian2.ELEVATION` specifies a mean elevation for each of 24 gameplay
    regions. Run as it ships — 30 iterations, no uplift — the finished
    terrain tracks that table at **r = 0.980**. Re-authored as uplift and run
    to near-convergence, it tracks it at **r = 0.372**, and the ordering
    inverts outright: `west_narrows` is the map's *lowest* authored region at
    -34 and comes out at 561 elmos, above every scarp.
  * Converged terrain is also *flatter* where the author said nothing.
    Region-mean spread: authored 1264 elmos, shipping arm 774, uplift arm
    478. Steady state puts relief where the uplift is and nowhere else, which
    is correct physics and a poor gameplay skeleton.

And at the iteration counts the generators actually run, uplift is not an
authoring surface at all — it is an additive elevation layer, which
`region_fields()` already is. 30 iterations of the shipping configuration
with and without an authored uplift field correlate at **0.999872**, and the
mean difference is 14.8 elmos against `30 * dt * mean(U)` = 14.7: the field
is being added, not integrated. Producing landforms takes ~3000 iterations
(see `erosion.stream_power_erode_multires` for what makes that affordable),
by which point the skeleton is gone.

So: use this for generated maps whose art direction *is* the tectonics
(§2b's biome/terrain variants), not to re-author a map that carries a region
contract. It was not the D8 router that made the converged arm look combed,
incidentally — the flow-direction distribution is no more anisotropic after
3000 iterations than after 30 (normalised entropy 0.975 vs 0.978). The
regular transverse valleys are the LEM's real answer to a smooth linear
uplift belt.


⚠ The precondition, which is not optional: pin the base level
-------------------------------------------------------------

Uplift applied uniformly to *every* cell, outlets included, does **nothing**.
`stream_power_erode` never erodes a root (it zeroes `F` there), so a root
that is also uplifting simply rises with the rest of the map: the surface
translates rigidly and the landform is bit-for-bit the U = 0 landform. This
is not a subtle bias — measured on a 129^2 control, 400 iterations at
U/K = 25 gives relief **0.28** with the border uplifting and **180.66** with
it pinned, against a predicted `(U/K)*Phi_max` of 222.

`stream_power_erode` now pins outlets itself (`pin_base_level=True`, and the
roots are recomputed every iteration anyway), so the trap is closed at the
solver rather than left for each caller to remember. `pin_base_level()` here
does the same thing to a field you want to inspect before handing it over.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

from . import hydrology as hyd
from . import noise as tn


def erosional_distance(
    receivers: np.ndarray, levels: list[np.ndarray], accum: np.ndarray
) -> np.ndarray:
    """`Phi_i = sum_{path i->outlet} 1/sqrt(a_j)`, flat, one pass over levels.

    The geometric half of the steady-state relation: `h = (U/K) * Phi`.
    Outlets contribute nothing (they *are* base level), so `Phi` is 0 there
    and grows headward. Unitless, and independent of cell size — see the
    module docstring for why the `dx` cancels.
    """
    n = receivers.size
    idx = np.arange(n, dtype=np.int64)
    inv = 1.0 / np.sqrt(np.maximum(np.asarray(accum, dtype=np.float64).ravel(), 1.0))
    inv[receivers == idx] = 0.0
    phi = np.zeros(n, dtype=np.float64)
    for lvl in levels[1:]:
        phi[lvl] = phi[receivers[lvl]] + inv[lvl]
    return phi


def erosional_distance_from_dem(dem: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Route `dem` and return `(Phi, accum)`, both shaped like `dem`.

    Convenience wrapper — routes exactly the way `stream_power_erode` does
    (fill -> resolve flats -> D8), so the `Phi` it returns is the one the
    solver will actually be integrating along.
    """
    filled = hyd.fill_depressions(dem)
    routing = hyd.resolve_flats(filled)
    recv = hyd.d8_receivers(routing)
    levels = hyd.topo_levels(recv)
    accum = hyd.flow_accumulation(recv, levels)
    phi = erosional_distance(recv, levels, accum)
    return phi.reshape(dem.shape), np.asarray(accum).reshape(dem.shape)


def base_level_mask(receivers: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Cells that receive themselves — the outlets the solver never erodes."""
    idx = np.arange(receivers.size, dtype=np.int64)
    return (receivers == idx).reshape(shape)


def pin_base_level(uplift: np.ndarray, receivers: np.ndarray) -> np.ndarray:
    """Zero `uplift` at outlets, returning a copy.

    Without this the field is a rigid translation and buys no relief at all
    (module docstring, "The precondition"). `stream_power_erode` applies the
    same rule internally every iteration; this is for inspecting or plotting
    a field before it goes in.
    """
    u = np.array(uplift, dtype=np.float64, copy=True)
    u.ravel()[base_level_mask(receivers, u.shape).ravel()] = 0.0
    return u


def steady_state_relief(
    uplift: np.ndarray | float, k_erode: np.ndarray | float, phi: np.ndarray
) -> np.ndarray:
    """Predicted steady-state elevation above base level: `(U/K) * Phi`.

    `uplift` and `k_erode` may be scalars or per-cell fields; where they vary
    slowly compared with the drainage network this is accurate to a few per
    cent, which is what makes the inverse below an aiming device rather than
    a guarantee. It is a *steady-state* prediction: a run of 30 iterations is
    nowhere near it (M8m measured the approach), so predict against the
    iteration count you actually intend to run.
    """
    u = np.asarray(uplift, dtype=np.float64)
    k = np.asarray(k_erode, dtype=np.float64)
    return (u / k) * phi


def uplift_for_relief(
    target_relief: np.ndarray | float,
    k_erode: np.ndarray | float,
    phi: np.ndarray,
    phi_floor: float = 1e-3,
) -> np.ndarray:
    """Invert the relation: uplift that holds `target_relief` at steady state.

    `U = target * K / Phi`. `phi_floor` guards the division at outlets and
    their immediate neighbours, where `Phi -> 0` and the exact inverse
    diverges; those cells are base level and want no uplift anyway, so the
    floor clamps rather than blows up.

    The result is a *first-order aim*: `Phi` is measured on the terrain you
    have, and the drainage network reorganises as the solver runs, so the
    achieved relief tracks the target rather than matching it. Author
    low-frequency targets — a painted range, a per-region table — not a
    per-cell surface, or you are just freezing the input back into the
    output and the physics has nothing left to produce.
    """
    t = np.asarray(target_relief, dtype=np.float64)
    k = np.asarray(k_erode, dtype=np.float64)
    return t * k / np.maximum(phi, phi_floor)


def relief_scale(phi: np.ndarray, quantile: float = 0.999) -> float:
    """The `Phi` an author should aim a summit at — a high quantile, not max.

    `Phi_max` is the head of the single longest channel, which on real
    content is a low, remote cell rather than the peak (33.4 vs a summit at
    Phi ~ 8 on Meridian). A high quantile is the stable statistic: it moves
    with the drainage network's overall depth instead of with one outlier.
    """
    return float(np.quantile(phi, quantile))


def smooth_uplift(
    field: np.ndarray, cellsize: float, wavelength_elmos: float = 2000.0
) -> np.ndarray:
    """Low-pass an authored field to the scale uplift is allowed to vary on.

    Tectonic uplift is the *long*-wavelength input; fine structure in `U`
    survives into the output as fine structure in `h`, which defeats the
    point of letting erosion carve. Gaussian, sigma = wavelength / 4.
    """
    sigma = max(1.0, wavelength_elmos / (4.0 * cellsize))
    return ndimage.gaussian_filter(np.asarray(field, dtype=np.float64), sigma=sigma)


def noise_uplift(
    shape: tuple[int, int],
    cellsize: float,
    seed: int,
    *,
    wavelength_elmos: float = 6000.0,
    octaves: int = 3,
    ridged: bool = True,
    floor: float = 0.0,
) -> np.ndarray:
    """A low-frequency uplift field in [floor, 1] — the "painted" surface's
    procedural sibling, for maps with no authored region table.

    `ridged=True` gives belt-like orogens (long connected highs) rather than
    the blobby highs plain fBm produces, which is the shape most mountain
    ranges actually have.
    """
    H, W = shape
    zz, xx = np.mgrid[0:H, 0:W].astype(np.float64) * cellsize
    n = tn.SimplexNoise(seed)
    gen = tn.ridged if ridged else tn.fbm
    f = gen(n, xx / wavelength_elmos, zz / wavelength_elmos, octaves=octaves)
    lo, hi = float(f.min()), float(f.max())
    f = (f - lo) / max(hi - lo, 1e-9)
    return floor + (1.0 - floor) * f
