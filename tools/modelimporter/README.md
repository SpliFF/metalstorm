# modelimporter

Content-preprocessing CLI that converts any 3D model file the project
supports into glTF 2.0 binary (`.glb`) and emits a sibling
`<output>.meta.lua` file with the engine metadata the synced sim reads
at runtime.

The pipeline is:

```
<input model>
    → Assimp importer (built-in formats + S3O plugin)
        → aiScene
            ├─ Assimp glTF2 exporter → <output>.glb
            └─ MetaLuaWriter         → <output>.meta.lua
                                       ↑
                                       authored <input>.meta.lua
                                       (optional, merged on top)
```

The set of accepted inputs is whatever the linked Assimp build
supports (OBJ, FBX, COLLADA/DAE, BLEND, 3DS, LWO, STL, PLY,
glTF/glTF2, X, MD2/MD3/MD5, and the rest of Assimp's ~48 formats)
plus extra importer plugins registered at runtime by this tool.

## Plugins

This tool currently registers one extra importer at runtime via
`Assimp::Importer::RegisterLoader()`:

- **S3O** (`*.s3o`) — Spring RTS unit/feature model format. Implemented
  in [`S3OImporter.cpp`](S3OImporter.cpp). The plugin is written against
  upstream Assimp's `BaseImporter` API and is structured to be droppable
  into `assimp/code/AssetLib/S3O/` for upstreaming.

## Usage

```
modelimporter [options] <input> <output>
```

Options:

| Option | Description |
|---|---|
| `--texture-ext <ext>` | Rewrite every referenced texture filename's extension to `<ext>` (e.g. `png`, `webp`). Used by the content pipeline to swap legacy `.tga` references for converted `.png` files. |
| `--no-meta` | Skip writing the sibling `<output>.meta.lua`. Only useful if the caller manages metadata out-of-band. |

The output format is selected from the output extension:

- `.gltf` → `gltf2` exporter (JSON + external `.bin` and textures)
- `.glb`  → `glb2` exporter (single binary file with embedded buffer)

Example:

```
modelimporter GreyRock1.s3o GreyRock1.glb
modelimporter --texture-ext png tank.fbx data/games/papertanks/models/tank.glb
```

Texture files referenced by the model (e.g. `GreyRock1.tga` for an S3O)
are rewritten to the new extension in the exported glTF but **not
converted** — the caller is responsible for running the actual image
conversion (the map and game preprocessing pipelines do this via
ImageMagick alongside the modelimporter call; see
[`rts/Server/FeatureProcessor.cpp`](../../rts/Server/FeatureProcessor.cpp)
and [`rts/Server/GameProcessor.cpp`](../../rts/Server/GameProcessor.cpp)).

## `.meta.lua` — engine metadata sidecar

The synced sim never opens the `.glb`. Everything it needs at runtime
lives in a sibling `<output>.meta.lua` written by
[`MetaLuaWriter`](MetaLuaWriter.cpp) from the same `aiScene` the glTF
export consumed. Keeping the metadata in a plain text Lua file means
`spring-server` doesn't link Assimp and authors can hand-edit any
field without touching the binary.

### Schema

```lua
local meta = {
    -- Bounding sphere and AABB in model-local coordinates.
    radius = 50.131,
    height = 56.492,
    midpos = {x, y, z},
    mins   = {x, y, z},
    maxs   = {x, y, z},

    -- Piece tree flattened in pre-order. `parent` is a 0-based index
    -- into this same list; -1 marks the root. Each piece's `offset`
    -- is the local translation of its node transform; `mins`/`maxs`
    -- are the AABB of the piece's own meshes (children are separate
    -- entries). The synthetic Assimp scene-root wrapper is skipped
    -- when it's meshless, single-child, and identity-transformed, so
    -- the piece list matches what game authors actually modelled.
    pieces = {
        { name = "base",    parent = -1, offset = {...}, mins = {...}, maxs = {...} },
        { name = "turret",  parent = 0,  offset = {...}, mins = {...}, maxs = {...} },
        { name = "barrel",  parent = 1,  offset = {...}, mins = {...}, maxs = {...} },
        -- ...
    },

    -- Optional — only emitted if the source model has pieces whose
    -- names match Spring's attachment-point naming conventions.
    attachments = {
        { kind = "aim",  name = "aimpos1", piece = 2 },
        { kind = "fire", name = "firepos", piece = 2 },
        { kind = "emit", name = "emit_exhaust", piece = 0 },
        { kind = "hp",   name = "hp_antenna",   piece = 1 },
    },
}

return meta
```

Recognised attachment-point prefixes (case-insensitive):

| Prefix | Kind | Typical use |
|---|---|---|
| `aim`, `aim_<N>` | `aim`  | Weapon aim positions |
| `fire`, `fire_<N>` | `fire` | Projectile emission points |
| `emit_<name>` | `emit` | Particle emitters |
| `hp_<name>`, `hpoint_<name>` | `hp` | Generic hardpoints |

### Authored overrides

If the source directory contains a hand-written override file next
to the model — same stem, `.meta.lua` extension (e.g. `my_tank.meta.lua`
beside `my_tank.s3o`) — its contents are appended verbatim to the
generated output after the `local meta = { ... }` block. The idiom is
to mutate `meta` field-by-field, which lets you override anything the
extractor got wrong without losing the rest of the auto-generated data:

```lua
-- my_tank.meta.lua  (authored, next to my_tank.s3o)
meta.radius = 45
meta.height = 22
meta.attachments = meta.attachments or {}
table.insert(meta.attachments,
    { kind = "fire", name = "firepos_alt", piece = 5 })
```

When the importer runs next, the generated output `.meta.lua` will
look like:

```lua
-- Generated by modelimporter. ...
local meta = {
    radius = 50.131,   -- extracted from the mesh
    -- ...
}

-- ---- authored overrides (from my_tank.meta.lua) ----
meta.radius = 45
meta.height = 22
-- ...

return meta
```

so the authored values always win because they come second. The
importer re-reads the authored source on every run, so you never
need to manually regenerate the output after editing it.

Note: the generated output file is rewritten unconditionally on
every run. If you want to ship a fully hand-written file with no
auto-generated block at all, pass `--no-meta` to the importer and
drop your own `.meta.lua` into place next to the `.glb`.

### Consumption

On the sim side, [`MetaLuaModelLoader`](../../rts/Sim/Objects/MetaLuaModelLoader.cpp)
reads the file via Spring's `LuaParser` and populates an `S3DModel`
stub with `radius`, `height`, `relMidPos`, `mins`, `maxs`, and the
piece tree. Parent/child links are wired up in a second pass after
all pieces have been copied so pointers don't dangle across vector
reallocations.

`SolidObjectDef::LoadModel` calls into the loader lazily the first
time a unit or feature def is instantiated, searching for the meta
file via the content-root chain (`objects3d/`, `features/`, bare
lookup). If nothing is found the def spawns with default bounds
(`radius = 1`, `height = 1`) and a one-line warning on stderr — the
simulation keeps running so you can iterate on missing assets without
restarting the server.

## Building

This tool is built as part of the top-level project CMake build:

```
cmake --preset debug
ninja -C build/debug modelimporter
```

Modern Assimp (v6.0.4) is fetched via `FetchContent` with all
importers enabled by default (minus the non-free C4D and M3D
formats). See [`CMakeLists.txt`](CMakeLists.txt) for the exact
configuration.
