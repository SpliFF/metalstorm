# FORGE-GUIDE — build a Metalstorm model in this environment

Agent-optimised. Follow the recipe top to bottom; every contract you need is
on this page or in one named sample. Do NOT read the big precedent generators
unless this page says to — that is what burned tokens in batch 1.

## Environment (read-only — never write inside $FORGE except your workspace)

    FORGE=/Users/shannon/WarriorHut/Projects/springrts-web/tools/forge
    ├── venv/         python numpy+pillow — use $FORGE/venv/bin/python ALWAYS
    ├── prefabs/      parts.py (geometry) + paintlib.py (painting) — PREFABS.md
    ├── samples/      21 complete gen/layout/paint triplets from batch 01
    ├── dist/         finished batch outputs (reference only)
    └── bin/          env.sh new-workspace.sh build.sh encode.sh
    TOOLKIT=$FORGE/../fable-model-forge   (sibling folder, via env.sh)
    │                 meshlib.py gltf_export.py paint.py weathering.py
    │                 normals.py bake_impostors.py validate.py encode.mjs

Workspace protocol: create YOUR OWN directory outside $FORGE (session
scratchpad), put your three generator files there, run from there. Multiple
agents share $FORGE concurrently — read-only makes that safe.

    source $FORGE/bin/env.sh          # exports FORGE, PY, PYTHONPATH
    mkdir -p <workspace> && cd <workspace>

## The recipe

1. **Read `$FORGE/docs/DESIGN-GUIDE.md`** (scale table, palette, style rules).
2. **Pick ONE sample as your pattern** (below) and read ONLY its triplet.
3. Write `<stem>_layout.py`, `gen_<stem>.py`, `paint_<stem>.py` in your
   workspace (headers below). Use `prefabs/parts.py` (geometry) and
   `prefabs/paintlib.py` (painting) for anything they cover.
4. **One call builds everything** — gen → paint → validate → encode → bake:

       bash $FORGE/bin/build.sh . <stem> <budget> <piece,piece,…> [--no-team]

   Quiet on success (`ok` per step + summary); on failure it prints that
   step's full output — fix and re-run the same command. `--no-team` only
   for never-team-owned map props. Must end `ALL CHECKS PASSED`.
5. Read the impostor sheet (`bake/<stem>_png_impostor.png`) ONCE, fix what
   looks wrong, re-run build.sh, stop. Do not iterate image-reads beyond a
   second look.

## Sample index — copy the pattern, not the code

| Building | ms_watchtower (animated piece + lattice) · ms_command_post (flag) |
| Wheeled vehicle | ms_scout_buggy (axles, dish) · ms_supply_truck |
| Tracked vehicle | ms_command_s2 (banner, dressing mounts) |
| Multi-module | ms_expedition_rig (hideable mod_* siblings, one socket) |
| Kit (multi-root) | ms_barricade_set (wall/corner/gate, gate `open` clip) |
| Ship | ms_landing_ship (ramp `unload` clip, link empties, boot-top) |
| Mast/tether | ms_comms_relay · ms_obs_balloon (cable/envelope chain) |
| Industrial site | ms_grain_silo · ms_oil_derrick (beam pump) · ms_tank_farm |

## Contracts (exact)

**Frame**: RH, −Z forward, +Y up, ground plane Y=0, 1 unit = 1 m.
Deterministic: RNG seed 90210 everywhere (`np.random.default_rng(90210)`).

**World scale (decided 2026-08-27 — DESIGN-MODEL-BUILDING.md §12)**: keep
authoring in metres exactly as above; `gltf_export.export()` converts to
**elmos** (×`ELMOS_PER_METRE` = 8) at write time, so the emitted .gltf/.bin
and every `SPRINGRTS_geometry` extent are 8× the layout numbers and carry
`units: "elmos"`. Preview/validate/bake tooling frames on the model bbox and
is scale-agnostic. Never pre-multiply layout dims by 8, and never pass
`units='elmo'` for a unit/building (that bypass exists only for map-feature
generators that author directly in elmos).

**Layout module** (`<stem>_layout.py`): ALL dimensions as constants; first
lines set the atlas: `import meshlib; meshlib.ATLAS = 1024` (or 2048 when the
dominant dimension ≥ 15 m). Define texture zones here.

**meshlib** (import from toolkit):
- `Zone(rect, axes, win)` — planar UV projection. rect=(x0,y0,x1,y1) atlas px;
  axes like `('x','y')` (first→u, second→v); win = world windows.
- `Part(name)` — `.add_face(verts, zone=|uvs=, flip=)`, `.tri_count()`.
- `chamfer_box(part, center, size, ch, zones, skip=())` — zones is a dict
  face→**Zone object** (`'+x','-x','+y','-y','+z','-z'`); skip `('-y',)` on
  grounded boxes.
- `limb(part, p0, p1, r0, r1, zone_rect, n=)` — strut between points; takes a
  raw **rect tuple**, not a Zone.
- `tube(part, stations, zone_rect, n, cap_start=, cap_end=, axis=)` — gun
  barrels/masts along an axis. stations = [(coord_along_axis, radius), …];
  caps are **Zone objects**; zone_rect is a **rect**. For placed cylinders
  (tanks, drums, wheels) prefer `prefabs.parts` ring solids instead.
- `ngon_ring(center, radius, n, axis)` → vertex ring; `mirror_x(part, name)`.

**Piece table + export** (gltf_export.export):

    pieces = [dict(name='body', parent=-1, offset=(0,0,0), part=body_part),
              dict(name='dish', parent=0,  offset=(x,y,z), part=dish_part)]
    export(pieces, STEM, texmode='ktx2', outdir='out', clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png',  outdir='out', clips=clips, normal_map=True)

parent = ABSOLUTE index into the list (-1 root). Piece geometry is authored in
PIECE-LOCAL coordinates; offset places it. Standard names: `turret→barrel→
muzzle` (aimable chain), spinnable axles `axle_f/axle_m/axle_r`, `dish`,
`flag`, link empties `link1..linkN` for transports. Empties = Part with no
faces.

**Clips**: names MUST be walk/idle/death/open/unload etc. per spec;
`clips=[{'name':'idle','channels':[(piece,'rotation'|'translation'|'scale',
[(t,value),…])]}]`; rotation = quaternion (x,y,z,w); translation keys are
ABSOLUTE node translations (rest offset + delta); seamless loop ⇒ last key
repeats the first.

**Wheels on the ground**: axle y = r·cos(π/n) so n-gon flats rest flat.

**Painter** (`paint_<stem>.py`): follow your sample's painter, but reach for
`prefabs/paintlib.py` first — `zone_fns` (u/v closures for any zone),
`team_panel`, `glass_rect`, `hazard_band`, `headlight/taillight`,
`wheel_cell/hub_cell`, `panel_patchwork` (scrap register), `roundel_star`,
`font`, then `standard_weather(...)` + `finish(m, L, stem, wx=wx)` — finish
writes all five maps including normals, so a paintlib painter needs no
save/normals boilerplate. Outputs the five PNGs at the layout's atlas size. Team colour ONLY in the team mask R
channel (never baked into diffuse). Emissive = functional lights only —
headlights, beacons, windows; emissive CYAN is reserved for ancient tech.
Weathering: rust streaks under fittings, soot at exhausts, grime at ground
contact — same painter language as the samples.

## Pitfalls (every one of these bit batch 1)

- Zone vs rect mixups (see contracts above) — the #1 error class.
- Forgetting `meshlib.ATLAS` in the layout import → UVs land wrong.
- Non-seamless clip loops (last key ≠ first) → visible pop.
- Engine radius is computed over ALL pieces including hidden modules — note
  it in your report if a hidden-module model needs a tighter combat radius.
- `export` twice: ktx2 AND png variants (png is the preview/bake source).
- Run everything with `$FORGE/venv/bin/python` — system python lacks numpy.
- Never `npm ci`, never create a venv, never `git` anything — it's all here.
- The impostor BAKER flat-shades each triangle from the diffuse at its UV
  centroid: bold thin stripes in a cell mapped to large quads flood whole
  triangles into a checker. That's a baker artifact, not your model — keep
  large-quad cells low-contrast (tone-on-tone ±15%) and DON'T iterate the
  bake chasing it.
- Double-sided non-planar quads: emit explicit triangles with the SAME
  diagonal on both sides — a reversed quad fan-triangulates the other
  diagonal and the surfaces cross.

## Report (structured output)

Return: files (absolute paths), tris vs budget, pieces, clips, encoded y/n,
an ASSETS.md row (License `Generated (Claude <model>)`, Modifications =
generator + prompt + tris + pieces + clips), and integrator notes (mount
offsets, deviations, anything the unitdef writer needs).
