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


⚠ `Phi` is only the whole story for a *uniform* ratio
-----------------------------------------------------

Pulling `U/K` outside the sum is the step that produces `Phi`, and it is
exact only while the ratio is constant along the flow path. An uplift field
that draws a landform is not: an island's summit-to-sea path leaves the
uplifting region within a few cells, and `Phi`'s remaining tail then gets
multiplied by an uplift that is not there. Measured on the island-arc field
(M8p), aiming a 950-elmo summit with `(U_max/K)*relief_scale(Phi)` lands at
283 — 2.4x short, and because the error is a property of the field's shape
rather than of the solver, no constant corrects it.

For a shaped field, use `steady_state_relief_field` — the same relation with
the ratio kept inside the sum, `Psi_i = sum_path U_j/(K_j*sqrt(a_j))`, and
the same single pass over `topo_levels`. `scale_uplift_for_relief` is the
authoring verb built on it: draw the tectonics at whatever relative
amplitudes read well, and it returns the factor that puts the highest ground
where the author said (within ~10 % on the arc).


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


def erosional_distance_from_dem(
    dem: np.ndarray, router: str = "d8", mfd_p: float = 1.1
) -> tuple[np.ndarray, np.ndarray]:
    """Route `dem` and return `(Phi, accum)`, both shaped like `dem`.

    Convenience wrapper — routes exactly the way `stream_power_erode` does
    (fill -> resolve flats -> route), so the `Phi` it returns is the one the
    solver will actually be integrating along. Pass the same `router` you
    intend to erode with: a dispersive router both shortens the path sum and
    spreads the area, and aiming with the wrong one silently mis-scales the
    uplift.
    """
    filled = hyd.fill_depressions(dem)
    routing = hyd.resolve_flats(filled)
    if router == "d8":
        recv = hyd.d8_receivers(routing)
        levels = hyd.topo_levels(recv)
        accum = hyd.flow_accumulation(recv, levels)
        phi = erosional_distance(recv, levels, accum)
    else:
        w = hyd.flow_weights(routing, router=router, mfd_p=mfd_p)
        order = hyd.flow_order(routing)
        accum = hyd.flow_accumulation_multi(w, order)
        step = 1.0 / np.sqrt(np.maximum(accum, 1.0))
        phi = hyd.path_sum_multi(w, order, step)
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

    ⚠ "Slowly compared with the drainage network" is a real precondition and
    a field that *draws a landform* violates it — see
    `steady_state_relief_field`, which is the same relation with the ratio
    left inside the path sum. On the island-arc field this form is 2.4x out.
    """
    u = np.asarray(uplift, dtype=np.float64)
    k = np.asarray(k_erode, dtype=np.float64)
    return (u / k) * phi


def steady_state_relief_field(
    uplift: np.ndarray,
    k_erode: np.ndarray | float,
    receivers: np.ndarray,
    levels: list[np.ndarray],
    accum: np.ndarray,
) -> np.ndarray:
    """Steady state for a field that varies *on the drainage's own scale*.

        Psi_i = sum_{path i->outlet} U_j / (K_j * sqrt(a_j))

    `steady_state_relief` above pulls one `U/K` outside the sum and
    multiplies it by `Phi`. That step is exact only while the ratio is
    constant along the flow path, and its docstring's "varies slowly
    compared with the drainage network" is the precondition. An uplift that
    draws a *landform* — an island, a volcanic centre, a range that ends —
    breaks it by construction: the path from a summit to the sea leaves the
    uplifting region within a few cells and the whole remaining tail of
    `Phi` is multiplied by an uplift that is not there.

    Measured on the island-arc field (PLAN-maps M8p): aiming a 950-elmo
    summit with `(U_max/K)*relief_scale(Phi)` lands at 283 elmos — 2.4x
    short, and the error is a property of the field's shape, so no constant
    corrects it. Aiming the same field with `Psi` lands within 10 %.

    Shape is `receivers`'; reshape to the DEM yourself, or use
    `steady_state_relief_from_dem`.
    """
    n = np.asarray(receivers).size
    idx = np.arange(n, dtype=np.int64)
    a = np.maximum(np.asarray(accum, dtype=np.float64).ravel(), 1.0)
    k = np.broadcast_to(np.asarray(k_erode, dtype=np.float64),
                        np.asarray(uplift).shape).ravel()
    step = np.asarray(uplift, dtype=np.float64).ravel() / (k * np.sqrt(a))
    step[receivers == idx] = 0.0
    psi = np.zeros(n, dtype=np.float64)
    for lvl in levels[1:]:
        psi[lvl] = psi[receivers[lvl]] + step[lvl]
    return psi


def steady_state_relief_from_dem(
    dem: np.ndarray,
    uplift: np.ndarray,
    k_erode: np.ndarray | float,
    router: str = "d8",
    mfd_p: float = 1.1,
) -> np.ndarray:
    """`steady_state_relief_field` routed off `dem`, shaped like `dem`.

    `router` must match the one the solve will use — see
    `erosional_distance_from_dem`. On a multi-receiver graph `Psi` becomes
    the flow-weighted *expected* path sum (`hydrology.path_sum_multi`), which
    is the only reading of "the path to the sea" that survives a cell sending
    water two ways.
    """
    filled = hyd.fill_depressions(dem)
    routing = hyd.resolve_flats(filled)
    if router == "d8":
        recv = hyd.d8_receivers(routing)
        levels = hyd.topo_levels(recv)
        accum = hyd.flow_accumulation(recv, levels)
        return steady_state_relief_field(
            uplift, k_erode, recv, levels, accum).reshape(dem.shape)
    w = hyd.flow_weights(routing, router=router, mfd_p=mfd_p)
    order = hyd.flow_order(routing)
    accum = hyd.flow_accumulation_multi(w, order)
    k = np.broadcast_to(np.asarray(k_erode, dtype=np.float64),
                        np.asarray(uplift).shape).ravel()
    step = (np.asarray(uplift, dtype=np.float64).ravel()
            / (k * np.sqrt(np.maximum(accum, 1.0))))
    return hyd.path_sum_multi(w, order, step).reshape(dem.shape)


def scale_uplift_for_relief(
    dem: np.ndarray,
    uplift: np.ndarray,
    k_erode: np.ndarray | float,
    target_relief: float,
    quantile: float = 0.999,
    router: str = "d8",
    mfd_p: float = 1.1,
) -> float:
    """The factor that makes `uplift` hold `target_relief` at steady state.

    The authoring verb for a *shaped* field: draw the tectonics with
    whatever amplitudes read well relative to each other, then ask this what
    to multiply the whole field by so its highest ground stands where the
    author said. Aims at a quantile of `Psi` rather than its max for the
    same reason `relief_scale` does — the max is one remote headwater cell.

    First-order, like `uplift_for_relief`: `Psi` is measured on the terrain
    in hand and the drainage reorganises as the solver runs. On the island
    arc that costs ~10 %, against the 2.4x the scalar form costs there.
    """
    psi = steady_state_relief_from_dem(dem, uplift, k_erode, router=router,
                                       mfd_p=mfd_p)
    return float(target_relief) / max(float(np.quantile(psi, quantile)), 1e-9)


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


def structural_anisotropy(
    dem: np.ndarray,
    cellsize: float,
    lo_elmos: float = 32.0,
    hi_elmos: float = 120.0,
    bins: int = 90,
) -> tuple[float, float]:
    """Is this landscape's fine structure *oriented*? `(peak/mean, entropy)`.

    The acceptance instrument for solver-authored terrain, and the reason
    this milestone (M8p) could reach a verdict at all. A dendritic landscape
    spreads its spectral energy over every orientation; a lattice-born
    herringbone puts it in two lobes. This bins the 2-D power spectrum of
    one wavelength band by direction and reports how many times the mean
    sector the strongest sector holds, plus the normalised angular entropy.

    Measured at 8 elmos/cell over the 32-120 elmo band (M8p): the shipped
    `skerry_reach` surface reads **1.24 / 0.9989**, and the same map's
    terrain authored as uplift and run to steady state reads
    **7.30 / 0.9046** — which is what the hillshades show, straight parallel
    spurs against dendritic valleys.

    ⚠ Do not judge this with a gradient-*aspect* histogram, which is the
    obvious instrument and does not work: on the same pair it reads +0.048
    against +0.059 of lattice-direction excess, i.e. it calls a herringbone
    and a shipped map the same thing. Aspect asks "do slopes face the eight
    directions", and a converged D8 landscape can say no while its ridges
    are still periodic and parallel. M8m's flow-direction entropy (0.975 vs
    0.978, "no more anisotropic after 3000 iterations") is the same instrument
    on the router instead of the surface, and its conclusion — that the
    combing was not a lattice artifact — does not survive this one.

    ⚠ The reading has a sample-count floor, so **only compare surfaces at
    the same grid size**. One isotropic fBm reads 2.35 / 1.84 / 1.68 at 257 /
    513 / 1025 cells across, against 1.24 for the 2049-cell shipped map: a
    coarse preview scores "anisotropic" on nothing but its own bin counts.
    """
    p = _angular_power(dem, cellsize, lo_elmos, hi_elmos, bins)
    if p is None:
        return 1.0, 1.0
    nz = p[p > 0]
    return float(p.max() / p.mean()), float(-(nz * np.log(nz)).sum()
                                            / np.log(bins))


def _angular_power(
    dem: np.ndarray,
    cellsize: float,
    lo_elmos: float,
    hi_elmos: float,
    bins: int,
) -> "np.ndarray | None":
    """Normalised angular distribution of one wavelength band's power.

    Shared by `structural_anisotropy` and `angular_lobes` so the two can
    never drift apart — they are one histogram read two ways.
    """
    h = np.asarray(dem, dtype=np.float64)
    n = min(h.shape)
    h = h[:n, :n] - h[:n, :n].mean()
    w = np.hanning(n)
    f = np.fft.fftshift(np.fft.fft2(h * w[:, None] * w[None, :]))
    power = f.real ** 2 + f.imag ** 2
    freq = np.fft.fftshift(np.fft.fftfreq(n, cellsize))
    fz, fx = np.meshgrid(freq, freq, indexing="ij")
    k = np.hypot(fx, fz)
    band = (k > 1.0 / hi_elmos) & (k < 1.0 / lo_elmos)
    if not band.any():
        return None
    ang = (np.degrees(np.arctan2(fz, fx)) % 180.0)[band]
    hist, _ = np.histogram(ang, bins=bins, range=(0.0, 180.0),
                           weights=power[band])
    total = hist.sum()
    if total <= 0:
        return None
    return hist / total


def angular_lobes(
    dem: np.ndarray,
    cellsize: float,
    lo_elmos: float = 32.0,
    hi_elmos: float = 120.0,
    bins: int = 90,
    top: int = 3,
    suppress: int = 2,
) -> list[tuple[float, float]]:
    """The top `top` oriented lobes as `[(degrees, x mean), ...]`, strongest
    first — `structural_anisotropy`'s histogram read past its own peak.

    ⚠ Read this, not peak/mean alone, when judging solver-authored terrain.
    `structural_anisotropy` is a **single-lobe** detector: peak/mean is
    maximised by a herringbone (one direction) and sits near 1 for a
    cross-hatch (two directions 90 deg apart), which is a surface the eye
    refuses and the scalar passes (PLAN-maps M8q FIND 3). The lobe list
    separates the three cases the scalar cannot:

    - D8 arc, 2049^2 @ 8 elmos: `[44 x5.27, 136 x2.35, 38 x2.14]` — one
      dominant diagonal, textbook comb.
    - the same field over D-infinity: `[48 x1.42, 92 x1.39, 0 x1.34]` — the
      peak has collapsed but a 45 deg lobe and an axis-aligned one are both
      still there, at nearly the same height.
    - shipped `skerry_reach`: `[90 x1.24, 42 x1.20, 54 x1.18]` — a flat
      list, i.e. no structure rather than balanced structure.

    So the shape of the *list* is the reading: one tall entry is a comb, two
    comparable entries 45-90 deg apart are a cross-hatch, and a flat list is
    dendritic. `suppress` blanks that many bins either side of each pick so
    the second entry is a different lobe and not the shoulder of the first.

    Same sample-count floor as `structural_anisotropy` — only compare
    surfaces measured at the same grid size.
    """
    p = _angular_power(dem, cellsize, lo_elmos, hi_elmos, bins)
    if p is None:
        return [(0.0, 1.0)] * top
    ratio = p / p.mean()
    width = 180.0 / bins
    out: list[tuple[float, float]] = []
    taken = np.zeros(bins, bool)
    for _ in range(top):
        masked = np.where(taken, -1.0, ratio)
        i = int(np.argmax(masked))
        out.append((float(i * width), float(ratio[i])))
        for d in range(-suppress, suppress + 1):
            taken[(i + d) % bins] = True
    return out


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
