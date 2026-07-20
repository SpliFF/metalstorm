
## 28. Case study — the civilian kit (shipped)

Five models in one pass — ms_habitat, ms_transit_hub, ms_depot,
ms_civtruck, ms_civbus — filling the civilian unitdefs that had
shipped without models (check `units/*.lua` objectnames against
`models/` before inventing new defs; the best showcase is one that
makes existing content work).

**One atlas, five models.** All zones live in one `civkit_layout.py`
partitioning a single 2048² set (stem `fable_civkit`); after each
export the glTF's image URIs are rewritten to the shared filenames
(~15 lines of JSON patching in gen_civkit). Five models cost one
model's texture memory and ONE encode run. Background props never
deserve five texture sets — partition an atlas whenever assets ship
as a family. Buildings get world-anchored side/front/roof bands per
model; vehicles get side/front/roof + shared wheel/hub/trim/glow
cells; `body`-only pieces for buildings, `axle_f`/`axle_r` for the
vehicles (the spin-script API).

**Civilian ≠ military palette.** Warm concrete, light panel, muted
teal and safety orange — no ARMOR grey, no team channel (gaia units).
Scattered lit windows (seeded RNG, ~30%) do more for a habitat block
than any geometry; the L-plan + balconies + roof furniture break the
box at 684 tris.

**Prop-kit gotchas.** (a) Yard items must clear the walls they decorate:
the depot's fuel tank and crates spawned half-inside the hall (blocked
by nothing — intersections don't error, they just look wrong from the
right angle; orbit EVERY prop cluster). (b) Zero-thickness roof slabs
drawn as two coincident faces z-fight — offset the underside 0.04.
(c) Anything coplanar with a roof plane (the transit sign's top at
exactly slab height) shimmers — bury or drop by 0.1. (d) A shared
('z','y') wall zone means hazard rows painted for a platform also
wrap every wall base sampling those rows — give ground-furniture its
own flat cell instead. (e) mud_band over a livery skirt at 0.45
swallows the paint — 0.2 for vehicles.

**No unitdefs shipped** — the five civilian defs already existed;
the kit just gives them bodies. Spawn via the usual model-viewer with
def=ms_habitat etc.
