"""Map package assembly: source-map directory layout for MapProcessor.

Emits:
  maps/<id>.smf + <id>.smt      (smf.py; tiles clustered via dxt1.py)
  maps/ground.png               map-space ground albedo (optional; M7f opt A)
  maps/splat_distr.png          RGBA layer weights   (mapinfo resources)
  maps/splat_detail.png         RGBA 4x greyscale detail layers
  mapinfo.lua                   name/water/atmosphere/splats/teams/terrainTypes
  mapdata/regions.lua           (optional; caller-provided emitter output)
  mapdata/roads.lua             (optional; emit_roads_lua — the road graph, R2)
  mapconfig/featureplacer/config.lua + features/*.lua   (optional vegetation)
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from . import bake as bk
from . import dxt1, reachability, smf


@dataclass
class MapPackageConfig:
    map_id: str
    display_name: str
    description: str = ""
    author: str = "terragen"
    min_height: float = -120.0
    max_height: float = 1500.0
    water_level: float = 0.0          # world Y of water plane (SMF assumes 0)
    tile_budget: int = 12288
    # Map-space ground albedo (PLAN-maps M7f option A / §2n ruling 1): edge
    # size in texels, 0 = do not ship one and leave the client on the SMT tile
    # dictionary. OPT-IN PER MAP, and that is part of the ruling rather than an
    # implementation detail — a real Spring map ships an exactly-deduped SMT
    # that this path would degrade, so nothing is retrofitted.
    ground_texture_size: int = 0
    metal_value: int = 0              # uniform metalmap value (games may ignore)
    start_positions: list[tuple[float, float]] = field(default_factory=list)
    splat_tex_scales: tuple = (0.006, 0.02, 0.009, 0.0022)
    splat_tex_mults: tuple = (0.25, 0.35, 0.22, 0.22)
    # water surface look (mapinfo water block). Defaults suit maps where
    # water is an accent (fords, lakes); sea-dominated maps want a brighter,
    # more opaque surface so the ocean reads at strategic zoom.
    water_surface_color: tuple = (0.35, 0.42, 0.50)
    water_surface_alpha: float = 0.45
    water_base_color: tuple = (0.28, 0.36, 0.43)
    # terrainTypes move-speed multipliers, one per road surface class.
    #
    # R3 (2026-08-15) turned these on, MEASURED. R1 fixed the STRUCTURE (the
    # emitter used to write FLAT `tankspeed` keys while
    # `CMapInfo::ReadTerrainTypes` reads a NESTED `moveSpeeds` subtable with no
    # flat fallback) and left the values at 1.0 pending a transit measurement.
    # Every number below is one, taken headless on meridian_basin's own deck
    # with one VEH squad over a 512-elmo gated straight, off-deck control in
    # the same run (PLAN-maps §2e):
    #
    #   class / multiplier   frames   elmos/frame   vs open ground
    #   open ground   1.00     236       2.170        —
    #   mud           0.85     204       2.510        (unit LEAVES the deck)
    #   dirt          1.25     172       2.977        +37 %
    #   bitumen       1.35     160       3.200        +47 %
    #   bitumen       1.60     139       3.684        +70 %
    #
    # Bitumen ships at 1.60 rather than the legacy 1.35 because routing is what
    # the directive asks for and only 1.60 delivers it: over six A/B pairs whose
    # deck route is a measured detour, mean deck adherence went 29.3 % (1.00) →
    # 45.2 % (1.25) → 43.1 % (1.35) → 58.7 % (1.60) and mean transit −0 % →
    # −5.4 % → −2.7 % → −14.6 %. Do NOT read the pre-R1 1.35 as a tuned value:
    # it was parsed by nobody, so it carries no evidence.
    #
    # Mud ships at 1.0 (no bonus, no penalty) although 0.85 was measured and
    # works: at 0.85 the unit steers OFF the muddy deck (25 % on-deck over the
    # straight), and mud sits in the deck's wet dips — next to water — so a
    # repelling class pushes convoys off a graded surface toward the lake edge
    # it was built to cross. "A wet road is no better than open ground" is the
    # claim the measurement supports without that side effect.
    bitumen_type_speed: float = 1.60
    dirt_type_speed: float = 1.25
    mud_type_speed: float = 1.00
    voidwater: bool = False
    # Does armour reach every start from every other, and is that the
    # plan? `terragen.reachability` owns the vocabulary and the gate it
    # feeds (`regions_from_map.py --verify`); see PLAN-maps.md §2k. A
    # generator that says nothing declares "connected", which is the
    # strict reading — silence is not consent.
    reachability: str = reachability.DEFAULT_INTENT
    seed: int = 1


def write_package(
    out_dir: str,
    cfg: MapPackageConfig,
    height: np.ndarray,
    slope_deg: np.ndarray,
    biome_ids: np.ndarray,
    moisture: np.ndarray,
    road_dist: np.ndarray,
    road_mask: np.ndarray,
    cellsize: float,
    scratch_dir: str,
    regions_lua: str | None = None,
    roads_lua: str | None = None,                 # package.emit_roads_lua (roads R2)
    feature_files: dict[str, str] | None = None,  # relpath -> content
    stamps: dict[str, np.ndarray] | None = None,  # placement.py ground stamps
    road_class: np.ndarray | None = None,         # roads.rasterize_roads_classified
    progress=print,
) -> None:
    maps_dir = os.path.join(out_dir, "maps")
    os.makedirs(maps_dir, exist_ok=True)

    baker = bk.AlbedoBaker(
        height, slope_deg, biome_ids, moisture, road_dist,
        cfg.water_level, cellsize, cfg.seed, stamps=stamps,
        road_class=road_class,
    )

    progress("baking albedo tiles (1 texel/elmo)...")
    tiles, tiles_x, tiles_z = bk.bake_tiles(
        baker, os.path.join(scratch_dir, f"{cfg.map_id}_tiles.npy")
    )

    progress(f"clustering {tiles.shape[0]} tiles -> budget {cfg.tile_budget}...")
    assignments, reps = dxt1.cluster_tiles(np.asarray(tiles), cfg.tile_budget, seed=cfg.seed)
    tile_index = assignments.reshape(tiles_z, tiles_x)
    progress(f"  unique tiles: {reps.shape[0]}")

    # The tile dictionary is a lossy stand-in for Spring's exact dedup, so it
    # reports its own damage on every build rather than shipping silently
    # (see dxt1.cluster_tiles FIDELITY-STANDIN / PLAN-maps.md M7 item 1).
    sd = dxt1.seam_discontinuity(tiles, tile_index, reps, seed=cfg.seed)
    progress(
        f"  FIDELITY-STANDIN lossy tile dedup: seam jump {sd['jump']:.2f} vs "
        f"interior gradient {sd['grad']:.2f} (ratio {sd['ratio']:.1f}; the "
        f"unquantized bake is {sd['true_ratio']:.2f}) — a ratio well above 1 is "
        f"a visible 32-elmo grid on smooth ground"
    )

    # Map-space ground albedo, box-downsampled from the SAME full-resolution
    # bake the tile dictionary above was clustered from — the two delivery
    # paths therefore carry the same pixels (PLAN-maps §2n ruling 1). The SMT
    # is still written: it is the SMF's own format, the sim reads the file, and
    # a client that never learns about `ground.png` still renders the map.
    if cfg.ground_texture_size > 0:
        progress(f"ground albedo {cfg.ground_texture_size}^2 (map-space, "
                 f"{baker.map_w / cfg.ground_texture_size:.0f} elmos/texel)...")
        Image.fromarray(bk.ground_texture_from_tiles(
            tiles, tiles_x, tiles_z, cfg.ground_texture_size)).save(
                os.path.join(maps_dir, "ground.png"))

    progress("minimap...")
    shade = bk.hillshade(height, cellsize)
    minimap = bk.make_minimap(baker, shade)

    # typemap: 0 = default, 1/2/3 = bitumen/dirt/mud (terragen.roads.SURF_*).
    # A caller with no class raster still gets the pre-R1 0/1 map, whose
    # entry [1] is now named "bitumen" rather than "road" — same value, same
    # hardness class, so an old package's typemap keeps meaning what it meant.
    gh, gw = height.shape
    half_w, half_h = (gw - 1) // 2, (gh - 1) // 2
    ri = np.clip((np.arange(half_h) * 2 + 1), 0, gh - 1)
    ci = np.clip((np.arange(half_w) * 2 + 1), 0, gw - 1)
    src = road_mask if road_class is None else road_class
    typemap = (src[np.ix_(ri, ci)]).astype(np.uint8)

    # R3: a SUBMERGED deck cell is not road, it is a ford. Two reasons, one of
    # them a live defect:
    #   * realism — you do not get a road's speed bonus while driving through
    #     the water crossing it;
    #   * Metalstorm's `gamedata/moveinfo.tdf` declares SHIP/SUB with
    #     `speedmodclass = 1`, which is the engine's KBot slot
    #     (MoveDefHandler.h SpeedModClass), so a boat reads `kbotSpeed` off
    #     whatever terrain type is under it. Skerry Reach ships 930 submerged
    #     deck cells and Sundered Arc 2 162, so without this a boat sailing
    #     over a ford would take the ROAD multiplier. Fixing the mis-declared
    #     move classes is a separate gameplay call (PLAN-maps §2e.1); zeroing
    #     the class here is correct on its own terms either way.
    typemap[height[np.ix_(ri, ci)] <= cfg.water_level] = 0

    metalmap = np.full((half_h, half_w), cfg.metal_value, dtype=np.uint8)

    progress("writing SMF/SMT...")
    smf.write_smf_smt(
        os.path.join(maps_dir, f"{cfg.map_id}.smf"),
        os.path.join(maps_dir, f"{cfg.map_id}.smt"),
        f"{cfg.map_id}.smt",
        height, cfg.min_height, cfg.max_height,
        tile_index, reps, typemap, metalmap, minimap,
    )

    progress("splat textures...")
    Image.fromarray(bk.make_splat_distr(biome_ids, slope_deg, height, cfg.water_level,
                                        stamps=stamps, road_class=road_class)).save(
        os.path.join(maps_dir, "splat_distr.png")
    )
    Image.fromarray(bk.make_splat_detail(cfg.seed)).save(
        os.path.join(maps_dir, "splat_detail.png")
    )

    with open(os.path.join(out_dir, "mapinfo.lua"), "w") as f:
        f.write(emit_mapinfo(cfg))

    if regions_lua is not None:
        os.makedirs(os.path.join(out_dir, "mapdata"), exist_ok=True)
        with open(os.path.join(out_dir, "mapdata", "regions.lua"), "w") as f:
            f.write(regions_lua)

    if roads_lua is not None:
        os.makedirs(os.path.join(out_dir, "mapdata"), exist_ok=True)
        with open(os.path.join(out_dir, "mapdata", "roads.lua"), "w") as f:
            f.write(roads_lua)

    for rel, content in (feature_files or {}).items():
        p = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(content)

    progress("package written: " + out_dir)


def emit_mapinfo(cfg: MapPackageConfig) -> str:
    teams = "\n".join(
        f"        [{i}] = {{ startPos = {{ x = {int(x)}, z = {int(z)} }} }},"
        for i, (x, z) in enumerate(cfg.start_positions)
    )
    s = cfg.splat_tex_scales
    m = cfg.splat_tex_mults
    reach_block = reachability.emit_mapinfo_block(cfg.reachability)
    # DEVIATION (recorded, not silent): `groundtex` is NOT a Recoil mapinfo
    # key. Recoil delivers the ground albedo only through the SMF's tile
    # dictionary; this key names the map-space replacement M7f measured and
    # §2n ruled in, and a map that omits it keeps the Spring-faithful path.
    # MapProcessor.cpp reads it from `resources` beside the splat textures.
    ground_res = ('        groundtex = "ground.png",   -- DEVIATION: map-space '
                  'ground albedo (PLAN-maps §2n)\n'
                  if cfg.ground_texture_size > 0 else "")
    return f"""-- mapinfo.lua — GENERATED by tools/mapgen (terragen). Do not hand-edit.
local mapinfo = {{
    name = "{cfg.display_name}",
    shortname = "{cfg.map_id}",
    description = "{cfg.description}",
    author = "{cfg.author}",
    version = "1",
    mapfile = "maps/{cfg.map_id}.smf",
    legacycoordsystem = false,

{reach_block}
    maxmetal = 0.5,
    extractorradius = 90,

    smf = {{
        minheight = {cfg.min_height},
        maxheight = {cfg.max_height},
    }},

    water = {{
        damage = 0,
        voidwater = {str(cfg.voidwater).lower()},
        surfacecolor = {{ {cfg.water_surface_color[0]}, {cfg.water_surface_color[1]}, {cfg.water_surface_color[2]} }},
        surfacealpha = {cfg.water_surface_alpha},
        basecolor = {{ {cfg.water_base_color[0]}, {cfg.water_base_color[1]}, {cfg.water_base_color[2]} }},
        mincolor = {{ 0.05, 0.08, 0.11 }},
        absorb = {{ 0.006, 0.004, 0.002 }},
    }},

    atmosphere = {{
        fogcolor = {{ 0.72, 0.76, 0.80 }},
        skycolor = {{ 0.45, 0.60, 0.79 }},
        suncolor = {{ 1.0, 0.98, 0.92 }},
    }},

    lighting = {{
        groundambientcolor = {{ 0.42, 0.42, 0.44 }},
        grounddiffusecolor = {{ 0.92, 0.90, 0.85 }},
        groundspecularcolor = {{ 0.08, 0.08, 0.08 }},
    }},

    resources = {{
{ground_res}        splatdistrtex = "splat_distr.png",
        splatdetailtex = "splat_detail.png",
    }},

    splats = {{
        texscales = {{ {s[0]}, {s[1]}, {s[2]}, {s[3]} }},
        texmults = {{ {m[0]}, {m[1]}, {m[2]}, {m[3]} }},
    }},

    -- typemap values are terragen.roads.SURF_*: 1 bitumen, 2 dirt, 3 mud.
    -- movespeeds is a NESTED subtable because that is where
    -- CMapInfo::ReadTerrainTypes looks, and it has no flat fallback.
    -- receivetracks turns the engine's dynamic tyre-track decals on per
    -- surface: soft ground records a passing unit, sealed bitumen does not.
    terraintypes = {{
        [0] = {{
            name = "default",
            hardness = 1.0,
            receiveTracks = true,
            moveSpeeds = {{ tank = 1.0, kbot = 1.0, hover = 1.0, ship = 1.0 }},
        }},
        [1] = {{
            name = "bitumen",
            hardness = 1.4,
            receiveTracks = false,
            moveSpeeds = {{ tank = {cfg.bitumen_type_speed}, kbot = {cfg.bitumen_type_speed},
                            hover = {cfg.bitumen_type_speed}, ship = 1.0 }},
        }},
        [2] = {{
            name = "dirt",
            hardness = 1.2,
            receiveTracks = true,
            moveSpeeds = {{ tank = {cfg.dirt_type_speed}, kbot = {cfg.dirt_type_speed},
                            hover = {cfg.dirt_type_speed}, ship = 1.0 }},
        }},
        [3] = {{
            name = "mud",
            hardness = 0.8,
            receiveTracks = true,
            moveSpeeds = {{ tank = {cfg.mud_type_speed}, kbot = {cfg.mud_type_speed},
                            hover = {cfg.mud_type_speed}, ship = 1.0 }},
        }},
    }},

    teams = {{
{teams}
    }},
}}
return mapinfo
"""


# ---------------------------------------------------------------------------
# Feature-def filtering (PLAN-maps M8o)
# ---------------------------------------------------------------------------

def filter_defs_lua(text: str, names) -> str:
    """Keep only the `vegetation_defs.lua` blocks for `names`.

    A climate palette references a subset of the shared def file, and a map
    package should ship defs for the props it actually places: an unused
    `featureDef` naming a `.gltf` the package does not contain is a broken
    reference waiting for someone to place it. Filtering also keeps the
    identity property M8n bought — with every name kept the output is the
    input, byte for byte, so a regenerated temperate map does not move.

    Comment groups are carried with the blocks that follow them and dropped
    when all of those blocks are dropped, so a filtered file never ends up
    with a section heading over nothing.
    """
    keep = set(names)
    lines = text.split("\n")
    out: list[str] = []

    i = 0
    while i < len(lines):
        out.append(lines[i])
        opened = lines[i].startswith("return lowerkeys({")
        i += 1
        if opened:
            break
    else:
        raise ValueError("defs lua has no `return lowerkeys({` line")

    groups: list[tuple[list[str], list[tuple[str, list[str]]]]] = []
    lead: list[str] = []
    defs: list[tuple[str, list[str]]] = []
    while i < len(lines) and lines[i].strip() != "})":
        m = re.match(r"^\t(\w+) = \{$", lines[i])
        if m:
            blk = [lines[i]]
            i += 1
            while i < len(lines):
                blk.append(lines[i])
                done = lines[i] == "\t},"
                i += 1
                if done:
                    break
            while i < len(lines) and lines[i].strip() == "":
                blk.append(lines[i])
                i += 1
            defs.append((m.group(1), blk))
            continue
        if lines[i].lstrip().startswith("--") and defs:
            groups.append((lead, defs))     # a comment starts a new group
            lead, defs = [], []
        lead.append(lines[i])
        i += 1
    groups.append((lead, defs))

    for lead, defs in groups:
        kept = [blk for name, blk in defs if name in keep]
        if not kept and defs:
            continue                        # heading over nothing: drop it
        out.extend(lead)
        for blk in kept:
            out.extend(blk)
    out.extend(lines[i:])
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Road graph export (roads R2) — the town-planner seam
# ---------------------------------------------------------------------------

def emit_roads_lua(net, cellsize: float, params=None, decimate: float = 64.0,
                   crossings=None, yards=None, refusals=None,
                   p_cross=None) -> str:
    """The planned road network as map data, for consumers downstream of the bake.

    **Why this file exists, and what it does not solve.** R2's brief asks for a
    town-planner seam: "T1 street exits are network endpoints — towns plug into
    the road graph". That cannot happen inside one pipeline, and the reason is
    structural rather than a missing feature: `tools/mapgen/town_planner.py`
    runs inside **scenariogen**, against a map that has already been generated,
    packaged, baked and typemapped, while the road network is planned at
    **generation** time and is baked irreversibly into the albedo, the splat
    distribution and the SMF typemap. A town discovered afterwards cannot move
    a road, and a road cannot be routed to a town that does not exist yet.

    What can be honoured is the other direction, which is the useful one: the
    generator publishes its road graph so a later stage can plug a town into a
    real road instead of guessing where one is. Today the town planner has only
    a heightmap (`SiteProbe`), so a town's main street meets a highway by
    coincidence or not at all. With this file it can read the deck, its class
    and its width, and put its street exits on one.

    Emitted in WORLD coordinates (x, z), the same frame `regions.lua` uses.
    Polylines are decimated to one vertex per `decimate` world units — the
    consumer wants a route, not the smoother's vertex count.

    `crossings` (roads R3b, `terragen.bridges.find_crossings`) rides in the same
    file for the same reason: where the deck goes under water is a fact about
    the road, the scenario stager is the only thing that can lay a level span
    over it (see terragen/bridges.py), and a map that publishes its roads but
    not its fords makes that stager guess.

    `refusals` is the other half of the same call and rides here as the `fords`
    block (roads R3d): a wet run that carries no chain is still a wet run, and
    a map that publishes only the bridgeable ones tells a consumer that the
    rest of its water is not on a road. `p_cross` is the `CrossingParams` the
    survey used, so the wade depth every ford row is graded against is the one
    that graded it rather than a default re-guessed here.

    `yards` (roads R4b, `terragen.yards.plan_yard_pads`) is the third of the
    same shape and the one that closes the seam this docstring opens: a pad is
    prepared ground that only the generator can bake and only the scenario can
    build on, so the map says where the tarmac is and the scenario stands its
    depot on it instead of carving a parcel out of a field.
    """
    from . import roads as rd
    from . import bridges as br
    from . import yards as yd

    p = params or rd.RoadParams()
    lines = ["-- roads.lua — GENERATED by tools/mapgen (terragen). Do not hand-edit.",
             "-- Road network as planned, in world (x, z). classes: "
             + ", ".join(f"{k}={v}" for k, v in sorted(rd.ROAD_CLASS_NAMES.items())),
             "return {",
             "    links = {"]
    for ln in net.links:
        pts = rd.resample_by_arclength(ln.polyline, decimate)
        if len(pts) < 2:
            pts = ln.polyline[[0, -1]]
        verts = ", ".join(f"{{{p[0]:.0f}, {p[1]:.0f}}}" for p in pts)
        lines.append(
            f"        {{ class = {ln.road_class}, "
            f"name = \"{rd.ROAD_CLASS_NAMES[ln.road_class]}\", "
            f"width = {rd.class_width(ln.road_class, p):.0f}, "
            f"a = {ln.a}, b = {ln.b}, points = {{ {verts} }} }},")
    lines.append("    },")
    lines.append("    junctions = {")
    for (x, z) in net.junctions:
        lines.append(f"        {{ x = {x:.0f}, z = {z:.0f} }},")
    lines.append("    },")
    # Roadside yard pads (R4b). Always emitted, even empty, for the reason the
    # next block gives. Ordered BEFORE that block on purpose: every reader in
    # scenariogen bounds its own regex by finding the name of the block after
    # its own, so the file's block order is part of those readers' contract.
    lines.append("    -- Yard pads: prepared ground beside a link — graded flat,")
    lines.append("    -- surfaced with the road's own class and baked into the")
    lines.append("    -- albedo, splat and typemap. `heading` is the Spring")
    lines.append("    -- heading of the AWAY normal (carriageway -> pad), which")
    lines.append("    -- is what fixes the side of the road the pad is on. A pad")
    lines.append("    -- carries no building: it is terrain, and an empty one is")
    lines.append("    -- a rest stop. See tools/mapgen/terragen/yards.py.")
    lines.append("    yards = {")
    lines.extend(yd.emit_yards_lua(yards or []))
    lines.append("    },")
    # Water crossings (R3b). Always emitted, even empty: a map with no crossings
    # and a map generated before this key existed must not read the same to a
    # consumer deciding whether to look for bridges elsewhere.
    lines.append("    -- Bridge crossings: stretches of deck under water that are")
    lines.append("    -- narrow enough for a chain of spans. `heading` is the road's")
    lines.append("    -- own tangent in Spring heading units; the chain is CENTRED on")
    lines.append("    -- (x, z). The span is non-blocking decoration and the ford")
    lines.append("    -- under it is what units cross — terragen/bridges.py.")
    lines.append("    crossings = {")
    lines.extend(br.emit_crossings_lua(crossings or []))
    lines.append("    },")
    # Fords (R3d). The SUPERSET of `crossings` and the one a unit cares about:
    # where the deck goes through water at all, bridged or not. Emitted last so
    # `read_road_crossings` can keep bounding itself at the next block's name.
    lines.append("    -- Fords: every stretch of deck a ground unit has to wade,")
    lines.append("    -- including the ones under a bridge (spans > 0) and the ones")
    lines.append("    -- too wide for any legal chain (spans = 0). `depth` is the")
    lines.append("    -- deepest point and `wade` the depth it was graded against —")
    lines.append("    -- a run deeper than the wade is a BROKEN ROUTE and is not")
    lines.append("    -- here at all. See tools/mapgen/terragen/bridges.py.")
    lines.append("    fords = {")
    lines.extend(br.emit_fords_lua(crossings or [], refusals or [],
                                   wade_depth=(p_cross or br.CrossingParams()).wade_depth))
    lines.append("    },")
    lines.append("}")
    return "\n".join(lines) + "\n"
