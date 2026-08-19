# Importing Assets

How content authors bring 3D models (units, features, props) into Spring RTS Web, what gets transformed on the way in, and which sidecar flags control the transforms.

All asset processing happens **offline at conversion time** (during `make build-content` / `gameconverter`). The browser client and the headless game server only consume the pre-baked outputs — `.gltf`, `.bin`, `.ktx2`. Nothing in this document changes runtime behaviour or requires the game to be restarted to take effect; rebuild content, restart the lobby, done.

The companion document [`docs/rendering-models.md`](rendering-models.md) describes how the *runtime* loads and renders these outputs. Read that one if you want to know about thin instances, the team-colour material plugin, or KTX2 transcoding on the GPU.

## Directory layout (per game)

```
content/games/<gameId>/
    objects3d/                 source models (.s3o, .dae, .glb, .fbx, .obj, ...)
        noruas.s3o
        noruas.s3o.lua         optional sidecar — overrides + flags
    unittextures/              source textures (.dds, .tga, .png)
        3do2s3o_atlas_1.tga
        noruas_normals.dds
    ...
```

After running `gameconverter content/games/<gameId>`:

```
data/games/<gameId>/
    models/
        noruas.gltf            spec-compliant glTF 2.0
        noruas.bin             mesh attribute buffers
        3do2s3o_atlas_1_diffuse.ktx2
        3do2s3o_atlas_1_team.ktx2
        3do2s3o_atlas_2_emissive.ktx2
        3do2s3o_atlas_2_orm.ktx2
        noruas_normals.ktx2
    ...
```

The `.gltf` is the **complete record** for the asset — geometry, materials, texture references, and a `SPRINGRTS_geometry` document-level extension carrying every piece of simulation metadata (bounds, midpos, piece tree, attachment points). The `.config.json` and `.config.lua` sidecars that earlier schema versions wrote no longer exist; everything lives in the `.gltf`.

## Source formats and per-format defaults

The modelimporter handles every format Assimp recognises (S3O, DAE, FBX, OBJ, glTF, 3DS, BLEND, ...). UV-V handling is **decided per material**, not per source-model format, because Spring's runtime loader silently used different conventions depending on whether the material's tex1 was a DDS or a TGA/PNG/JPG (see *Per-material V-flip* below). The defaults below describe the `fliptextures` value that combines with the tex1 extension to drive the per-material decision.

| Input format | `fliptextures` default | `invertteamcolor` default | Coord convention assumed |
|---|---|---|---|
| `.s3o` | `false` | `false` | Spring LH, Y-up |
| `.gltf` / `.glb` | `false` | `false` | glTF 2.0 RH, Y-up |
| `.dae`, `.fbx`, `.obj`, ... | `true` | `true` | Spring LH, Y-up |

The non-S3O Assimp defaults match Recoil's `AssParser.cpp:591` / `GLTFParser.cpp:437`. Recoil's comment on AssParser captures the situation:

> `// "true" is the incorrect default, but has to be retained to be compatible`

### Per-material V-flip

The S3O / DAE / etc. UV values themselves never identify which orientation they assume — Spring's runtime decided that from the **source texture extension** plus the parser's `fliptextures` flag:

- DDS textures always went through `nv_dds` with `flipImage=true`, ending up bottom-up in memory regardless of the parser flag. Effective Spring UV V=0 = visual *bottom* of the source DDS.
- TGA / PNG / JPG textures went through DevIL with `IL_ORIGIN_UPPER_LEFT` and stayed top-down. A subsequent `bitmap->ReverseYAxis()` only ran when `invertAxis=true` was passed by the parser. So:
  - `fliptextures = true`: effective Spring UV V=0 = visual *bottom*.
  - `fliptextures = false`: effective Spring UV V=0 = visual *top*.

Our pipeline normalises every KTX2 to top-down storage and Babylon uploads with `UNPACK_FLIP_Y_WEBGL=true`, so WebGL UV V=0 always samples the visual bottom of the source data. Matching Spring therefore needs the modelimporter to flip every UV (`V := 1 - V`) only for the case where Spring sampled the visual top — non-DDS textures with `fliptextures = false`:

| Tex1 source extension | Effective `fliptextures` | Modelimporter UV V-flip |
|---|---|---|
| `.dds` | (any) | no |
| `.tga` / `.png` / `.jpg` / ... | `true` | no |
| `.tga` / `.png` / `.jpg` / ... | `false` | **yes** |

`GeometryExtractor::ShouldFlipUv` evaluates this for each `aiMaterial` (looking up the actual on-disk extension of `<gameRoot>/unittextures/<tex1stem>.<ext>`), and `main.cpp` flips the V of every `aiMesh` that references a flagged material. A multi-material .dae with mixed-format materials gets each mesh handled correctly.

For S3O (which has a single material per file), the default `fliptextures = false` plus the typical DDS / atlas-TGA mix means hand-painted DDS units pass through unchanged while 3DO-converted atlas TGAs (e.g. `3do2s3o_atlas_1.tga`) get their UVs flipped. For DAE, the default `fliptextures = true` plus the typical DDS / single-PNG mix means no UV flip — matching what most modern Blender→DAE exports assume.

If you author a fresh DAE/FBX/OBJ in V=0-at-top convention (Blender's default once you export to glTF, or Maya/3ds Max in "DirectX UV" mode), set `fliptextures = false` in the sidecar so the flip rule kicks in for the non-DDS textures.

## Sidecar overrides — `<modelStem>.<ext>.lua`

The sidecar is the per-asset escape hatch. It sits next to the source model and overlays fields the conversion-time defaults would compute. Every key is optional; the file itself is optional.

```lua
-- content/games/zk/objects3d/noruas.s3o.lua  (example — not all keys make sense for S3O)
return {
    tex1 = "noruas_color.dds",        -- override texture binding by name
    tex2 = "noruas_material.dds",

    fliptextures    = false,          -- skip the per-format default V-flip
    invertteamcolor = true,           -- invert tex1.A interpretation at conversion

    radius = 30.0,                    -- override AABB-computed bounding sphere
    height = 50.0,
    midpos = { 0, 23.6, 6.0 },        -- centre of mass / aim origin
    mins   = { -65, -1.4, -50 },
    maxs   = {  65, 48.7,  62 },

    normaltex = "noruas_normals.dds", -- routed to material.normalTexture

    pieces = {                        -- per-piece offset overrides
        Scene = { offset = { 0, 31, 0 } },  -- common: lift model so its feet sit on ground
        ...
    },
}
```

Defaults:

| Key | Default | Meaning |
|---|---|---|
| `tex1`, `tex2` | resolved from naming convention `<gameRoot>/unittextures/<stem>1.<ext>` / `<stem>2.<ext>` (or from `.s3o` header for S3O sources) | Source texture names |
| `fliptextures` | per-format (see table above) | V-flip every UV at import |
| `invertteamcolor` | `false` unless `<gameRoot>/unittextures/<stem>1_invert.<ext>` exists | Invert the team-mask polarity at render |
| `normaltex` | not emitted | Optional normal map; routed to glTF `material.normalTexture` |
| `radius`, `height`, `midpos`, `mins`, `maxs` | computed from mesh AABB | Bounding info, used by collision + LOS |
| `pieces[<name>].offset` | from mesh node transform | Per-piece offset override (centre-of-piece, attachment point, etc.) |

If both convention and sidecar produce a value, the sidecar wins. If neither produces one, the field is genuinely absent.

### The `<stem>1_invert.<ext>` marker

A zero-byte file (or any file) named `<stem>1_invert.<ext>` next to the `tex1` resolves `invertteamcolor` to `true` without needing a sidecar. ZK's `factoryveh1_invert.png` ships this way as the lone example. Useful when a single S3O / DAE-with-no-sidecar happens to need the flag flipped.

## What the modelimporter does

1. **Open the source** through Assimp's importer registry. Our custom `S3OImporter` plugin handles `.s3o`; everything else routes to a stock Assimp importer.
2. **Resolve sidecar overrides** by reading `<sourceModelPath>.lua` (e.g. `noruas.s3o.lua`).
3. **Apply UV V-flip per material** via `GeometryExtractor::ShouldFlipUv`: each `aiMaterial`'s tex1 reference is resolved to an on-disk extension in `<gameRoot>/unittextures/`, combined with the effective `fliptextures` value, and the verdict is applied to every `aiMesh` whose `mMaterialIndex` points at that material. UVs from the original source (S3O / DAE / glTF) are passed through unchanged until this sweep runs.
4. **Rewrite texture URIs** so the .gltf material references `.ktx2` siblings even though the source bound `.dds`/`.tga`/`.png`.
5. **Export** through Assimp's glTF 2.0 exporter with `aiProcess_MakeLeftHanded | aiProcess_FlipWindingOrder` (Spring's LH source data → glTF spec-mandated RH).
6. **Post-fix the .gltf JSON** to:
    - Move texture `source` into `extensions.KHR_texture_basisu` per spec (Assimp's exporter writes the wrong location for KTX2 references).
    - Inject the `SPRINGRTS_geometry` document-level extension (bounds, pieces, attachments).
    - Inject `SPRINGRTS_team_color` with `invertMask` when `invertteamcolor` resolved to `true`.
    - Synthesise the four-output PBR channel-split layout for any tex1-bearing material (see *Texture pipeline* below).
    - Prune `extensionsUsed` / `extensionsRequired` of any names no extension block actually references (Assimp tends to over-declare).

## Texture pipeline

The textureconverter takes one source texture and emits up to four channel-split KTX2 outputs per the PLAN-pbr-mapping scheme:

| KTX2 output | Source channel(s) | glTF reference |
|---|---|---|
| `<stem>_diffuse.ktx2` | tex1.RGB + tex2.A overlay (if tex2 supplied) for cutout | `material.pbrMetallicRoughness.baseColorTexture` |
| `<stem>_team.ktx2` | tex1.A | `material.extensions.SPRINGRTS_team_color.maskTexture` |
| `<stem>_emissive.ktx2` | tex2.R replicated to RGB | `material.emissiveTexture` |
| `<stem>_orm.ktx2` | tex2: `R=255` (no AO), `G=255-tex2.G` (specular → roughness), `B=tex2.B` (metallic) | `material.pbrMetallicRoughness.metallicRoughnessTexture` *and* `material.occlusionTexture` (one texture, two refs — spec-supported) |

Inputs decode via stb_image (TGA, PNG, JPEG, BMP) or a small DDS decoder (DXT1/3/5/BC4/BC5/uncompressed RGBA). Outputs encode as UASTC + Zstd KTX2 — Babylon's KTX2 transcoder picks a GPU-native format (BC7, ASTC, ETC2 depending on platform) at upload time. Every output carries an explicit `KTXorientation=rd` key in the KTX2 key/value data so loaders can't fall back to a different orientation default; rows are always top-down (V increases downwards), matching glTF 2.0. (`rd` is the KTX2 §3.11.4 spelling — the KTX**1** form `S=r,T=d`, written until PLAN-maps M8f, makes the file invalid to the Khronos `ktx` CLI.) Outputs also carry `KTXwriter=springrts-web textureconverter / libktx v4.0`, because the tree mixes our output with forge's `Basis Universal` and `toktx` files and provenance is the first question any texture investigation asks.

Sibling KTX2s share encoding across models — when two S3Os reference the same `3do2s3o_atlas_1.tga`, the four output KTX2s are emitted once and both `.gltf` files point at them.

## Coordinate system summary

Spring's source assets author in left-handed (LH) Y-up with Z forward. glTF 2.0 mandates right-handed (RH) Y-up with -Z forward. The modelimporter passes `aiProcess_MakeLeftHanded | aiProcess_FlipWindingOrder` to Assimp's exporter, which inverts Z (and compensates winding) on the way out. Numeric fields under `SPRINGRTS_geometry` (mins/maxs/midpos/piece offsets) are emitted in the same RH-canonical frame so engine and renderer agree on a single convention. See [`docs/coordinate-system.md`](coordinate-system.md) for the full LH↔RH migration story.

## Troubleshooting

**Unit renders as a black silhouette.**
The mesh UVs are sampling an empty region of the texture. This was the original symptom of the noruas / armcom / 3do2s3o-atlas family of units before the V-flip was wired into the S3O importer. If you're seeing this on a fresh asset:
1. Confirm the source is actually an S3O (`file <path>.s3o` should report it as binary data starting with `Spring unit\0`).
2. Confirm the `.gltf` has `SPRINGRTS_team_color.maskTexture` and that the team mask KTX2 has non-zero content (`ktx extract --transcode rgba8 ...`).
3. Spawn the unit in-game with `?scenario=weapon-showcase` and inspect via `window.test.deps.entityRenderer.modelTemplates.get(<defId>)` in the devtools console — `textures.diffuse.url` should resolve to a non-404 KTX2.

**Decals are mirrored vertically (text reads upside-down, wheels sit on the body).**
The per-material V-flip rule (see *Per-material V-flip*) picked the wrong answer for the asset. Re-check the `tex1` reference: if the model uses a `.dds` texture but the unit looks mirrored, the rule decided "no flip" — check whether the source actually authored the UVs against a DDS that was *not* `nv_dds`-flipped (rare; was the asset hand-crafted in Blender against a top-down DDS?), and set `fliptextures = false` in the sidecar to force the flip rule's TGA branch. If the model uses `.tga`/`.png`/etc. and looks mirrored, the rule decided "flip" — flip it manually with `fliptextures = true` in the sidecar to opt out.

**Team color appears where it shouldn't (or doesn't appear where it should).**
Wrong `invertteamcolor`. Toggle the sidecar value. Hand-authored Spring assets typically use the standard polarity (`invertteamcolor = false`); the rare exceptions ship a `<stem>1_invert.<ext>` marker or set the flag explicitly.

**`gameconverter` regenerated outputs but the browser still shows the old data.**
Service workers and the browser cache are aggressive about KTX2 / glTF — hard-reload (`Ctrl+Shift+R` / `Cmd+Shift+R`) or temporarily disable cache in devtools. The server itself emits a fresh `last-modified` so a hard reload is sufficient. If still stale, run `clear_defs_cache` via the spring-debug MCP.

**`gltf-validator` flags `KHR_texture_basisu` source location.**
This is the bug `FixGlbBasisuTextures` is meant to suppress (Assimp writes `texture[].source` instead of `texture[].extensions.KHR_texture_basisu.source`). If the validator still flags it, the modelimporter wasn't run or its post-fix pass crashed mid-write — regenerate from the source.

## Pipeline flow at a glance

```
content/games/<gameId>/objects3d/<stem>.s3o (or .dae/.glb/...)
content/games/<gameId>/objects3d/<stem>.<ext>.lua  (optional sidecar)
content/games/<gameId>/unittextures/<stem>1.<ext>  (optional convention)
content/games/<gameId>/unittextures/<stem>1_invert.<ext>  (optional marker)
        |
        | gameconverter content/games/<gameId>
        v
    modelimporter
        ├─ S3OImporter / Assimp readers — load scene (UVs untouched)
        ├─ Per-material ShouldFlipUv — sidecar + tex1 extension probe
        ├─ V-flip UVs of every aiMesh whose material's verdict is "yes"
        ├─ Assimp glTF exporter — LH→RH, write .gltf + .bin
        └─ FixGlbBasisuTextures — JSON post-fix, inject SPRINGRTS_geometry + SPRINGRTS_team_color
    textureconverter (per channel-split sibling)
        ├─ Decode (DDS / TGA / PNG / ...) — output is always top-down RGBA8
        ├─ ApplyChannelOp (diffuse / team / emissive / orm)
        ├─ Encode UASTC + Zstd KTX2
        └─ Stamp KTXorientation=rd (orientation) + KTXwriter (provenance)
        |
        v
data/games/<gameId>/models/<stem>.gltf + .bin + KTX2 siblings
```

## Related references

- [`docs/rendering-models.md`](rendering-models.md) — runtime side: thin instances, PBR + team-colour plugin, KTX2 transcoder
- [`docs/coordinate-system.md`](coordinate-system.md) — LH↔RH spec-compliance work
- `PLAN-pbr-mapping.md` (repo root) — design history of the four-output PBR channel split
- `RecoilEngine/rts/Rendering/Textures/S3OTextureHandler.cpp` — Recoil's reference implementation (where `invertAxis` and `invertAlpha` originate)
- `RecoilEngine/rts/Rendering/Models/AssParser.cpp:591` and `GLTFParser.cpp:437` — Recoil's per-format `fliptextures` / `invertteamcolor` defaults
- `tools/modelimporter/`, `tools/textureconverter/`, `tools/gameconverter/` — source for each step in the pipeline
