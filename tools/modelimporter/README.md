# modelimporter

Content-preprocessing CLI that converts any 3D model file the project
supports into glTF 2.0 binary (`.glb`) and emits a sibling
`<stem>.config.json` file with the engine metadata the synced sim
reads at runtime.

The pipeline is:

```
<input model>
    → Assimp importer (built-in formats + S3O plugin)
        → aiScene
            ├─ Assimp glTF2 exporter → <output>.glb
            └─ JsonWriter            → <stem>.config.json
                                       (skipped if <stem>.config.lua
                                        exists; also skipped if the
                                        .config.json already exists
                                        and --update-meta wasn't
                                        passed)
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
| `--update-meta` | Overwrite the output `<stem>.config.json` even if it already exists. Has no effect when a `<stem>.config.lua` is present — that always wins. |
| `--no-meta` | Skip touching the sibling config file entirely. Only useful if the caller manages metadata out-of-band. |

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

## `.config.json` / `.config.lua` — engine metadata sidecar

The synced sim never opens the `.glb`. Everything it needs at runtime
lives in a sibling config file that follows the project-wide
`.config.json` / `.config.lua` convention implemented by
[`LuaConfig::Load`](../../rts/Lua/LuaConfigLoader.h):

- **`<stem>.config.json`** — canonical, machine-readable form.
  Modelimporter writes this by default; third-party tools, data
  editors, and non-Lua pipelines can produce or consume it too.
- **`<stem>.config.lua`** — optional authoring form. If present it
  wins over any adjacent `.config.json`. Use it when you need
  dynamic behaviour: string templates, math, loading other files,
  or decoding the JSON form and layering edits on top via the
  `json` global that LuaParser installs in every state.

Modelimporter itself only writes JSON. It never reads or writes
the `.lua` form — if one already exists on disk, the importer
treats the model's metadata as fully author-owned and skips the
meta write entirely.

### Schema (`configVersion = 1`)

JSON form as emitted by modelimporter:

```json
{
  "configVersion": 1,

  "radius": 50.131,
  "height": 56.492,
  "midpos": [mx, my, mz],
  "mins":   [x1, y1, z1],
  "maxs":   [x2, y2, z2],

  "pieces": [
    { "name": "base",   "parent": -1, "offset": [...], "mins": [...], "maxs": [...] },
    { "name": "turret", "parent":  0, "offset": [...], "mins": [...], "maxs": [...] },
    { "name": "barrel", "parent":  1, "offset": [...], "mins": [...], "maxs": [...] }
  ],

  "attachments": [
    { "kind": "aim",  "name": "aimpos1",     "piece": 2 },
    { "kind": "fire", "name": "firepos",     "piece": 2 },
    { "kind": "emit", "name": "emit_exhaust","piece": 0 },
    { "kind": "hp",   "name": "hp_antenna",  "piece": 1 }
  ]
}
```

The equivalent Lua form (for hand-authored `.config.lua`) is the
same table with Lua syntax; piece arrays become Lua sequences indexed
from 1, `parent` is still 0-based (with `-1` for the root), and
`configVersion` is still required:

```lua
return {
  configVersion = 1,

  radius = 50.131,
  height = 56.492,
  midpos = { mx, my, mz },
  mins   = { x1, y1, z1 },
  maxs   = { x2, y2, z2 },

  pieces = {
    { name = "base",   parent = -1, offset = {...}, mins = {...}, maxs = {...} },
    { name = "turret", parent =  0, offset = {...}, mins = {...}, maxs = {...} },
  },

  attachments = {
    { kind = "aim", name = "aimpos1", piece = 2 },
  },
}
```

Field meanings:

- **`radius`** — bounding sphere around the model origin.
- **`height`** — max-Y minus min-Y of the AABB.
- **`midpos`** — AABB centre, used as the default aim target.
- **`mins` / `maxs`** — full model-space AABB.
- **`pieces`** — piece tree flattened in pre-order. Each piece's
  `offset` is the local translation of its node transform;
  `mins`/`maxs` are the AABB of that piece's own meshes only
  (descendants become separate entries). The synthetic Assimp
  scene-root wrapper is skipped when it's meshless, single-child,
  and identity-transformed, so the piece list matches what game
  authors actually modelled.
- **`attachments`** — optional; emitted only if the source model
  has pieces whose names match Spring's attachment-point naming
  conventions.

Recognised attachment-point prefixes (case-insensitive):

| Prefix | Kind | Typical use |
|---|---|---|
| `aim`, `aim_<N>` | `aim`  | Weapon aim positions |
| `fire`, `fire_<N>` | `fire` | Projectile emission points |
| `emit_<name>` | `emit` | Particle emitters |
| `hp_<name>`, `hpoint_<name>` | `hp` | Generic hardpoints |

### `configVersion`

Every config file must carry a `configVersion` integer. The engine-side
loader ([`ModelConfigLoader`](../../rts/Sim/Objects/ModelConfigLoader.cpp))
compares it against the version it was built against:

- **missing** — the file predates the versioned schema; a warning
  suggests running `modelimporter --update-meta` to regenerate.
- **older than the engine's version** — a warning is logged and
  version-specific workarounds run (none yet; v1 is the baseline).
- **newer than the engine's version** — warning about ignored
  fields, but the sim continues with best-effort parsing.

Bump `kCurrentConfigVersion` in
[`JsonWriter.h`](JsonWriter.h) and `kSupportedConfigVersion` in
[`ModelConfigLoader.cpp`](../../rts/Sim/Objects/ModelConfigLoader.cpp)
in the same commit whenever the generated schema changes.

For one release the loader also accepts the legacy `metaVersion`
field as a synonym, so existing `data/` caches from the pre-rename
build keep loading until the next rebuild pass refreshes them.

### Ownership rules

The modelimporter treats both config forms as **author-owned**.
The priority order is:

| `.config.lua` | `.config.json` | `--update-meta` | Action |
|---|---|---|---|
| present   | *(ignored)* | *(ignored)* | log `[author-owned .config.lua, skipped]`, write nothing |
| absent    | absent      | *(ignored)* | write a fresh `.config.json`, log `[fresh]` |
| absent    | present     | not passed  | keep `.config.json`, log `[kept existing]` |
| absent    | present     | passed      | overwrite `.config.json`, log `[updated]` |

So the standard workflow for hand-editing is one of:

1. **Pure JSON workflow.** Run `modelimporter tank.s3o tank.glb` once
   to get a fresh `tank.config.json`, edit that file in place, re-run
   modelimporter whenever the source model changes (the `.glb` will
   regenerate but your `.config.json` will be preserved). Re-run with
   `--update-meta` when you want to start over from the extractor's
   output.

2. **Lua takeover.** Write your own `tank.config.lua` next to
   `tank.glb` in the output directory. The importer sees it and
   leaves all metadata alone on every subsequent run. Use this
   when you want dynamic behaviour — for example starting from the
   extractor's JSON defaults and layering edits on top:
   ```lua
   -- tank.config.lua
   local defaults = json.decode(VFS.LoadFile("tank.config.json"))
   defaults.radius = 60
   defaults.attachments = defaults.attachments or {}
   table.insert(defaults.attachments,
       { kind = "fire", name = "firepos_alt", piece = 5 })
   return defaults
   ```
   The `json` global is registered by every LuaParser state, so any
   authored `.config.lua` has access to `json.decode` / `json.encode`
   out of the box.

The automated content pipelines
([`FeatureProcessor`](../../rts/Server/FeatureProcessor.cpp) for map
features, [`GameProcessor`](../../rts/Server/GameProcessor.cpp) for
game unit/feature models) deliberately **do not** pass
`--update-meta`. Once a config file has been generated for a given
model, they preserve it across runs even if the source changes, so
hand-edits aren't silently lost by a rebuild. Pass `--update-meta`
manually when you want to refresh.

### Consumption

On the sim side, [`ModelConfigLoader`](../../rts/Sim/Objects/ModelConfigLoader.cpp)
dispatches through `LuaConfig::Load`, which tries
`<stem>.config.lua` first and falls back to `<stem>.config.json` via
the vendored [json-lua library](../../rts/lib/lua/json-lua/json.lua).
Both forms end up as a `LuaTable` so the reader code stays in the
existing Spring field-read API. Parent/child links in the piece
tree are wired up in a second pass after all pieces have been copied
so pointers don't dangle across vector reallocations.

`SolidObjectDef::LoadModel` calls into the loader lazily the first
time a unit or feature def is instantiated, searching for the
config file via the content-root chain (`objects3d/`, `features/`,
bare lookup). If nothing is found the def spawns with default
bounds (`radius = 1`, `height = 1`) and a one-line warning on
stderr — the simulation keeps running so you can iterate on
missing assets without restarting the server.

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
