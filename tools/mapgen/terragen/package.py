"""Map package assembly: source-map directory layout for MapProcessor.

Emits:
  maps/<id>.smf + <id>.smt      (smf.py; tiles clustered via dxt1.py)
  maps/splat_distr.png          RGBA layer weights   (mapinfo resources)
  maps/splat_detail.png         RGBA 4x greyscale detail layers
  mapinfo.lua                   name/water/atmosphere/splats/teams/terrainTypes
  mapdata/regions.lua           (optional; caller-provided emitter output)
  mapconfig/featureplacer/config.lua + features/*.lua   (optional vegetation)
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from . import bake as bk
from . import dxt1, smf


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
    # ⚠ These ship at 1.0 — today's real behaviour — and that is deliberate.
    # Until roads R1 the emitter wrote FLAT `tankspeed = 1.35` keys while
    # `CMapInfo::ReadTerrainTypes` (rts/Map/MapInfo.cpp) reads a NESTED
    # `moveSpeeds` subtable with no flat fallback, so the 1.35 every terragen
    # map has shipped was parsed by nobody and roads have never been faster
    # than open ground in this port. R1 fixed the STRUCTURE (and pinned it in
    # tests/test_road_surface.py); it did not turn the multiplier on, because
    # waking a five-year-dead multiplier is a gameplay change and this lane's
    # contract proves speed claims with measured transit times — that is R3.
    # Do NOT read the old 1.35 as a tuned value: it was never observed doing
    # anything, so it carries no evidence. Tune from a fresh baseline.
    bitumen_type_speed: float = 1.0
    dirt_type_speed: float = 1.0
    mud_type_speed: float = 1.0
    voidwater: bool = False
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
    return f"""-- mapinfo.lua — GENERATED by tools/mapgen (terragen). Do not hand-edit.
local mapinfo = {{
    name = "{cfg.display_name}",
    shortname = "{cfg.map_id}",
    description = "{cfg.description}",
    author = "{cfg.author}",
    version = "1",
    mapfile = "maps/{cfg.map_id}.smf",
    legacycoordsystem = false,

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
        splatdistrtex = "splat_distr.png",
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
