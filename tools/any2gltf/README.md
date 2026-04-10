# any2gltf

Standalone CLI that converts any model file Assimp can read into glTF 2.0
(text `.gltf` or binary `.glb`).

The pipeline is:

```
<input model> → Assimp importer → Assimp glTF2 exporter → <output>
```

The set of accepted inputs is whatever the linked Assimp build supports
(OBJ, FBX, COLLADA, BLEND, 3DS, LWO, …) plus extra importer plugins
registered at runtime by this tool.

## Plugins

This tool currently registers one extra importer at runtime via
`Assimp::Importer::RegisterLoader()`:

- **S3O** (`*.s3o`) — Spring RTS unit/feature model format. Implemented
  in [`S3OImporter.cpp`](S3OImporter.cpp). The plugin is written against
  upstream Assimp's `BaseImporter` API and is structured to be droppable
  into `assimp/code/AssetLib/S3O/` for upstreaming.

## Usage

```
any2gltf <input> <output>
```

The output format is selected from the output extension:

- `.gltf` → `gltf2` exporter (JSON + external `.bin` and textures)
- `.glb`  → `glb2` exporter (single binary file with embedded buffer)

Example:

```
any2gltf GreyRock1.s3o GreyRock1.glb
```

Texture files referenced by the model (e.g. `GreyRock1.tga` for an S3O)
are emitted as relative URIs in the output. Converting those texture
files into web-friendly PNG/WebP is the caller's responsibility — this
tool only touches geometry/material metadata, not texture pixel data.

## Building

This tool is built as part of the top-level project CMake build:

```
cmake -B build -GNinja
ninja -C build any2gltf
```

Modern Assimp (v6.0.4) is fetched via `FetchContent` with a stripped-down
configuration: only the importers actually needed for our content
pipeline are compiled in (see [`CMakeLists.txt`](CMakeLists.txt)).
