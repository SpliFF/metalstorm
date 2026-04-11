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
                                       (only if the file does not
                                        already exist, or if
                                        --update-meta is passed)
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
| `--update-meta` | Overwrite the output `<output>.meta.lua` even if it already exists. Without this flag, an existing meta file is left untouched — once on disk, the meta file belongs to the author. |
| `--no-meta` | Skip touching the sibling `<output>.meta.lua` entirely. Only useful if the caller manages metadata out-of-band. |

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
    -- Schema version. Engine-side reader branches on this. Bumped
    -- when the file format changes in a backwards-incompatible way.
    metaVersion = 1,

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

### `metaVersion`

Every generated file carries a `metaVersion` integer at the top of
the table. The engine-side loader
([`MetaLuaModelLoader`](../../rts/Sim/Objects/MetaLuaModelLoader.cpp))
compares it against the version it was built against:

- **missing** — the file predates the versioned schema; a warning
  suggests running `modelimporter --update-meta` to regenerate.
- **older than the engine's version** — a warning is logged and
  version-specific workarounds run (none yet; v1 is the baseline).
- **newer than the engine's version** — warning about ignored
  fields, but the sim continues with best-effort parsing.

Bump `kCurrentMetaVersion` in
[`MetaLuaWriter.h`](MetaLuaWriter.h) and `kSupportedMetaVersion` in
[`MetaLuaModelLoader.cpp`](../../rts/Sim/Objects/MetaLuaModelLoader.cpp)
in the same commit whenever the generated schema changes.

### Ownership and `--update-meta`

The modelimporter treats the meta file as **author-owned once it
exists on disk**. There is no merging, no override layering, no
authored-vs-generated distinction inside the file. The rule is:

| Current state | `--update-meta` | Action |
|---|---|---|
| meta file does not exist | *(ignored)* | write a fresh extraction |
| meta file exists | not passed | leave the file alone, log `[kept existing]` |
| meta file exists | passed | overwrite with a fresh extraction, log `[updated]` |

This means the standard workflow for hand-editing is:

1. Run `modelimporter tank.s3o tank.glb` once — fresh meta file is
   written with everything the extractor could figure out.
2. Edit `tank.meta.lua` directly (override the radius, add a custom
   attachment point, swap in a hand-written piece tree, whatever).
3. Subsequent `modelimporter tank.s3o tank.glb` runs — the meta file
   is preserved verbatim; only the `.glb` is regenerated from the
   source.
4. If the source model is updated in a way that invalidates your
   edits (new pieces, rescaled geometry), re-run with
   `modelimporter --update-meta tank.s3o tank.glb` to blow away the
   old file and start over from the extractor's output.

The automated content pipelines
([`FeatureProcessor`](../../rts/Server/FeatureProcessor.cpp) for map
features, [`GameProcessor`](../../rts/Server/GameProcessor.cpp) for
game unit/feature models) deliberately **do not** pass
`--update-meta`. Once a meta file has been generated for a given
model, they preserve it across runs even if the source `.s3o`
changes, so hand-edits aren't silently lost by a rebuild. Pass
`--update-meta` manually when you want to refresh.

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
