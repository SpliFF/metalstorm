# modelimporter

Content-preprocessing CLI that converts any 3D model file the project
supports into glTF 2.0 binary (`.glb`), and (in a follow-up commit)
will also emit a sibling `<model>.meta.lua` file with engine metadata
the synced sim reads at runtime.

The pipeline is:

```
<input model>
    → Assimp importer (built-in formats + S3O plugin)
        → aiScene
            ├─ Assimp glTF2 exporter → <output>.glb
            └─ metadata extraction  → <output>.meta.lua   (planned)
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
conversion (the map preprocessing pipeline does this via ImageMagick
alongside the modelimporter call).

## Planned: metadata output

Alongside each `<name>.glb` the tool will write a `<name>.meta.lua`
file containing the engine metadata the synced sim needs at runtime:
bounding radius and height, mid-position, aim-position, piece tree,
attachment points. The synced sim reads this file directly and never
opens the `.glb`, so `spring-server` doesn't need to link Assimp.

Game authors can override any field by shipping a hand-written
`<name>.meta.lua` alongside the source model; the modelimporter
will detect authored files via a generator marker and won't clobber
them.

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
