# Model Rendering Pipeline

How 3D models go from game content to pixels in the browser.

## Pipeline Overview

```
Source model (.dae/.s3o/.obj/...)    Game content: objects3d/
        |
        v
  ModelImporter (Assimp)             tools/modelimporter/
        |
        +---> <stem>.glb             glTF 2.0 binary (all geometry + hierarchy)
        +---> <stem>.config.json     Engine metadata (bounds, pieces, attachments)
        |
  GameProcessor                      rts/Server/GameProcessor.cpp
        |
        +---> copies <stem>.<ext>.lua --> <stem>.config.lua
        +---> serves via /api/games/data/<gameId>/models/
        |
  Browser client
        |
        +---> SceneLoader.ImportMeshAsync()     loads glb
        +---> fetch(<stem>.config.lua)          texture refs, metadata
        +---> Texture(<url>)                    loads DDS textures
        +---> thin-instance render per piece    team-colored shader
```

## Model Formats

The `modelimporter` tool converts any Assimp-supported format to glTF 2.0:

| Format | Extension | Notes |
|--------|-----------|-------|
| Spring S3O | `.s3o` | Custom Assimp plugin, reads tex1/tex2 from header |
| COLLADA | `.dae` | ZK's primary format, Z-up (Assimp converts to Y-up) |
| Wavefront OBJ | `.obj` | |
| FBX | `.fbx` | |
| Blender | `.blend` | |
| glTF | `.gltf`, `.glb` | Passed through with post-processing |
| Others | `.3ds`, `.lwo`, `.stl`, `.ply`, `.x`, `.md2/.md3/.md5mesh`, ... | ~48 formats total |

### CLI Usage

```bash
modelimporter [options] <input> <output>

# Options:
#   --texture-ext <ext>   Rewrite texture extensions (e.g. png)
#   --update-meta         Overwrite existing .config.json
#   --no-meta             Skip config file entirely
```

Output extension determines format: `.glb` (binary) or `.gltf` (JSON + .bin).

### Post-Processing Flags

Applied to all imports: `aiProcess_Triangulate`, `aiProcess_JoinIdenticalVertices`, `aiProcess_GenSmoothNormals`, `aiProcess_ImproveCacheLocality`, `aiProcess_RemoveRedundantMaterials`, `aiProcess_FindInvalidData`, `aiProcess_GenUVCoords`, `aiProcess_OptimizeMeshes`.

## Model Metadata (.config.lua / .config.json)

Each model has a sibling metadata file used by the engine sim and the client renderer.

### Ownership Rules

1. If `<stem>.config.lua` exists -- author-owned, modelimporter skips writing
2. If `<stem>.config.json` doesn't exist -- modelimporter writes fresh
3. If `--update-meta` passed -- modelimporter overwrites
4. Otherwise -- existing config preserved

### Legacy Sidecar Files

Spring games use `<model>.<ext>.lua` (e.g. `strikecom.dae.lua`) for per-model metadata. `GameProcessor` copies these to `<stem>.config.lua` in the output directory during conversion. These files contain:

```lua
return {
    tex1 = "strikecom.dds",         -- diffuse texture filename
    tex2 = "strikecom_2.dds",       -- team color mask / detail texture
    invertteamcolor = false,        -- invert the team color mask
    midpos = {0, 30, 0},            -- model origin offset
    radius = 30,                    -- bounding sphere radius
    height = 50,                    -- model height
    pieces = {                      -- piece tree overrides
        Scene = { offset = {0, 31, 0} },
    }
}
```

### Generated Config Format

```json
{
  "configVersion": 1,
  "radius": 35.841,
  "height": 54.483,
  "midpos": [0.554, -2.885, 0.386],
  "mins": [-16.171, -30.127, -8.082],
  "maxs": [17.279, 24.356, 8.854],
  "pieces": [
    { "name": "Base", "parent": 0, "offset": [0, 0, -30],
      "mins": [0, 0, 0], "maxs": [0, 0, 0] },
    { "name": "Turret", "parent": 0, "offset": [0.3, -0.02, 34.8],
      "mins": [-7.4, -7.2, -8.9], "maxs": [7.4, 8.1, 6.3] }
  ],
  "attachments": [
    { "kind": "aim", "name": "aimpos1", "piece": 2 },
    { "kind": "fire", "name": "firepos", "piece": 2 },
    { "kind": "emit", "name": "emit_exhaust", "piece": 0 }
  ]
}
```

### Attachment Point Naming (auto-detected from piece names)

| Prefix | Kind | Purpose |
|--------|------|---------|
| `aim`, `aim_N` | `aim` | Weapon aim positions |
| `fire`, `fire_N` | `fire` | Projectile emission points |
| `emit_<name>` | `emit` | Particle emitters |
| `hp_<name>`, `hpoint_<name>` | `hp` | Generic hardpoints |

## Textures

### Serving

Textures are served as-is from the game content directory. No format conversion -- browsers can handle DDS via Babylon's built-in DDS texture loader.

- Model textures: `/api/games/data/<gameId>/unittextures/<filename>.dds`
- Feature textures: `/api/maps/data/<mapId>/features/<filename>.png`
- Content type: `.dds` = `image/vnd-ms.dds`

### Spring S3O Texture Convention

Spring models use two textures bound by name convention (not embedded in the model file):

**tex1** -- Diffuse / albedo texture. Standard color map.

**tex2** -- Multi-channel detail texture:

| Channel | Purpose | Value Range |
|---------|---------|-------------|
| R | Team color mask | 0.0 = no team color, 1.0 = full team tint |
| G | Reflectivity / specular | Higher = more reflective |
| B | Self-illumination / emissive | Higher = glows without lighting |
| A | Reserved (typically 1.0) | Not used as a mask |

The `invertteamcolor` flag in the model config flips the mask: `mask = 1.0 - tex2.r`.

### Team Color Blending

```glsl
// In the fragment shader:
float mask = tex2.r;
if (invertMask > 0.5) mask = 1.0 - mask;
vec3 color = mix(base.rgb, teamColor * base.rgb, mask);
```

Team color is multiplicative: `teamColor * base.rgb`. This preserves the diffuse texture's shading detail while tinting the color. Areas with mask = 0 keep the original diffuse color.

### Modern Models

Models authored in modern tools (Blender, etc.) can embed textures directly in the glTF. These load automatically via Babylon's glTF loader without any config.lua texture references. Team color for modern models is a future design question -- possible approaches include a dedicated team color mask texture slot or a material naming convention.

## Entity Rendering (Units)

### Per-Piece Thin Instancing

Units use **per-piece thin instancing** -- each body part (chassis, turret, arm, leg) is a separate thin-instance source mesh. This enables:

- **GPU batching**: 1000 tanks = 1 draw call per piece type, not 1000 draws
- **Animation-ready**: Individual pieces can have independent transforms (turret rotation, walk cycles)
- **Correct z-buffer**: Pieces from different units depth-test correctly regardless of draw order

### Loading Pipeline

1. `SceneLoader.ImportMeshAsync()` loads the `.glb`
2. All nodes (meshes + transform nodes) are enumerated
3. World matrices computed while hierarchy is intact
4. Each node becomes a `PieceInfo` with:
   - `mesh`: vertices in piece-local space (null for structural nodes)
   - `name`: piece name from the glb node
   - `parentIndex`: parent piece (-1 for root)
   - `localMatrix`: transform relative to parent
   - `restWorldMatrix`: accumulated world transform (includes axis conversion)
5. Meshes detached from hierarchy, reset to origin
6. `.config.lua` fetched for texture metadata
7. DDS textures loaded and team color material created

### Per-Frame Rendering

Each `tick()`:
1. For each entity, compute entity world matrix from interpolated position + heading
2. For each piece with geometry: `instanceMatrix = pieceRestWorldMatrix * entityWorldMatrix`
3. Group instances by `(defId, team, pieceIdx)` key
4. Set thin-instance matrix buffer on each piece's render mesh
5. Fallback shapes (box/cylinder/cone/sphere) for defs without models

### Team Color Material

A custom GLSL `ShaderMaterial` handles team coloring:

- Vertex shader includes `#include<instancesDeclaration>` and `#include<instancesVertex>` for thin-instance compatibility
- Fragment shader samples tex1 (diffuse) and tex2 (team mask), blends team color
- Per-team material clones share the same textures but differ in the `teamColor` uniform
- 10 default team colors from Spring's `TeamBase::teamDefaultColor`

### Y-Offset

Models are shifted vertically so their base sits at ground level. The offset is computed from the combined bounding boxes of all pieces in their rest pose.

## Feature Rendering (Map Objects)

Map features (trees, rocks, wrecks) use a simpler pipeline:

- **Single-mesh thin instancing**: picks the first mesh with geometry from the glb
- **No piece hierarchy**: features are static, no animation needed
- **No team color**: features don't belong to teams
- **Batch per type**: all instances of the same feature type share one thin-instance mesh
- **Fallback placeholders**: box meshes with type-hashed colors for failed model loads
- **Decal-only features**: intentionally model-less types (metal spots, etc.) are skipped

## Coordinate Systems

| Context | Up Axis | Handedness |
|---------|---------|------------|
| Spring engine (sim) | Y-up | Left-handed |
| S3O models | Y-up | Right-handed |
| COLLADA (.dae) from Blender | Z-up | Right-handed |
| glTF 2.0 spec | Y-up | Right-handed |
| Babylon.js | Y-up | Left-handed |

The glTF Scene root node carries a rotation matrix for axis conversion (e.g. Z-up COLLADA to Y-up glTF). Babylon applies this automatically. The entity renderer preserves it in the rest-pose world matrices for each piece.

## HTTP Endpoints

| Endpoint | Content |
|----------|---------|
| `/api/games/data/<gameId>/models/<stem>.glb` | Model geometry |
| `/api/games/data/<gameId>/models/<stem>.config.lua` | Model metadata (textures, bounds, pieces) |
| `/api/games/data/<gameId>/models/<stem>.config.json` | Auto-generated metadata (fallback) |
| `/api/games/data/<gameId>/unittextures/<name>.dds` | Unit textures |
| `/api/maps/data/<mapId>/features/<name>.glb` | Map feature models |
| `/api/maps/data/<mapId>/features/<name>.png` | Map feature textures |

## Key Files

| File | Purpose |
|------|---------|
| `tools/modelimporter/main.cpp` | Model format converter (Assimp to glTF) |
| `tools/modelimporter/S3OImporter.cpp` | Spring S3O format Assimp plugin |
| `tools/modelimporter/JsonWriter.cpp` | Extracts engine metadata to .config.json |
| `rts/Server/GameProcessor.cpp` | Discovers + converts models during game loading |
| `rts/Sim/Objects/ModelConfigLoader.cpp` | Loads .config.lua/.config.json on server |
| `client/src/core/entity-renderer.ts` | Per-piece thin-instanced unit rendering |
| `client/src/core/feature-renderer.ts` | Thin-instanced map feature rendering |
| `schemas/protocol.fbs` | FlatBuffer protocol (GameUnitDef, MapFeatureDef) |
