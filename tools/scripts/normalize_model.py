"""normalize_model.py — Blender-CLI normalisation pipeline (PLAN-metalstorm-
beta-units.md §6 / task 4). One script every sourced-or-generated asset goes
through, so the hybrid Option A/B pipeline stays coherent (one source of
truth, not per-asset hand-tweaking).

Targets Blender 4.x (LTS). Run headless:

    blender --background --python tools/scripts/normalize_model.py -- \\
        --input <source.fbx|.obj|.dae|.gltf|.glb> \\
        --output data/games/metalstorm/objects3d/ms_tanks_s2.glb \\
        --dominant-dim length --target-metres 8.5 \\
        --tri-budget 2000 \\
        [--rename-map rename.json] \\
        [--palette-image /tmp/atlas_palette.png] \\
        [--clip-map clips.json]

`.blend` sources can't be "imported" the way FBX/OBJ/glTF can (Blender has
no generic "import a whole foreign .blend as a scene" operator short of
library-append, which requires knowing which datablocks to pull in advance).
For a `.blend` source, open it directly as Blender's startup file instead
and omit --input:

    blender source.blend --background --python tools/scripts/normalize_model.py -- \\
        --output data/games/metalstorm/objects3d/ms_tanks_s2.glb ...

Pipeline steps (§6), each a function below so the validation harness
(tools/scripts/validate_model.mjs) can be pointed at intermediate output:

  1. import (or use the already-open .blend scene)
  2. RH orient        — delegated to Blender's own glTF exporter (Y-up,
                         RH, CCW winding is glTF's export default — Blender's
                         importers already normalise FBX/OBJ/DAE's varying
                         source axes into Blender's own Z-up RH scene space,
                         so there is no custom axis math here: reuse the
                         tool's own correct behaviour rather than reinventing
                         axis conversion by hand).
  3. real-world scale  — uniform scale so the model's dominant dimension
                         (length/wingspan/height, per art/STYLE.md's
                         class-scale table) matches --target-metres.
  4. apply transforms  — bake scale/rotation into the mesh so the exported
                         glTF node has a clean identity transform.
  5. rename pieces/bones — art/STYLE.md piece-naming convention, from
                         --rename-map (old name -> turret/barrel/tracks/
                         muzzle/exhaust/etc; §2).
  6. palette re-texture — every material's base colour is remapped to the
                         nearest swatch in the shared palette atlas
                         (art/STYLE.md), UVs rewritten to sample that
                         swatch's cell in the shared atlas image.
  7. decimate to budget — art/STYLE.md tri budgets (800 infantry / 2000
                         vehicle / 8000 scale-4).
  8. clip cleanup      — keep only actions named in --clip-map, renamed to
                         walk/idle/death.
  9. export .glb

The engine-metadata step (piece tree / AABB / bounding sphere, embedded via
the `SPRINGRTS_geometry` glTF extension) is NOT done here — it's
`tools/modelimporter`'s job, run as a separate pass on this script's output
(see validate_model.mjs's engine-load-smoke step, which does exactly that).
`ModelConfigLoader` (rts/Sim/Objects/ModelConfigLoader.h) reads geometry
metadata straight off the `.glb`; there is no separate per-model sidecar
file to hand-author (some older docs call this a `.meta.lua` sidecar — that
convention was retired when `SPRINGRTS_geometry` landed).
"""
import sys
import json
import math

try:
    import bpy
    import bmesh
    import mathutils
except ImportError:
    bpy = None  # allow --help / argument-parsing unit tests outside Blender


def parse_args(argv):
    if '--' in argv:
        argv = argv[argv.index('--') + 1:]
    else:
        argv = []

    import argparse
    p = argparse.ArgumentParser(prog='normalize_model.py')
    p.add_argument('--input', help='source model file (omit if the .blend was opened directly)')
    p.add_argument('--output', required=True, help='output .glb path')
    p.add_argument('--dominant-dim', choices=['length', 'wingspan', 'height'], required=True,
                    help='which bounding-box axis art/STYLE.md\'s class-scale table sizes')
    p.add_argument('--target-metres', type=float, required=True,
                    help='real-world size for --dominant-dim, from art/STYLE.md')
    p.add_argument('--tri-budget', type=int, required=True,
                    help='max triangles after decimation, from art/STYLE.md')
    p.add_argument('--rename-map', help='JSON file: {"old object/bone name": "new name"}')
    p.add_argument('--palette-image', help='path to the palette atlas source PNG (art/STYLE.md)')
    p.add_argument('--palette-grid', default='4x4', help='COLSxROWS swatch grid (default 4x4, matches make_palette_atlas.py)')
    p.add_argument('--clip-map', help='JSON file: {"walk": "OrigActionName", "idle": "...", "death": "..."}')
    return p.parse_args(argv)


def reset_scene_if_importing(do_import):
    """Clear to an empty scene UNLESS the caller opened a .blend directly
    (bpy.data already has the source scene loaded — resetting would throw
    away the very thing we're normalising)."""
    if do_import:
        bpy.ops.wm.read_factory_settings(use_empty=True)


def import_source(path):
    ext = path.lower().rsplit('.', 1)[-1]
    if ext == 'fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == 'obj':
        bpy.ops.wm.obj_import(filepath=path)
    elif ext in ('dae',):
        bpy.ops.wm.collada_import(filepath=path)
    elif ext in ('gltf', 'glb'):
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        raise ValueError(
            f'unsupported --input extension ".{ext}" — for .blend sources, '
            f'open the file directly instead of using --input (see docstring)')


def cleanup_non_geometry():
    """Source packs routinely ship cameras/lights for their own preview
    renders — strip them, we only want mesh + armature."""
    for obj in list(bpy.data.objects):
        if obj.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(obj, do_unlink=True)


def mesh_and_armature_objects():
    return [o for o in bpy.data.objects if o.type in ('MESH', 'ARMATURE')]


def compute_dominant_dimension(dim_kind):
    """Combined bounding box across all mesh objects, in Blender's own
    (post-import, Z-up) space. 'length'/'wingspan' take the larger of the
    two horizontal extents (source rigs don't reliably share a canonical
    forward axis); 'height' takes the vertical extent."""
    minv = mathutils.Vector((math.inf, math.inf, math.inf))
    maxv = mathutils.Vector((-math.inf, -math.inf, -math.inf))
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ mathutils.Vector(corner)
            minv.x, minv.y, minv.z = min(minv.x, world.x), min(minv.y, world.y), min(minv.z, world.z)
            maxv.x, maxv.y, maxv.z = max(maxv.x, world.x), max(maxv.y, world.y), max(maxv.z, world.z)
    extent = maxv - minv
    if dim_kind == 'height':
        return extent.z
    return max(extent.x, extent.y)


def apply_real_world_scale(dim_kind, target_metres):
    current = compute_dominant_dimension(dim_kind)
    if current <= 1e-6:
        raise ValueError('model has zero/degenerate bounding box — check the import')
    factor = target_metres / current
    roots = [o for o in bpy.data.objects if o.parent is None]
    bpy.ops.object.select_all(action='DESELECT')
    for o in roots:
        o.select_set(True)
    bpy.context.view_layer.objects.active = roots[0] if roots else None
    bpy.ops.transform.resize(value=(factor, factor, factor))
    print(f'[normalize] scaled by {factor:.4f} ({current:.3f}m -> {target_metres:.3f}m on {dim_kind})')
    return factor


def apply_transforms():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def rename_pieces(rename_map_path):
    if not rename_map_path:
        return
    with open(rename_map_path) as f:
        rename_map = json.load(f)
    renamed = 0
    for obj in bpy.data.objects:
        if obj.name in rename_map:
            obj.name = rename_map[obj.name]
            renamed += 1
        if obj.type == 'ARMATURE':
            for bone in obj.data.bones:
                if bone.name in rename_map:
                    bone.name = rename_map[bone.name]
                    renamed += 1
    print(f'[normalize] renamed {renamed} piece(s)/bone(s) per {rename_map_path}')


# ── palette re-texture ──────────────────────────────────────────────────

def _parse_grid(grid_str):
    cols, rows = grid_str.lower().split('x')
    return int(cols), int(rows)


def _average_material_color(mat):
    """Best-effort average base colour for one material: the Principled
    BSDF's Base Color input if it's an unconnected solid value, or a
    strided pixel-average of its connected image texture (every 17th
    texel — enough samples for a stable average on any reasonably-sized
    source texture without walking every pixel)."""
    if mat is None or mat.node_tree is None:
        return (0.6, 0.6, 0.6)
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        return (0.6, 0.6, 0.6)
    base_input = bsdf.inputs.get('Base Color')
    if base_input is None:
        return (0.6, 0.6, 0.6)
    if not base_input.is_linked:
        c = base_input.default_value
        return (c[0], c[1], c[2])
    src = base_input.links[0].from_node
    if src.type == 'TEX_IMAGE' and src.image is not None:
        img = src.image
        px = img.pixels[:]  # flat RGBA floats
        channels = img.channels or 4
        n_texels = len(px) // channels
        if n_texels == 0:
            return (0.6, 0.6, 0.6)
        stride = max(1, n_texels // 2000)  # ~2000 samples max
        r = g = b = 0.0
        count = 0
        for i in range(0, n_texels, stride):
            off = i * channels
            r += px[off]; g += px[off + 1]; b += px[off + 2]
            count += 1
        return (r / count, g / count, b / count)
    return (0.6, 0.6, 0.6)


def _nearest_swatch(color, palette_hexes, cols, rows):
    """palette_hexes is a flat list, row-major, len == cols*rows, of
    '#RRGGBB' strings (must match make_palette_atlas.py's SWATCHES)."""
    best_idx, best_dist = 0, math.inf
    for idx, hexcol in enumerate(palette_hexes):
        hexcol = hexcol.lstrip('#')
        pr, pg, pb = (int(hexcol[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
        d = (color[0] - pr) ** 2 + (color[1] - pg) ** 2 + (color[2] - pb) ** 2
        if d < best_dist:
            best_dist, best_idx = d, idx
    row, col = divmod(best_idx, cols)
    return row, col


# Must match tools/scripts/make_palette_atlas.py's SWATCHES exactly
# (row-major, 4 cols x 4 rows).
PALETTE_SWATCHES = [
    'B8BEC4', '8A9096', '4E5257', '33363A',
    'C9A24B', 'F2C230', '6B6F73', '8B4A2B',
    '6FA8D8', '2FE0D0', 'E8763A', 'F5F0DC',
    '9C9A93', '5B6068', 'C6B393', '2B2B2C',
]


def palette_retexture(palette_image_path, grid_str):
    if not palette_image_path:
        print('[normalize] --palette-image not given, skipping re-texture')
        return
    cols, rows = _parse_grid(grid_str)
    atlas_img = bpy.data.images.load(palette_image_path, check_existing=True)

    remapped = 0
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        if not mesh.uv_layers:
            mesh.uv_layers.new(name='UVMap')
        uv_layer = mesh.uv_layers.active.data

        # One shared-atlas material per matched swatch, reused across
        # objects/materials that land on the same swatch.
        new_slot_for_old = {}
        for slot_idx, mat in enumerate(mesh.materials):
            avg = _average_material_color(mat)
            row, col = _nearest_swatch(avg, PALETTE_SWATCHES, cols, rows)
            swatch_name = f'ms_palette_{row}_{col}'
            new_mat = bpy.data.materials.get(swatch_name)
            if new_mat is None:
                new_mat = bpy.data.materials.new(swatch_name)
                new_mat.use_nodes = True
                bsdf = next(n for n in new_mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
                tex_node = new_mat.node_tree.nodes.new('ShaderNodeTexImage')
                tex_node.image = atlas_img
                tex_node.interpolation = 'Closest'  # flat swatches — no bleed
                new_mat.node_tree.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
            new_slot_for_old[slot_idx] = (new_mat, row, col)
            mesh.materials[slot_idx] = new_mat
            remapped += 1

        # Remap every face's UVs into its matched swatch's cell (centre-
        # biased so filtering/mipmaps never bleed into a neighbour cell).
        cell_w, cell_h = 1.0 / cols, 1.0 / rows
        margin = 0.15  # fraction of the cell kept clear of the edge
        for poly in mesh.polygons:
            _, row, col = new_slot_for_old.get(poly.material_index, (None, 0, 0))
            u0, v0 = col * cell_w, 1.0 - (row + 1) * cell_h  # UV v is bottom-up
            for li in poly.loop_indices:
                # Squash existing UVs into the margin-inset cell rather than
                # a single point, so any existing per-face gradient/AO bake
                # the source mesh had still varies slightly (cheap fake AO).
                orig = uv_layer[li].uv
                u = u0 + cell_w * (margin + (1 - 2 * margin) * (orig.x % 1.0))
                v = v0 + cell_h * (margin + (1 - 2 * margin) * (orig.y % 1.0))
                uv_layer[li].uv = (u, v)

    print(f'[normalize] palette re-texture: {remapped} material slot(s) remapped onto the shared atlas')


# ── decimate ─────────────────────────────────────────────────────────────

def total_tri_count():
    total = 0
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        total += len(bm.faces)
        bm.free()
    return total


def decimate_to_budget(tri_budget):
    current = total_tri_count()
    if current <= tri_budget:
        print(f'[normalize] {current} tris already within budget ({tri_budget})')
        return
    ratio = max(0.05, tri_budget / current)
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mod = obj.modifiers.new('ms_decimate', 'DECIMATE')
        mod.ratio = ratio
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    after = total_tri_count()
    print(f'[normalize] decimated {current} -> {after} tris (target {tri_budget}, ratio {ratio:.3f})')
    if after > tri_budget:
        print(f'[normalize] WARNING: still over budget after one decimate pass '
              f'({after} > {tri_budget}) — validate_model.mjs will flag this; '
              f'consider a lower --tri-budget input or manual retopology')


# ── clip cleanup ─────────────────────────────────────────────────────────

def cleanup_clips(clip_map_path):
    if not clip_map_path:
        for action in list(bpy.data.actions):
            bpy.data.actions.remove(action)
        print('[normalize] no --clip-map given, removed all actions')
        return
    with open(clip_map_path) as f:
        clip_map = json.load(f)  # {"walk": "OrigWalk", ...}
    keep_old_names = set(clip_map.values())
    kept = 0
    for action in list(bpy.data.actions):
        if action.name in keep_old_names:
            new_name = next(k for k, v in clip_map.items() if v == action.name)
            action.name = new_name
            kept += 1
        else:
            bpy.data.actions.remove(action)
    print(f'[normalize] kept {kept}/{len(clip_map)} requested clip(s): {sorted(clip_map.keys())}')


# ── export ───────────────────────────────────────────────────────────────

def export_glb(output_path):
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        export_yup=True,           # glTF's Y-up RH convention (docs/coordinate-system.md)
        export_apply=True,         # bake remaining modifiers
        export_animations=True,
        export_force_sampling=False,
        export_optimize_animation_size=True,
    )
    print(f'[normalize] exported {output_path}')


def main():
    args = parse_args(sys.argv)
    reset_scene_if_importing(args.input is not None)
    if args.input:
        import_source(args.input)
    cleanup_non_geometry()
    if not mesh_and_armature_objects():
        raise RuntimeError('no mesh/armature objects found after import — check --input/the opened .blend')

    apply_real_world_scale(args.dominant_dim, args.target_metres)
    apply_transforms()
    rename_pieces(args.rename_map)
    palette_retexture(args.palette_image, args.palette_grid)
    decimate_to_budget(args.tri_budget)
    cleanup_clips(args.clip_map)
    export_glb(args.output)


if __name__ == '__main__':
    if bpy is None:
        print('normalize_model.py must run inside Blender: '
              'blender --background --python normalize_model.py -- --help')
        sys.exit(1)
    main()
