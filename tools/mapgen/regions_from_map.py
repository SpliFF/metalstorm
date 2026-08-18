#!/usr/bin/env python3
"""
regions_from_map.py — derive a Metalstorm region graph (`regions.json`) from a
processed map's heightmap, for maps that ship no hand-authored layout.

Why this exists: Metalstorm's strategic AI (`ai/strategos/picture.lua`) and the
client overlay (`ui/lib/regions.js`) both read `regions.json` and treat its
`neighbors` lists as the map's movement graph. Every imported Recoil map ships a
`provider: "grid"` stub with **zero** regions, so on those maps the AI is blind:
`regionOf()` returns nil for every unit and the whole picture collapses to the
`_all` bucket.

The load-bearing design decision here is that **an edge in the graph means
armour can actually drive between those two regions**. Meridian Basin — the one
hand-authored map — is the cautionary tale: its 24-region graph declares
neighbours that no ground unit can traverse, and its two start positions sit in
different connected components for every movement class except INFANTRY. An AI
following that graph paths into a mountain. So adjacency here is measured off
the passability mask, never assumed from grid position, and `--verify` fails a
map whose start positions cannot reach each other.

Passability mirrors Spring's MoveDef test (`moveinfo.tdf`): a cell is passable
for a class when its steepest neighbour slope is within `maxslope` and, if it is
under water, the depth is within `maxwaterdepth`. VEH (32 deg / 20 depth) is the
default reference class — infantry can cross terrain no vehicle can, so grading
on infantry would reproduce exactly the Meridian failure.

Usage:
    regions_from_map.py <map-dir> [--class VEH] [--target-regions 20]
                        [--starts "x,z;x,z"] [--verify] [--dry-run]

`--verify` IS READ-ONLY. It used to write `mapdata/regions.lua` + `regions.json`
like a plain run and merely add an exit code on top, which meant "check whether
this map is playable" silently *converted the map to the graph provider*. That
is not hypothetical: `green_flat_x34_v3` and `skerry_reach` deliberately ship no
`mapdata/regions.lua` so that `game_regions.lua` selects the 2048-elmo GRID
provider, and `scenario_smoke_test.lua` addresses green_flat by grid key
("2:2"). One verification sweep across every map gave both of them a 16-region
named graph and broke those keys. A verifier that mutates what it inspects
cannot be used to check anything, so `--verify` now implies `--dry-run`.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import struct
import sys
from collections import deque

# `terragen.reachability` is stdlib-only on purpose (no numpy, no scipy), so
# this stays runnable on a bare checkout. It owns the intent vocabulary, the
# mapinfo emitter the generators write, the parser below, and the verdict rule —
# one file, so the writer and the reader cannot drift.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from terragen import reachability as reach   # noqa: E402

# --- Spring MoveDef classes, from data/games/metalstorm/.../moveinfo.tdf -----
# (name, maxslope degrees, maxwaterdepth elmos)
MOVE_CLASSES = {
    "INFANTRY": (45, 12),
    "VEH": (32, 20),
    "HEAVY": (24, 30),
}
DEFAULT_CLASS = "VEH"

ELMOS_PER_SQUARE = 8  # Spring: heightmap sample spacing


# --------------------------------------------------------------------------
# Map loading
# --------------------------------------------------------------------------

def read_mapinfo(map_dir: str) -> dict:
    """Pull the few scalars we need out of mapinfo.lua by regex.

    Deliberately not a Lua parser: we need exactly minheight/maxheight, and
    every processed map writes them as plain `key = number` at top level.
    """
    path = os.path.join(map_dir, "mapinfo.lua")
    text = open(path, "r", encoding="utf-8", errors="replace").read()
    out = {}
    for key in ("minheight", "maxheight"):
        m = re.search(rf"\b{key}\s*=\s*(-?[0-9.]+)", text, re.IGNORECASE)
        if m:
            out[key] = float(m.group(1))
    if "minheight" not in out or "maxheight" not in out:
        raise SystemExit(f"{path}: could not read minheight/maxheight")
    # The map's own claim about its armour realms — see terragen/reachability.py
    # and PLAN-maps.md §2k. A map that says nothing declares "connected"; a map
    # that says something unrecognised is an error with its own message, not a
    # traceback and not a silent fall back to the strict reading.
    try:
        out["reachability"] = reach.parse_mapinfo(text)
    except ValueError as e:
        raise SystemExit(f"{path}: {e}")
    return out


def read_heightmap(map_dir: str, lo: float, hi: float, dims=None):
    """Return (heights, W, H) where heights is a flat float list, row-major.

    heightmap.bin is uint16 little-endian, (mapx+1) x (mapy+1) samples spaced
    8 elmos apart, linearly quantised across [minheight, maxheight].

    `dims` should come from the map registry when available. Inferring them
    from the sample count alone cannot distinguish WxH from HxW on a
    rectangular map, and guessing the transpose reads every row at the wrong
    stride: wanderlust2.1 (641x513) came back as 513x641 and graded as 3.6%
    vehicle-passable, when it is in fact almost entirely drivable.
    """
    path = os.path.join(map_dir, "heightmap.bin")
    raw = open(path, "rb").read()
    count = len(raw) // 2
    if dims is not None and dims[0] * dims[1] == count:
        W, H = dims
    else:
        got = _infer_dims(count)
        if got is None:
            raise SystemExit(
                f"{path}: {count} samples is not (mapx+1)*(mapy+1) for any plausible map size"
            )
        W, H = got
    vals = struct.unpack(f"<{count}H", raw)
    scale = (hi - lo) / 65535.0
    return [lo + scale * v for v in vals], W, H


def _infer_dims(count: int):
    """Recover (W, H) from a sample count.

    Square maps are the common case; rectangular ones (techno_lands 897x1921,
    wanderlust 641x513) are recovered by trying every divisor whose two factors
    are both (multiple-of-64 + 1), which is what Spring's mapx/mapy guarantee.
    """
    r = math.isqrt(count)
    if r * r == count and (r - 1) % 64 == 0:
        return r, r
    for w in range(65, count // 64 + 2):
        if count % w:
            continue
        h = count // w
        if (w - 1) % 64 == 0 and (h - 1) % 64 == 0:
            return w, h
    return None


def read_map_row(map_id: str, repo_root: str):
    """Start positions and mapx/mapy live in the server DB, not in the map dir."""
    db = os.path.join(repo_root, "data", "spring-server.db")
    if not os.path.exists(db):
        return None
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        row = con.execute(
            "select start_positions, mapx, mapy from maps where id = ?", (map_id,)
        ).fetchone()
        con.close()
    except Exception:
        return None
    return row


def parse_starts(spec: str):
    if not spec:
        return []
    out = []
    for pair in spec.split(";"):
        pair = pair.strip()
        if not pair:
            continue
        try:
            x, z = pair.split(",")
            out.append((float(x), float(z)))
        except ValueError:
            continue
    return out


# --------------------------------------------------------------------------
# Passability
# --------------------------------------------------------------------------

def passable_mask(hs, W, H, max_slope_deg: float, max_water_depth: float):
    """Per-sample passability for one movement class.

    Slope is the steepest of the four axis neighbours, matching how Spring
    grades a square off its corner heights closely enough for graph purposes.
    """
    tan_max = math.tan(math.radians(max_slope_deg))
    ok = bytearray(W * H)
    for z in range(H):
        base = z * W
        for x in range(W):
            i = base + x
            h = hs[i]
            if h < 0 and -h > max_water_depth:
                continue
            steep = 0.0
            if x > 0:
                steep = max(steep, abs(h - hs[i - 1]))
            if x < W - 1:
                steep = max(steep, abs(h - hs[i + 1]))
            if z > 0:
                steep = max(steep, abs(h - hs[i - W]))
            if z < H - 1:
                steep = max(steep, abs(h - hs[i + W]))
            if steep / ELMOS_PER_SQUARE <= tan_max:
                ok[i] = 1
    return ok


def components(ok, W, H):
    """Flood-fill the passable mask. Returns (comp_id_per_sample, sizes)."""
    comp = [-1] * (W * H)
    sizes = []
    for s0 in range(W * H):
        if not ok[s0] or comp[s0] >= 0:
            continue
        cid = len(sizes)
        q = deque([s0])
        comp[s0] = cid
        n = 0
        while q:
            p = q.popleft()
            n += 1
            z, x = divmod(p, W)
            if x > 0 and ok[p - 1] and comp[p - 1] < 0:
                comp[p - 1] = cid; q.append(p - 1)
            if x < W - 1 and ok[p + 1] and comp[p + 1] < 0:
                comp[p + 1] = cid; q.append(p + 1)
            if z > 0 and ok[p - W] and comp[p - W] < 0:
                comp[p - W] = cid; q.append(p - W)
            if z < H - 1 and ok[p + W] and comp[p + W] < 0:
                comp[p + W] = cid; q.append(p + W)
        sizes.append(n)
    return comp, sizes


# --------------------------------------------------------------------------
# Region naming
# --------------------------------------------------------------------------

# Deterministic, map-seeded names. Metalstorm's one hand-authored map uses
# evocative district names ("Cinder Forge", "Granary Vale"), and the AI's debug
# output and the client overlay both surface these to a human, so "r_3_5" would
# be a real readability regression.
_HEAD = ["Ash", "Cinder", "Iron", "Granite", "Hollow", "Amber", "Salt", "Storm",
         "Bitter", "Copper", "Dusk", "Fallow", "Grey", "Hunter", "Kestrel",
         "Larch", "Marrow", "North", "Osprey", "Pale", "Quarry", "Raven",
         "Slate", "Thorn", "Umber", "Vesper", "Wither", "South", "East", "West"]
_TAIL = ["Forge", "Vale", "Reach", "Gate", "Watch", "Basin", "Hollow", "Ridge",
         "Fen", "Crossing", "Span", "Bluff", "Moor", "Drift", "Verge", "Row",
         "Shelf", "Hook", "Bend", "Sound", "Flat", "Dell", "Cut", "Rise"]


def name_for(index: int, seed: int) -> tuple[str, str]:
    h = _HEAD[(index * 7 + seed) % len(_HEAD)]
    t = _TAIL[(index * 5 + seed // 3) % len(_TAIL)]
    name = f"{h} {t}"
    return re.sub(r"[^a-z0-9]+", "_", name.lower()), name


# --------------------------------------------------------------------------
# Region graph construction
# --------------------------------------------------------------------------

def build_regions(hs, ok, comp, W, H, target: int, starts, seed: int):
    """Partition the map into a grid of regions, then wire edges by passability.

    Cells are the partition unit (matching the rectangular polygons the
    hand-authored map uses), but an edge is emitted only where the two cells
    share passable samples that are in the SAME connected component — which is
    what makes the graph a movement graph rather than a picture of the grid.
    """
    aspect = H / W
    cols = max(2, int(round(math.sqrt(target / aspect))))
    rows = max(2, int(round(cols * aspect)))

    cw = W / cols
    ch = H / rows

    def cell_of(x, z):
        return min(cols - 1, int(x / cw)), min(rows - 1, int(z / ch))

    # Per-cell statistics.
    cells = {}
    for cz in range(rows):
        for cx in range(cols):
            x0, x1 = int(cx * cw), int((cx + 1) * cw)
            z0, z1 = int(cz * ch), int((cz + 1) * ch)
            n = npass = 0
            hsum = 0.0
            water = 0
            comp_hist = {}
            for z in range(z0, min(z1, H)):
                b = z * W
                for x in range(x0, min(x1, W)):
                    i = b + x
                    n += 1
                    hsum += hs[i]
                    if hs[i] < 0:
                        water += 1
                    if ok[i]:
                        npass += 1
                        comp_hist[comp[i]] = comp_hist.get(comp[i], 0) + 1
            if n == 0:
                continue
            cells[(cx, cz)] = {
                "x0": x0, "x1": x1, "z0": z0, "z1": z1,
                "n": n, "npass": npass, "water": water,
                "mean_h": hsum / n,
                "comp": max(comp_hist, key=comp_hist.get) if comp_hist else -1,
                "comp_hist": comp_hist,
            }

    # Drop cells with essentially nothing traversable — an all-water or
    # all-cliff cell is not a place an army can be, and emitting it as a region
    # would give the AI a destination it can never occupy.
    MIN_PASS_FRAC = 0.04
    keys = [k for k, c in cells.items()
            if c["npass"] / c["n"] >= MIN_PASS_FRAC and c["comp"] >= 0]
    keys.sort(key=lambda k: (k[1], k[0]))

    idx_of = {k: i for i, k in enumerate(keys)}
    regions = []
    for i, k in enumerate(keys):
        c = cells[k]
        key, name = name_for(i, seed)
        regions.append({
            "_cell": k, "_c": c, "key": key, "name": name,
            "neighbors": [], "tags": [], "value": 1.0,
        })

    # De-duplicate names (the generator can collide on small maps).
    seen = {}
    for r in regions:
        if r["key"] in seen:
            seen[r["key"]] += 1
            r["key"] = f"{r['key']}_{seen[r['key']]}"
            r["name"] = f"{r['name']} {seen[r['key']]}"
        else:
            seen[r["key"]] = 1

    # Edges: count samples along the shared border where BOTH sides are
    # passable and in the same component. A handful of stray samples is noise
    # (a one-cell notch in a cliff is not a road), so require a real opening.
    MIN_CROSSINGS = 3
    for (cx, cz), i in idx_of.items():
        for dx, dz in ((1, 0), (0, 1)):
            nk = (cx + dx, cz + dz)
            j = idx_of.get(nk)
            if j is None:
                continue
            a, b = cells[(cx, cz)], cells[nk]
            crossings = 0
            if dx == 1:
                xb = a["x1"]
                if xb < W:
                    for z in range(max(a["z0"], b["z0"]), min(a["z1"], b["z1"], H)):
                        pa, pb = z * W + xb - 1, z * W + xb
                        if ok[pa] and ok[pb] and comp[pa] == comp[pb]:
                            crossings += 1
            else:
                zb = a["z1"]
                if zb < H:
                    for x in range(max(a["x0"], b["x0"]), min(a["x1"], b["x1"], W)):
                        pa, pb = (zb - 1) * W + x, zb * W + x
                        if ok[pa] and ok[pb] and comp[pa] == comp[pb]:
                            crossings += 1
            if crossings >= MIN_CROSSINGS:
                regions[i]["neighbors"].append(regions[j]["key"])
                regions[j]["neighbors"].append(regions[i]["key"])
                regions[i].setdefault("_cross", {})[regions[j]["key"]] = crossings
                regions[j].setdefault("_cross", {})[regions[i]["key"]] = crossings

    # Tags + value.
    main_comp = None
    comp_area = {}
    for r in regions:
        comp_area[r["_c"]["comp"]] = comp_area.get(r["_c"]["comp"], 0) + r["_c"]["npass"]
    if comp_area:
        main_comp = max(comp_area, key=comp_area.get)

    start_cells = {cell_of(sx / ELMOS_PER_SQUARE, sz / ELMOS_PER_SQUARE)
                   for sx, sz in starts}

    heights = [r["_c"]["mean_h"] for r in regions]
    hmed = sorted(heights)[len(heights) // 2] if heights else 0.0

    for r in regions:
        c = r["_c"]
        tags = []
        pass_frac = c["npass"] / c["n"]
        water_frac = c["water"] / c["n"]
        if r["_cell"] in start_cells:
            tags.append("home")
        if c["comp"] != main_comp:
            tags.append("island")
        if water_frac > 0.5:
            tags.append("water")
        elif c["mean_h"] > hmed * 1.25:
            tags.append("highland")
        else:
            tags.append("plain")
        if pass_frac >= 0.55:
            tags.append("buildzone")
        # A region reachable only through one narrow opening is a chokepoint —
        # the AI's directive layer weights these, and they are the whole reason
        # adjacency is measured rather than assumed.
        crossings = r.get("_cross", {})
        if crossings and (len(r["neighbors"]) <= 2 or
                          max(crossings.values()) < 0.15 * max(c["x1"] - c["x0"],
                                                               c["z1"] - c["z0"])):
            tags.append("chokepoint")
        r["tags"] = tags
        # Value: traversable area, lifted for home ground and central positions.
        v = 0.6 + 0.8 * pass_frac
        if "home" in tags:
            v += 0.4
        if "chokepoint" in tags:
            v += 0.2
        if "island" in tags:
            v -= 0.3
        r["value"] = round(max(0.1, v), 3)

    return regions, cols, rows, cw, ch


def map_extent(W: int, H: int) -> tuple[int, int]:
    """The map's size in elmos, which is NOT the sample count times 8.

    The heightmap has (mapx + 1) x (mapy + 1) samples — one per grid CORNER —
    while the map itself is mapx * mapy squares, i.e. `(W - 1) * 8` elmos wide.
    Emitting a polygon vertex at sample index W therefore overshoots the map by
    exactly one square.

    That overshoot is not cosmetic. regions/partition.lua rejects any region
    with a vertex outside the map (`pt.x > mapWidth`), and game_regions.lua's
    response to a failed validation is to fall back to the fixed 2048-elmo
    grid — silently, as far as anything downstream can tell. So every graph
    this tool wrote was being discarded by the sim, and every named region key
    (which is what scenarios and the AI's slate address) resolved to nothing.
    Measured on scorched_crossing_v2.4: vertices at 7176 against a 7168-elmo
    map, "7 regions out of bounds", provider = grid.
    """
    return (W - 1) * ELMOS_PER_SQUARE, (H - 1) * ELMOS_PER_SQUARE


def _poly_elmos(c, W: int, H: int):
    """A cell's rectangle in elmos, clamped to the map (see `map_extent`)."""
    mw, mh = map_extent(W, H)
    x0, x1 = min(c["x0"] * ELMOS_PER_SQUARE, mw), min(c["x1"] * ELMOS_PER_SQUARE, mw)
    z0, z1 = min(c["z0"] * ELMOS_PER_SQUARE, mh), min(c["z1"] * ELMOS_PER_SQUARE, mh)
    return x0, x1, z0, z1


def to_lua(regions, W, H):
    """Emit `mapdata/regions.lua` — the AUTHORED source, not the export.

    This is the file that actually drives everything. `game_regions.lua` picks
    its partition provider by testing `VFS.FileExists("mapdata/regions.lua")`
    and `MapProcessor.cpp` re-exports `regions.json` from it on every map
    reprocess, stamping `provider = "graph"` only when this file is present and
    valid. Writing regions.json alone therefore does nothing for the sim and is
    silently reverted the next time the map is processed.
    """
    out = [
        "-- mapdata/regions.lua — GENERATED by tools/mapgen/regions_from_map.py",
        "-- Derived from the map's own heightmap: an entry in `neighbors` means",
        "-- the reference movement class can physically drive between the two",
        "-- regions. Do not hand-edit; regenerate.",
        "",
        "return {",
        "    version = 1,",
        "    regions = {",
    ]
    for r in regions:
        c = r["_c"]
        x0, x1, z0, z1 = _poly_elmos(c, W, H)
        poly = ", ".join(f"{{x={x}, z={z}}}" for x, z in
                         ((x0, z0), (x1, z0), (x1, z1), (x0, z1)))
        tags = ", ".join(f'"{t}"' for t in r["tags"])
        nbrs = ", ".join(f'"{n}"' for n in sorted(r["neighbors"]))
        out += [
            "        {",
            f'            key = "{r["key"]}",',
            f'            name = "{r["name"]}",',
            f"            polygon = {{ {poly} }},",
            f"            value = {r['value']},",
            f"            tags = {{ {tags} }},",
            f"            neighbors = {{ {nbrs} }},",
            "        },",
        ]
    out += ["    },", "}", ""]
    return "\n".join(out)


def to_json(regions, W, H, cw, ch, provider="graph"):
    out_regions = []
    for r in regions:
        c = r["_c"]
        x0, x1, z0, z1 = _poly_elmos(c, W, H)
        out_regions.append({
            "key": r["key"],
            "name": r["name"],
            "neighbors": sorted(r["neighbors"]),
            "polygon": [
                {"x": float(x0), "z": float(z0)},
                {"x": float(x1), "z": float(z0)},
                {"x": float(x1), "z": float(z1)},
                {"x": float(x0), "z": float(z1)},
            ],
            "tags": r["tags"],
            "value": r["value"],
        })
    return {
        "mapWidth": float((W - 1) * ELMOS_PER_SQUARE),
        "mapHeight": float((H - 1) * ELMOS_PER_SQUARE),
        "provider": provider,
        "regions": out_regions,
    }


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------

def _nearest_passable_component(ok, comp, W, H, sx, sz, radius=64):
    """Component id of the passable sample nearest a world position, or -1.

    Start positions are placed by the map author on ground the *engine* accepts,
    which is not always a sample our grading calls passable (a start pad can sit
    one sample from a cliff edge), so search outward a little rather than
    reading a single sample.
    """
    cx = max(0, min(W - 1, int(round(sx / ELMOS_PER_SQUARE))))
    cz = max(0, min(H - 1, int(round(sz / ELMOS_PER_SQUARE))))
    for r in range(radius):
        for dz in range(-r, r + 1):
            z = cz + dz
            if not (0 <= z < H):
                continue
            span = r - abs(dz)
            for dx in (-span, span) if span else (0,):
                x = cx + dx
                if 0 <= x < W and ok[z * W + x]:
                    return comp[z * W + x]
    return -1


def verify_starts(ok, comp, W, H, starts, intent=reach.DEFAULT_INTENT):
    """Can every start position physically reach every other — and was that the plan?

    Checked against the passability MASK, not against the emitted region graph.
    That distinction is the whole point: regions are coarse rectangles, and a
    single rectangle routinely contains several disconnected components, so a
    graph walk will happily route two armies "through" a cell they each only
    touch a different pocket of. Verifying on the graph reported Meridian Basin
    as fine — the exact map whose start positions provably cannot meet.

    The MEASUREMENT is unchanged; the VERDICT is now the map's to make. Split
    and island maps are legal player content (PLAN-maps.md §2k), so the pass/
    fail comes from `terragen.reachability.verdict` against what the map's own
    `mapinfo.lua` declares — and it fails a stale declaration too, i.e. a map
    that claims a split it does not have.
    """
    ids = {}
    for i, (sx, sz) in enumerate(starts):
        ids[i] = _nearest_passable_component(ok, comp, W, H, sx, sz)
    groups = {}
    stranded = []
    for i, c in ids.items():
        if c < 0:
            stranded.append(i)
        else:
            groups.setdefault(c, []).append(i)
    passed, msg = reach.verdict(intent, groups, stranded)
    return passed, msg, ids


def verify_graph(regions, ids, starts, cw, ch, intent=reach.DEFAULT_INTENT):
    """Secondary check: the emitted graph should not contradict the mask.

    Two claims, and only the first is a gate:

      * every pair of starts the MASK puts in one component must be connected
        by the graph. A graph that drops a route armour really has is a graph
        the AI will not use.
      * no pair of starts the mask puts in DIFFERENT components may be
        connected by the graph. This one is reported, not failed, because every
        shipped generated map violates it today: `build_regions` emits an edge
        only where two cells share passable samples of the same component, but
        a 4x4 grid cell routinely contains several components, so A-B (over
        component 5) chained to B-C (over component 9) reads as a route from A
        to C across two armour realms. That is Meridian Basin's original sin
        reproduced by our own generator, it predates the §2k ruling, and fixing
        it means splitting a region per component rather than per rectangle —
        PLAN-maps.md M-track queue item 2. Until then the count is printed so
        it cannot be mistaken for zero.
    """
    if not regions or len(starts) < 2:
        return True, "graph check skipped", 0
    by_key = {r["key"]: r for r in regions}
    cell_to_key = {r["_cell"]: r["key"] for r in regions}
    keys = []
    for sx, sz in starts:
        cx = int(sx / ELMOS_PER_SQUARE / cw)
        cz = int(sz / ELMOS_PER_SQUARE / ch)
        best, bd = None, None
        for (ex, ez), k in cell_to_key.items():
            d = (ex - cx) ** 2 + (ez - cz) ** 2
            if bd is None or d < bd:
                best, bd = k, d
        keys.append(best)

    def walk(src):
        seen = {src}
        q = deque([src])
        while q:
            k = q.popleft()
            for n in by_key[k]["neighbors"]:
                if n not in seen:
                    seen.add(n)
                    q.append(n)
        return seen

    reach_of = {k: walk(k) for k in set(keys)}
    missing = []
    crossed = []
    for i in range(len(starts)):
        for j in range(i + 1, len(starts)):
            ci, cj = ids.get(i, -1), ids.get(j, -1)
            linked = keys[j] in reach_of[keys[i]]
            if ci < 0 or cj < 0:
                continue                      # stranded: verify_starts owns it
            if ci == cj and not linked:
                missing.append((i, j))
            elif ci != cj and linked:
                crossed.append((i, j))
    if missing:
        return False, (f"graph leaves same-component start pairs unreachable: "
                       f"{missing}"), len(crossed)
    if crossed:
        return True, (f"graph connects all same-component start pairs, but "
                      f"⚠ CLAIMS a route for {len(crossed)} pair(s) the mask "
                      f"puts in different components: {crossed} — a region "
                      f"rectangle spanning two components chains an edge "
                      f"across an armour split (M-track queue item 2)"), len(crossed)
    return True, "graph agrees with the mask on every start pair", 0


# --------------------------------------------------------------------------

# This tool derives a region graph from the heightmap alone, so it invents
# region keys (`amber_hook`, `wither_fen`, ...). A map whose gameplay skeleton
# is AUTHORED — Meridian Basin's 24 named regions come from
# meridian_layout.json via meridian.py — has scenarios, objectives and AI
# slates that reference those authored keys BY NAME. Overwriting such a
# regions.lua silently renames every region, and the damage does not surface
# here: it surfaces at game start, where game_scenario.lua's slate validation
# rejects the scenario, the Scenario Loader removes itself, and the war stages
# no armies, no objectives and no victory condition at all. That is a dead
# match that still looks like a working lobby, and it cost PLAN-endtoend fire
# 16 a full session to trace back to this write. `data/maps/` is gitignored, so
# there is no diff and no git history to notice it in either.
def check_generator_ownership(lua_path, force):
    """Refuse to clobber a regions.lua that a different generator authored."""
    if force or not os.path.exists(lua_path):
        return
    try:
        with open(lua_path, "r", encoding="utf-8") as f:
            head = f.read(400)
    except OSError:
        return
    if "regions_from_map.py" in head:
        return          # ours: regenerating is what this tool is for
    owner = "another generator"
    for line in head.splitlines():
        if "GENERATED by" in line:
            owner = line.split("GENERATED by", 1)[1].strip(" -\t")
            break
    raise SystemExit(
        f"refusing to overwrite {lua_path}\n"
        f"  it was generated by: {owner}\n"
        f"  That generator derives the map's AUTHORED region keys, which\n"
        f"  scenarios/objectives/AI slates reference by name. Overwriting them\n"
        f"  makes every war on this map stage nothing (the scenario fails slate\n"
        f"  validation and the Scenario Loader unloads itself).\n"
        f"  Re-run that generator instead, or pass --force if you really mean it."
    )


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map_dir")
    ap.add_argument("--class", dest="mclass", default=DEFAULT_CLASS,
                    choices=sorted(MOVE_CLASSES))
    ap.add_argument("--target-regions", type=int, default=20)
    ap.add_argument("--starts", default=None,
                    help='override start positions, "x,z;x,z"')
    ap.add_argument("--verify", action="store_true",
                    help="read-only: exit non-zero if start positions cannot "
                         "reach each other. Writes nothing (implies --dry-run)")
    ap.add_argument("--expect", default="auto",
                    choices=("auto",) + reach.INTENTS,
                    help="reachability intent to judge against. 'auto' "
                         "(default) reads the map's own declaration from "
                         "mapinfo.lua and treats an undeclared map as "
                         "'connected'. Naming one here overrides that, for a "
                         "map whose mapinfo we do not author — but a shipped "
                         "map should DECLARE it, because a flag is per-run and "
                         "the sweep in verify_scenario_maps.py has no way to "
                         "pass a different one per map.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="overwrite a regions.lua written by a different "
                         "generator (see check_generator_ownership)")
    args = ap.parse_args(argv)

    # See the module docstring: verifying a map must not change it. Without
    # this, sweeping --verify over every map hands the grid-provider maps a
    # named graph and silently invalidates every grid region key addressing
    # them.
    if args.verify:
        args.dry_run = True

    map_dir = os.path.abspath(args.map_dir.rstrip("/"))
    map_id = os.path.basename(map_dir)
    # Anchor on the MAP dir, not on __file__: the map data is gitignored, so
    # this script is routinely run from a worktree/checkout that has no `data/`
    # of its own while pointing at the real one. Deriving the repo root from
    # __file__ silently found no DB and produced graphs with zero start
    # positions — i.e. it skipped the one check this tool exists to run.
    repo_root = os.path.abspath(os.path.join(map_dir, "..", "..", ".."))

    info = read_mapinfo(map_dir)
    row = read_map_row(map_id, repo_root)
    dims = None
    if row and row[1] and row[2]:
        dims = (int(row[1]) + 1, int(row[2]) + 1)
    hs, W, H = read_heightmap(map_dir, info["minheight"], info["maxheight"], dims)

    if args.starts:
        starts = parse_starts(args.starts)
    elif row:
        starts = parse_starts(row[0] or "")
    else:
        starts = []

    deg, depth = MOVE_CLASSES[args.mclass]
    ok = passable_mask(hs, W, H, deg, depth)
    comp, sizes = components(ok, W, H)
    npass = sum(sizes)

    seed = sum(ord(ch) for ch in map_id)
    regions, cols, rows, cw, ch_ = build_regions(
        hs, ok, comp, W, H, args.target_regions, starts, seed)

    intent = (info["reachability"] if args.expect == "auto" else args.expect)
    passed, msg, ids = verify_starts(ok, comp, W, H, starts, intent)
    gpassed, gmsg, _crossed = verify_graph(regions, ids, starts, cw, ch_, intent)

    frac = 100.0 * npass / (W * H)
    biggest = 100.0 * max(sizes) / npass if npass else 0.0
    print(f"{map_id}: {W}x{H} samples, {args.mclass} passable {frac:.1f}% of map, "
          f"largest component {biggest:.1f}% of passable")
    print(f"  grid {cols}x{rows} -> {len(regions)} regions, "
          f"{sum(len(r['neighbors']) for r in regions) // 2} edges")
    src = "mapinfo" if args.expect == "auto" else "--expect"
    print(f"  intent: reachability = \"{intent}\" (from {src})")
    print(f"  starts: {len(starts)}  terrain: {'PASS' if passed else 'FAIL'} — {msg}")
    print(f"  graph:  {'PASS' if gpassed else 'FAIL'} — {gmsg}")
    passed = passed and gpassed

    doc = to_json(regions, W, H, cw, ch_)
    if not args.dry_run:
        mapdata = os.path.join(map_dir, "mapdata")
        os.makedirs(mapdata, exist_ok=True)
        lua_path = os.path.join(mapdata, "regions.lua")
        check_generator_ownership(lua_path, args.force)
        with open(lua_path, "w", encoding="utf-8") as f:
            f.write(to_lua(regions, W, H))
        # regions.json is MapProcessor's export, not an input — but writing it
        # here too means the graph is live for the AI and the client overlay
        # without waiting for a map reprocess. A reprocess will regenerate it
        # from the .lua above and should produce the same thing.
        out = os.path.join(map_dir, "regions.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)
            f.write("\n")
        print(f"  wrote {lua_path}")
        print(f"  wrote {out} (provider={doc['provider']})")

    if args.verify and not passed:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
