/**
 * EntityRenderer — per-piece thin-instanced entity rendering.
 *
 * Each unit type's glb model is loaded and decomposed into pieces
 * (chassis, turret, arms, legs, etc.). Each piece becomes a separate
 * thin-instance source mesh. All units of the same type share the
 * same piece meshes — 1000 tanks = 1 draw call per piece type, not
 * 1000 draw calls.
 *
 * The piece hierarchy from the glb is preserved so individual pieces
 * can be animated (turret rotation, walking legs) by overriding their
 * local transforms. For now all pieces use their rest pose from the
 * model file.
 *
 * Defs without a model fall back to a single procedural shape using
 * thin instances (box/cylinder/cone/sphere).
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    TransformNode,
    Matrix,
    Vector3,
    Quaternion,
    StandardMaterial,
    PBRMaterial,
    Material,
    Color3,
    BoundingInfo,
    SceneLoader,
    Texture,
    RawTexture,
    Engine,
    ShadowGenerator,
    type CascadedShadowGenerator,
    type DirectionalLight,
} from '@babylonjs/core';
import { TeamColorPlugin } from './team-color-plugin.js';
import { TEAM_COLORS } from './team-colors.js';
import '@babylonjs/loaders/glTF/index.js';
// KTX2 loader is registered in main.ts (the app entry). All unit
// textures resolve to `.ktx2` URIs after the texture pipeline migration.
import type { EntityStateSnapshot } from './entity-state.js';
import { EntityInterpolator } from './entity-interpolator.js';
import type { PresentationClock } from './presentation-clock.js';
import type { UnitDefInfo } from './connection.js';
import type { PieceStateSnapshot } from './piece-state.js';
import type { LosBitmap } from './los-bitmap.js';
import { extractClips, type ModelClip } from './clip-player.js';
import { loadDirManifest, dirOfUrl } from './dir-manifest.js';
import {
    createZKMaterial, setActiveZKShadowGenerator, zkOptionsFromCustomParams,
    type ZKUnitTextures,
} from './zk-model-material.js';
import { matchAimSlots, type UnitAimPieces, type AimPiece } from './turret-aim-controller.js';
import { LodTier, type ImpostorRenderer } from './impostor-renderer.js';
import { DitherFadePlugin } from './dither-fade-plugin.js';
import type { MemberModel } from './squad-render-backend.js';

/** Per-material texture URIs, keyed by material name in the .gltf.
 *  Single-material models (all S3O/DAE content) use just the `materials[0]`
 *  fields on `ModelConfig` directly; multi-material models (Warzone `.pie`
 *  units whose pieces each reference a different texture page) additionally
 *  carry this map so each piece binds its own material's textures. */
interface MaterialTextureUris {
    diffuseUri?: string;
    emissiveUri?: string;
    ormUri?: string;
    teamMaskUri?: string;
    normalUri?: string;
    invertteamcolor?: boolean;
}

/** Parsed model config — sourced from the .gltf's
 *  `extensions.SPRINGRTS_geometry` block plus the PBR material slots
 *  (PLAN-pbr-mapping.md). A hand-authored `<stem>.config.lua` sidecar
 *  can override `invertteamcolor`; the rest is fully machine-
 *  generated and authoritative from the .gltf. */
interface ModelConfig {
    /** Per-material texture URIs keyed by glTF material name. Present for
     *  every model (single entry for single-material models); the loader
     *  binds each piece by its `mesh.material.name`. The top-level
     *  `diffuseUri`/… below mirror `materials[0]` for back-compat. */
    materials?: Map<string, MaterialTextureUris>;
    /** Base color URI — `<tex1stem>_diffuse.ktx2` with cutout in alpha. */
    diffuseUri?: string;
    /** Self-illumination URI — `<tex2stem>_emissive.ktx2`, RGB grayscale glow. */
    emissiveUri?: string;
    /** ORM URI — `<tex2stem>_orm.ktx2`. R=AO, G=roughness, B=metallic.
     *  Shared between glTF's `metallicRoughnessTexture` and `occlusionTexture`. */
    ormUri?: string;
    /** Team-color mask URI — `<tex1stem>_team.ktx2`, R = blend amount.
     *  Referenced via the `SPRINGRTS_team_color` material extension. */
    teamMaskUri?: string;
    /** Optional normal-map URI — Spring `normaltex` author-config field
     *  routed through to glTF `material.normalTexture`. RGB = tangent-
     *  space normal in standard PBR convention. */
    normalUri?: string;
    /** Inversion flag for the team mask: `false` (default) means high R
     *  → more team color, `true` flips the interpretation. */
    invertteamcolor?: boolean;
    /** Piece names in canonical (server) order. Used to align the
     *  client's per-piece indexing with the server's piece-state
     *  envelope, which references pieces by their JSON-config index. */
    pieceNames?: string[];
    /** parent[i] = parent index of piece i in canonical order (-1 for
     *  the model root). Walks the same tree as `pieceNames`. */
    pieceParents?: number[];
    /** Model-local axis-aligned bounding box minimum (Y is up). Used to
     *  decide how much to shift the model so its visible base sits on
     *  the ground. */
    minY?: number;
    /** Model-local axis-aligned bounding box maximum Y. */
    maxY?: number;
    /** Model-local "midpos" Y (Spring's authored visual centre). When
     *  this sits well above origin the model was authored with origin
     *  at its physical base (common for tall structures whose
     *  foundations extend below origin and are meant to be hidden by
     *  terrain). When it sits at/below origin the model uses centre-
     *  origin and we should lift its base up to ground level. */
    midY?: number;
}

/** Loaded texture set for a unit def. Four KTX2 files per Spring's S3O
 *  channel-split (PLAN-pbr-mapping.md):
 *    diffuse  — RGB + binary cutout alpha
 *    emissive — RGB grayscale self-illumination
 *    orm      — G=roughness, B=metallic (R=AO ignored for now)
 *    teamMask — R = team-color blend amount
 *  emissive/orm/teamMask are null for unit defs that don't supply them
 *  (legacy content, fallback shapes). */
interface UnitTextures {
    diffuse: Texture;
    emissive: Texture | null;
    orm: Texture | null;
    teamMask: Texture | null;
    /** Tangent-space normal map (RGB → [-1,1]). When present the shader
     *  perturbs the geometric normal per fragment via a derivative-based
     *  TBN — no mesh tangents required. */
    normal: Texture | null;
    invertTeamColor: boolean;
    /** True only for the synthesized 1×1 white `diffuse` handed to models
     *  with geometry but no texture config (getWhiteFallbackDiffuse). The
     *  material factory routes it to TeamColorPlugin.syntheticAlbedo so
     *  those units render fully team-tinted instead of flat white. Absent
     *  (falsy) for every real loaded texture set. */
    syntheticFallback?: boolean;
}

/**
 * Read a model's metadata from its `.gltf` file (PLAN-pbr-mapping.md):
 *
 *   - `extensions.SPRINGRTS_geometry`: piece tree, bounds, midpos.
 *   - `materials[0].pbrMetallicRoughness.baseColorTexture` → diffuse URI.
 *   - `materials[0].emissiveTexture`                       → emissive URI.
 *   - `materials[0].pbrMetallicRoughness.metallicRoughnessTexture`
 *                                                          → ORM URI.
 *   - `materials[0].extensions.SPRINGRTS_team_color.maskTexture`
 *                                                          → team-mask URI.
 *
 * Texture indices are resolved through `textures[]` → `images[].uri`,
 * preferring `KHR_texture_basisu.source` when present (our pipeline
 * never falls back to plain `source` for KTX2 references).
 *
 * A hand-authored `<stem>.config.lua` sibling can override
 * `invertteamcolor` (the team-mask interpretation flag); other fields
 * are machine-generated by modelimporter and not user-editable.
 */
async function fetchModelConfig(modelUrl: string): Promise<ModelConfig | null> {
    let gltf: any;
    try {
        // Don't stamp model URLs — Babylon's glTF loader resolves
        // sibling .bin / .ktx2 files relative to the document URL,
        // and a `?v=` query string on the parent breaks that
        // resolution. HTTP caching uses Last-Modified / ETag from
        // the static-data Vite plugin (see client/vite.config.ts).
        const r = await fetch(modelUrl);
        if (!r.ok) return null;
        gltf = await r.json();
    } catch {
        return null;
    }

    const resolveTextureUri = (idx: number | undefined): string | undefined => {
        if (idx === undefined || idx < 0) return undefined;
        const tex = gltf?.textures?.[idx];
        if (!tex) return undefined;
        const imgIdx = tex?.extensions?.KHR_texture_basisu?.source ?? tex?.source;
        if (typeof imgIdx !== 'number') return undefined;
        const uri = gltf?.images?.[imgIdx]?.uri;
        return typeof uri === 'string' ? uri : undefined;
    };

    // Pull the PBR + SPRINGRTS_team_color texture URIs out of one glTF
    // material. Shared by the materials[0] back-compat fields and the
    // per-material map below.
    const parseMaterial = (m: any): MaterialTextureUris => ({
        diffuseUri:  resolveTextureUri(m?.pbrMetallicRoughness?.baseColorTexture?.index),
        emissiveUri: resolveTextureUri(m?.emissiveTexture?.index),
        ormUri:      resolveTextureUri(m?.pbrMetallicRoughness?.metallicRoughnessTexture?.index),
        teamMaskUri: resolveTextureUri(m?.extensions?.SPRINGRTS_team_color?.maskTexture?.index),
        normalUri:   resolveTextureUri(m?.normalTexture?.index),
        invertteamcolor: m?.extensions?.SPRINGRTS_team_color?.invertMask,
    });

    // Per-material map, keyed by glTF material name (Babylon names each
    // loaded material after its glTF name, so the loader correlates a
    // piece's `mesh.material.name` to its texture set). Multi-material
    // models — e.g. Warzone `.pie` units whose pieces reference different
    // texture pages — need this; single-material models fall back to the
    // top-level fields via `materials[0]`.
    const materials = new Map<string, MaterialTextureUris>();
    if (Array.isArray(gltf?.materials)) {
        gltf.materials.forEach((m: any, i: number) => {
            const key = (typeof m?.name === 'string' && m.name) ? m.name : `material${i}`;
            if (!materials.has(key)) materials.set(key, parseMaterial(m));
        });
    }

    const mat = gltf?.materials?.[0];
    const { diffuseUri, emissiveUri, ormUri, teamMaskUri, normalUri } = parseMaterial(mat);
    let invertteamcolor: boolean | undefined =
        mat?.extensions?.SPRINGRTS_team_color?.invertMask;

    const geom = gltf?.extensions?.SPRINGRTS_geometry;
    let pieceNames: string[] | undefined;
    let pieceParents: number[] | undefined;
    if (Array.isArray(geom?.pieces)) {
        pieceNames = geom.pieces.map((p: { name?: string }) =>
            typeof p?.name === 'string' ? p.name : '');
        pieceParents = geom.pieces.map((p: { parent?: number }) =>
            typeof p?.parent === 'number' ? p.parent : -1);
    }
    const minY = Array.isArray(geom?.mins)   && typeof geom.mins[1]   === 'number' ? geom.mins[1]   : undefined;
    const maxY = Array.isArray(geom?.maxs)   && typeof geom.maxs[1]   === 'number' ? geom.maxs[1]   : undefined;
    const midY = Array.isArray(geom?.midpos) && typeof geom.midpos[1] === 'number' ? geom.midpos[1] : undefined;

    // Optional `.config.lua` author override. The .gltf is authoritative
    // for everything else; only `invertteamcolor` is overridable today.
    const luaUrl = modelUrl.replace(/\.(?:glb|gltf)$/, '.config.lua');
    const manifest = await loadDirManifest(dirOfUrl(modelUrl));
    const luaName = luaUrl.substring(luaUrl.lastIndexOf('/') + 1);
    if (manifest.has(luaName)) {
        try {
            const r = await fetch(luaUrl);
            if (r.ok) {
                const luaText = await r.text();
                const invertMatch = luaText.match(/invertteamcolor\s*=\s*(true|false)/);
                if (invertMatch) invertteamcolor = invertMatch[1] === 'true';
            }
        } catch { /* missing is fine */ }
    }

    return {
        materials,
        diffuseUri, emissiveUri, ormUri, teamMaskUri, normalUri, invertteamcolor,
        pieceNames, pieceParents, minY, maxY, midY,
    };
}

/**
 * Resolve a texture filename from a config (e.g. "strikecom.ktx2") to
 * a full URL. Textures live in `models/` alongside the .glb files —
 * gameconverter writes them there so the glb's image URIs (which the
 * glTF loader resolves relative to the .glb) point at sibling files.
 * Babylon's glTF loader rejects URIs containing `..` per the glTF
 * spec, which forced this layout.
 */
function resolveTextureUrl(modelUrl: string, textureName: string): string {
    const lastSlash = modelUrl.lastIndexOf('/');
    return `${modelUrl.substring(0, lastSlash + 1)}${textureName}`;
}

// Data-driven model-material selection. A game declares which client
// material "port" it wants via modinfo `modelMaterialPort` (→ /api/games
// → gp:init → setModelMaterialPort). NO gameId hardcoding — any mod opts
// in by naming a port:
//   'zk-939'  → hand-ported ZK GL3 custom-unit-shader (zk-model-material).
//   'cus-pbr' → Recoil cus_gl4 metallic look layered on the engine-default
//               material (env-reflection approximation + boosted specular,
//               driven by the model's own ORM/metallic channel). BAR and
//               any cus_gl4-based mod declare this.
//   ''/other  → engine-default material.
let modelMaterialPort = '';
export function setModelMaterialPort(port: string): void {
    modelMaterialPort = port || '';
}

function createUnitMaterial(
    name: string,
    textures: UnitTextures,
    teamColor: Color3,
    scene: Scene,
    customParams: Record<string, string> | undefined,
): Material {
    if (modelMaterialPort === 'zk-939') {
        const opts = zkOptionsFromCustomParams(customParams, textures.normal !== null);
        return createZKMaterial(name, textures as ZKUnitTextures, teamColor, scene, opts);
    }
    return createUnitPBRMaterial(
        name, textures, teamColor, scene, modelMaterialPort === 'cus-pbr');
}

/// 1×1 RGBA(255,255,255,255) fallback diffuse for models without a
/// texture sidecar. Cached per-scene so every textureless piece shares
/// the same GPU resource. The team tint does NOT come from this texel:
/// materials built around it set `UnitTextures.syntheticFallback`, which
/// flips the TeamColorPlugin's `syntheticAlbedo` flag → full team tint
/// (the "flat team-coloured shape" look). Real maskless albedos stay
/// untinted (see the plugin's `teamMask` FIDELITY note).
const WHITE_TEX_CACHE = new WeakMap<Scene, RawTexture>();

function getWhiteFallbackDiffuse(scene: Scene): RawTexture {
    let tex = WHITE_TEX_CACHE.get(scene);
    if (tex) return tex;
    const px = new Uint8Array([255, 255, 255, 255]);
    tex = new RawTexture(px, 1, 1, Engine.TEXTUREFORMAT_RGBA, scene,
        false, false, Texture.NEAREST_SAMPLINGMODE);
    tex.name = 'unit-fallback-diffuse';
    WHITE_TEX_CACHE.set(scene, tex);
    return tex;
}

/**
 * Create a unit-piece material: Babylon's stock `PBRMaterial` (glTF
 * metallic-roughness) + a team-colour MaterialPlugin. This replaced the
 * hand-rolled `teamColor` ShaderMaterial — the custom shader only existed to do
 * team colour, but then had to re-implement sun + ambient + CSM shadows itself
 * (badly: no sun colour/intensity, flat ambient, weak self-shadow). PBRMaterial
 * consumes the scene sun + hemispheric ambient + CSM shadow automatically (like
 * feature-renderer.ts already does for map features) and reads the authored
 * glTF PBR textures natively, so units match the authored look with correct
 * self-shadowing. See docs/lighting.md "unit PBR material".
 *
 * Shadow casting/receiving is set at the MESH level by the caller
 * (`csm.addShadowCaster(mesh)` + `mesh.receiveShadows = true`), same as features.
 */
function createUnitPBRMaterial(
    name: string,
    textures: UnitTextures,
    teamColor: Color3,
    scene: Scene,
    cusPbr: boolean = false,
): PBRMaterial {
    const mat = new PBRMaterial(name, scene);
    mat.albedoTexture = textures.diffuse;

    if (textures.orm) {
        // ORM = R:occlusion, G:roughness, B:metallic — exactly glTF's packed
        // metallicRoughness (G/B) + occlusion (R) convention, so one texture
        // drives all three PBR channels with no re-derivation.
        mat.metallicTexture = textures.orm;
        mat.useRoughnessFromMetallicTextureGreen = true;
        mat.useMetallnessFromMetallicTextureBlue = true;
        mat.useAmbientOcclusionFromMetallicTextureRed = true;
        mat.metallic = 1.0;
        mat.roughness = 1.0;
    } else {
        // No ORM sidecar → matte dielectric (the old flat-fallback look).
        mat.metallic = 0.0;
        mat.roughness = 1.0;
    }

    if (textures.normal) {
        // Tangent-space normal map. The thin-instanced meshes carry no vertex
        // tangents, so Babylon derives the TBN from screen-space derivatives
        // (same basis the old shader's perturbNormal used).
        mat.bumpTexture = textures.normal;
    }

    if (textures.emissive) {
        // Grayscale self-illumination (thruster/glow), added over the lit result.
        mat.emissiveTexture = textures.emissive;
        mat.emissiveColor = Color3.White();
    }

    // BAR / cus_gl4 mods asked for a metallic env sheen. WebGL2 has no cubemap
    // env probe here, so we lean on the scene image-processing + the model's own
    // metallic channel; environmentIntensity gives a mild lift when a scene
    // env texture is present. Approximate — revisit with a real reflection probe.
    if (cusPbr) mat.environmentIntensity = 1.2;

    // Team colour — the one thing stock PBR can't do — via the plugin, which
    // rewrites surfaceAlbedo before the light loop (mix(albedo, teamColor, mask)).
    const plugin = new TeamColorPlugin(mat);
    plugin.teamColor = teamColor;
    plugin.teamMask = textures.teamMask;
    plugin.invertMask = textures.invertTeamColor;
    // Synthesized-white fallback (no texture config) → full team tint, so the
    // unit still reads as "flat team-coloured shape" rather than flat white.
    // Real maskless albedos keep their texture — a deliberate Recoil deviation
    // (S3O tex1-alpha=1 ⇒ full tint there); see the plugin's FIDELITY note.
    plugin.syntheticAlbedo = textures.syntheticFallback === true;

    // Fully opaque. (The old discard-stipple build-progress effect is dropped —
    // it was already dead: the vertex shader hardcoded vBuildProgress = 1.0
    // pending a per-instance attribute. Re-add on the plugin when build progress
    // is actually streamed per thin-instance.)
    mat.alpha = 1.0;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;

    // Two-sided: modelimporter (Assimp + S3O/PIE) emits glTF with CCW winding
    // vs Babylon's default CW, so culling would strip the visible surfaces and
    // render piece interiors. Cheap on these low-poly meshes.
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    return mat;
}

/**
 * Load the four PLAN-pbr-mapping textures referenced by a model
 * config. Returns the loaded texture set, or `null` if no diffuse URI
 * is configured. Each entry resolves through Babylon's KTX2 loader so
 * Basis Universal payloads transcode to a GPU-native format at upload
 * time. Optional textures (emissive / orm / teamMask) are returned as
 * `null` when the unit def doesn't ship that channel.
 */
function loadUnitTextures(
    config: MaterialTextureUris,
    modelUrl: string,
    scene: Scene,
): UnitTextures | null {
    if (!config.diffuseUri) return null;

    const loadTex = (uri: string | undefined): Texture | null => {
        if (!uri) return null;
        const tex = new Texture(resolveTextureUrl(modelUrl, uri), scene);
        // hasAlpha gates Babylon's auto-blend heuristic; the diffuse
        // alpha is a binary cutout, not transparency, and the team
        // mask is single-channel R8 — neither wants alpha blending.
        tex.hasAlpha = false;
        tex.anisotropicFilteringLevel = 8;
        return tex;
    };

    return {
        diffuse:  loadTex(config.diffuseUri)!,
        emissive: loadTex(config.emissiveUri),
        orm:      loadTex(config.ormUri),
        teamMask: loadTex(config.teamMaskUri),
        normal:   loadTex(config.normalUri),
        invertTeamColor: config.invertteamcolor ?? false,
    };
}

// Spring engine's 10 default team colors: now the shared team-colors.ts
// module (imported at the top) so the impostor sprite path tints identically.

// Fallback shape types for defs without models
enum UnitShape { Box = 0, Cylinder, Cone, Sphere }
const SHAPE_COUNT = 4;

function defIdToShape(defId: number): UnitShape {
    return (defId % SHAPE_COUNT) as UnitShape;
}

export interface EntityMeta {
    defId: number;
    team: number;
    healthScale: number;
    /** 0..1 build completion. Drives the nanoframe shader: below 1 the
     *  unit renders as a wireframe with a rising scan band; at 1 it is
     *  shaded normally. The server emits 255 once construction finishes
     *  so the byte → float mapping pins finished units to exactly 1.0. */
    buildProgress: number;
    /** Per-unit Spring losStatus low nibble for the receiving session's
     *  ally team. See FIELD_LOS_STATE in entity-state.ts.
     *    bit 0 LOS_INLOS, bit 1 LOS_INRADAR, bit 2 LOS_PREVLOS, bit 3 LOS_CONTRADAR.
     *  Own-team units and permissive sessions read 0x0F. */
    losState: number;
    /** True when the server's state_bits bit 7 (`alwaysVisible`) is set.
     *  These units render at their last-known pose even when `losState`
     *  resolves to 0 — engine-tagged map landmarks plus units explicitly
     *  flipped via `Spring.SetUnitAlwaysVisible`. */
    alwaysVisible: boolean;
    /** base_frame of the newest snapshot that carried this entity. The
     *  server recycles unit IDs, so a scheduled 'destroy' (PLAN-latency L1)
     *  can fire after the same ID was reassigned to a newly visible unit —
     *  game-processor's onEntityDestroy skips the removal when this is
     *  newer than the destroy's frame. */
    lastStateFrame: number;
}

/** Bit values for EntityMeta.losState — mirror Spring's losStatus bits
 *  on the server (Sim/Units/Unit.h). */
const LOS_INLOS = 1 << 0;
const LOS_INRADAR = 1 << 1;
const LOS_PREVLOS = 1 << 2;

/** state_bits bit 7 — `alwaysVisible` per `EntityStateSerializer.h`. */
const STATE_BIT_ALWAYS_VISIBLE = 1 << 7;

/** isBuilding bit in UnitDefInfo.flags — protocol.fbs GameUnitDef.flags
 *  bit 12 (derived from CSolidObject::IsBuildingUnit). */
const UDF_FLAG_IS_BUILDING = 1 << 12;

/** Frozen-pose snapshot for buildings that are PREVLOS but no longer
 *  in LOS — the client keeps drawing them at the last-seen pose until
 *  the server reports either fresh LOS or destruction. */
interface GhostPose {
    x: number;
    y: number;
    z: number;
    heading: number;
    pitch: number;
    roll: number;
    defId: number;
    team: number;
    buildProgress: number;
}

/** Per-piece pose override for one unit, indexed by piece index.
 *  Pieces not present in this map keep their rest-pose transform. */
type PieceOverrides = Map<number, { px: number; py: number; pz: number;
                                     rx: number; ry: number; rz: number; }>;

/** A single piece (body part) within a model template. */
interface PieceInfo {
    /** The mesh with vertices in piece-local space. */
    mesh: Mesh;
    /** Piece name from the glb node (e.g. "Turret", "LegLeft"). */
    name: string;
    /** Index of the parent piece (-1 for root-level pieces). */
    parentIndex: number;
    /** Local transform relative to parent (from glb hierarchy).
     *  Multiply parent chain to get the rest-pose world matrix. */
    localMatrix: Matrix;
    /** Pre-computed rest-pose world matrix (product of all ancestors'
     *  localMatrix values). Used directly when no animation override. */
    restWorldMatrix: Matrix;
    /** glTF material name of this piece's mesh, used to bind the piece's
     *  own texture set on multi-material models (Warzone `.pie` units).
     *  Undefined for structural (meshless) nodes; falls back to the
     *  model-wide default texture set when absent or unmatched. */
    materialKey?: string;
}

/** Loaded model template for a unit def. */
interface ModelTemplate {
    pieces: PieceInfo[];
    /** Per-material texture sets keyed by glTF material name. Pieces bind
     *  their own set via `PieceInfo.materialKey`; empty/absent for
     *  single-material models (they use `textures`). */
    materialTextures: Map<string, UnitTextures>;
    /** Vertical offset so the model's base sits at Y=0. */
    yOffset: number;
    /** Y-extent of the model from foot to top, in elmos. Used by the
     *  nanoframe shader as the rising-plane scale: planeY ramps from
     *  0 (no progress) to modelHeight (fully built). */
    modelHeight: number;
    /** Loaded textures (diffuse + team mask). Null if no textures. */
    textures: UnitTextures | null;
    /** Ghost-prototype meshes for build-placement preview. Each entry
     *  is a hidden source mesh with the ghost material assigned;
     *  createGhostMesh creates one InstancedMesh per ghost prototype
     *  so multiple ghosts share geometry without re-loading the glb.
     *  Indexed parallel to `pieces` (null for structural-only nodes). */
    ghostPrototypes: (Mesh | null)[];
    /** Pre-decomposed local transforms for each ghost prototype, used
     *  to position instances at rest pose. Same length as ghostPrototypes. */
    ghostLocalTransforms: { trans: Vector3; rot: Quaternion; scale: Vector3 }[];
    /** Single shared ghost material referenced by every prototype.
     *  Disposed alongside the template. */
    ghostMaterial: StandardMaterial | null;
    /** Authored .glb animation clips, retargeted onto piece indices at
     *  load (PLAN-model-harness task 6). Empty for converted S3O/DAE
     *  models — only native glTF assets carry clips. Played by the dev
     *  ClipPlayer via `setClipPose`; fx-offload later consumes the same
     *  clips as baked animation textures. */
    clips: ModelClip[];
}

/** Per-piece thin-instance render mesh, keyed by (defId, team, pieceIdx). */
interface PieceRenderEntry {
    mesh: Mesh;
    pieceIdx: number;
}

export class EntityRenderer {
    private scene: Scene;
    private interpolator = new EntityInterpolator();
    /** Presentation clock (PLAN-latency L0). Drives the cursor frame the
     *  interpolator renders to. Null until wired by main.ts; the renderer
     *  then falls back to the freshest received frame (no display delay). */
    private presClock: PresentationClock | null = null;
    /** Cursor frame recomputed each tick(); also used by between-tick
     *  position queries (build beams etc.) so they agree with the render. */
    private cursorFrame = 0;
    private entityMeta = new Map<number, EntityMeta>();
    private teamMaterials: StandardMaterial[] = [];
    /** DefIds whose entities render via the Metalstorm squad fan-out
     *  (client/squads — squad_size > 1) instead of a single unit mesh.
     *  The interpolator + entityMeta still track them (the squad adapter
     *  reads their interpolated pose via getEntityPose), but tick() skips
     *  emitting an instance so the sim-authoritative body isn't drawn on
     *  top of its cosmetic soldiers. Populated by the worker adapter as
     *  squad defs stream in (game-processor). */
    private squadDefIds = new Set<number>();
    /** Map heightmap data for terrain re-projection of ground units.
     *  Entity Y comes from the server snapped to terrain on each sim
     *  frame, but state streams at ~10 Hz and we lerp between frames —
     *  the lerped Y can drift above or below the terrain when paths
     *  cross hills/valleys. We re-project ground entities each tick. */
    private mapHeightmap: Uint16Array | null = null;
    private mapHmW = 0;
    private mapHmH = 0;
    private mapMinH = 0;
    private mapMaxH = 0;
    private mapSquareSize = 8;

    // --- Model loading ---
    private modelTemplates = new Map<number, ModelTemplate | null>();
    /// Registered UnitDefs awaiting their first render. Populated by
    /// `setUnitDefs()`; consumed by `ensureModelLoaded()` on first
    /// sighting of an entity / build-placement reference. Decoupling
    /// def registration from model fetch is what makes load lazy —
    /// the server now streams ~all defs early-ish but the client
    /// only pays the per-def glb+texture cost when a unit actually
    /// appears.
    private defInfos = new Map<number, UnitDefInfo>();
    /// Per-defId in-flight load promise. Dedups concurrent
    /// `ensureModelLoaded` calls (every tick of every visible entity
    /// of that def would otherwise re-fire the fetch).
    private loadingModels = new Map<number, Promise<ModelTemplate | null>>();
    private defModelUrls = new Map<number, string>();
    /** Per-defId building flag from UnitDefInfo.flags bit 12. Drives the
     *  ghost-building behaviour: only buildings get PREVLOS frozen-pose
     *  rendering; mobile units in PREVLOS just disappear once they leave
     *  radar (mirrors Recoil). */
    private defIsBuilding = new Set<number>();
    /** Per-defId model-space bounding sphere (centre relative to the model
     *  origin, radius = rest-pose AABB half-diagonal — midpos-relative,
     *  mirroring Recoil's RadiusFromAabb). Lazily computed for the orbit
     *  rig's auto-frame (PLAN-model-harness §5). */
    private defBoundsCache = new Map<number, {
        cx: number; cy: number; cz: number; radius: number;
    }>();

    // --- Render meshes ---
    // Per-piece thin-instance meshes, keyed by "model:{defId}:{team}:{pieceIdx}"
    // or "shape:{shape}:{team}" for fallbacks.
    private renderMeshes = new Map<string, Mesh>();

    // Member-tier 3D model meshes for the squad fan-out (PLAN-metalstorm-impostors
    // M4), keyed by "member:{defId}:{team}". A dedicated clone of a squad def's
    // single body piece with its team material, handed to SquadRenderBackend to
    // thin-instance its own close-range members. Kept OUT of `renderMeshes` on
    // purpose: the render() loop hides every renderMeshes entry not active this
    // frame, and squad defs are skipped there (line ~1878), so a member mesh
    // stored in renderMeshes would be force-hidden every frame — clobbering the
    // squad backend's thin instances. This map is disposed with the renderer but
    // never touched by render().
    private memberModelMeshes = new Map<string, Mesh>();

    // Unit materials, SHARED across all pieces that use the same texture set,
    // keyed by "{defId}:{team}:{materialKey}". A unit's pieces almost always
    // share one glTF material, so this collapses e.g. the 18-piece colossus
    // from 18 identical PBRMaterials to one — heavy PBR materials are far more
    // expensive to compile/hold than the old custom shader, and one-per-piece
    // was needless GPU + memory pressure (and a leak: mesh.dispose() doesn't
    // free the material). Disposed in the model-template cleanup.
    private unitMaterials = new Map<string, Material>();

    // Dedicated member-model materials (M5), keyed the same way as unitMaterials
    // but SEPARATE so the DitherFadePlugin (screen-door LOD crossfade, reads a
    // per-instance `ditherFade` attribute) never rides the shared full-unit
    // material — full units set no `ditherFade` attribute, so a shared plugin
    // would read fade=0 and discard them entirely. Same texture/team pipeline as the unit
    // material otherwise, so a member reads identically to a full unit.
    private memberMaterials = new Map<string, Material>();

    // --- Per-entity piece pose overrides ---
    // Populated by applyPieceState() from server-streamed piece transforms.
    // Pieces missing from a unit's override map render at rest pose.
    private pieceOverrides = new Map<number, PieceOverrides>();

    // --- Dev clip-player poses (PLAN-model-harness task 6) ---
    // Raw Babylon parent-relative local matrices per piece, pushed by the
    // ClipPlayer each frame while a clip plays. Takes precedence over the
    // server piece-state override for that unit (it's a dev inspection
    // tool — the authored clip is exactly what's being judged).
    private clipPoses = new Map<number, ReadonlyMap<number, Matrix>>();

    // --- Cosmetic turret-aim poses (DESIGN-MODEL-BUILDING §16c) ---
    // Spring-euler per-piece poses pushed by TurretAimController for a
    // native's turret/barrel. Same shape as `pieceOverrides` so both run
    // through springToBabylonLocal identically. Merge precedence (see
    // computePieceWorldMatrices): streamed 0x05 > aim > wheel > clip > rest.
    private aimPoses = new Map<number, PieceOverrides>();
    // --- Cosmetic wheel-spin poses (PLAN-metalstorm-train T6) ---
    // Pushed by TrainPresentation for axle pieces. A SEPARATE map from
    // aimPoses even though both are Spring-euler per-piece pose overrides:
    // setAimPose/setWheelPose each REPLACE their whole per-unit map, so a
    // train car with an engaged turret AND spinning axles needs its own
    // channel — sharing aimPoses would have whichever system ticks last
    // that frame silently blank the other's pieces. Piece indices never
    // overlap (turret/barrel vs axleN), so precedence relative to aimPose
    // doesn't matter for correctness.
    private wheelPoses = new Map<number, PieceOverrides>();
    // Units ever seen in a 0x05 piece-state snapshot — the sim owns their
    // pieces, so the cosmetic aim controller declines them (ZK/BAR/future
    // s4 sim aim). Read by game-processor's TurretAimDeps.simDrivesPieces.
    private pieceStreamed = new Set<number>();

    // --- Ghost pose freeze for PREVLOS-only buildings ---
    // The server stops sending updates for buildings that have left LOS
    // but have PREVLOS set. We freeze the last known pose so they keep
    // rendering at that location until either fresh LOS resumes streaming
    // or the entity drops out of the snapshot entirely (destruction).
    private ghostPoses = new Map<number, GhostPose>();

    // --- Radar-blip shared mesh, keyed by team ---
    private radarBlipMeshes = new Map<number, Mesh>();

    // --- Fallback shape meshes ---
    private shapeMeshes = new Map<number, Mesh>();

    // Selection ring (still uses thin instances directly)
    private selectionMesh: Mesh | null = null;
    private selectedIds: number[] = [];

    /** Directional-shadow caster sink (PLAN-lighting L3). Null until
     *  `setShadowGenerator` is called from the bootstrap. Every newly-
     *  created unit/piece/fallback/radar-blip mesh is registered here
     *  on construction; meshes that pre-date the call are bulk-added by
     *  the setter itself. */
    private shadowGenerator: ShadowGenerator | null = null;

    /** Billboard/impostor LOD tier renderer (PLAN-metalstorm-beta-units.md §2.1,
     *  engine ask B1). Null until wired by the bootstrap — tick() falls back to
     *  always-Full when unset (identical to pre-B1 behaviour). */
    private impostorRenderer: ImpostorRenderer | null = null;
    /** Model-viewer F8 panel LOD override (force-LOD dropdown). Null = no
     *  override, per-def thresholds decide the tier normally. */
    private forceLodTier: LodTier | null = null;

    constructor(scene: Scene) {
        this.scene = scene;

        for (let i = 0; i < TEAM_COLORS.length; i++) {
            const mat = new StandardMaterial(`team${i}Mat`, scene);
            mat.diffuseColor = TEAM_COLORS[i];
            mat.specularColor = new Color3(0.3, 0.3, 0.3);
            this.teamMaterials.push(mat);
        }
    }

    /** Attach the presentation clock (PLAN-latency L0). Once set, the
     *  renderer interpolates entities at the cursor frame `P` instead of
     *  arrival wall-time. */
    setPresentationClock(clock: PresentationClock): void {
        this.presClock = clock;
    }

    /** Wire the impostor/billboard LOD renderer (PLAN-metalstorm-beta-units.md
     *  §2.1). Once set, tick() routes Impostor-tier entities to it instead of
     *  the per-piece model path. */
    setImpostorRenderer(renderer: ImpostorRenderer | null): void {
        this.impostorRenderer = renderer;
    }

    /** Force every entity to a single LOD tier regardless of per-def
     *  thresholds (model-viewer F8 panel's force-LOD dropdown). Pass null to
     *  restore normal distance-based tier selection. */
    setForceLodTier(tier: LodTier | null): void {
        this.forceLodTier = tier;
    }

    /**
     * Register the directional sun-shadow generator. Adds every existing
     * render mesh as a caster; new meshes auto-register in their create
     * sites. See docs/lighting.md "caster registration".
     */
    setShadowGenerator(
        csm: ShadowGenerator | null,
        sun: DirectionalLight | null = null,
    ): void {
        this.shadowGenerator = csm;
        // PBR unit materials consume the CSM through Babylon's stock light
        // binding (nothing to wire here); only the hand-ported ZK material
        // needs the generator + sun handed over for its manual uniform binds.
        // Cast: CascadedShadowGenerator extends ShadowGenerator.
        setActiveZKShadowGenerator(csm as CascadedShadowGenerator | null, sun);
        if (!csm) return;
        for (const mesh of this.renderMeshes.values()) csm.addShadowCaster(mesh);
        for (const mesh of this.shapeMeshes.values()) csm.addShadowCaster(mesh);
    }

    /** Hand the entity renderer the heightmap so it can re-project
     *  ground units onto the terrain between server snapshots. */
    setMapHeightmap(heightmap: Uint16Array, mapx: number, mapy: number,
                    minHeight: number, maxHeight: number, squareSize: number): void {
        this.mapHeightmap = heightmap;
        this.mapHmW = mapx + 1;
        this.mapHmH = mapy + 1;
        this.mapMinH = minHeight;
        this.mapMaxH = maxHeight;
        this.mapSquareSize = squareSize;
    }

    /** Public bilinear-height query at world (x, z). Returns 0 when the
     *  heightmap hasn't streamed yet — callers that need to distinguish
     *  "no data" from "sea level" should use `hasHeightmap()` first.
     *  This is the same sampler the renderer uses internally; exposed so
     *  rts-camera (terrain clamp), input-manager (pick targets) and the
     *  Lua bridge (`Spring.GetGroundHeight`) can share a single source of
     *  truth. */
    getGroundHeight(x: number, z: number): number {
        const h = this.sampleHeight(x, z);
        return Number.isFinite(h) ? h : 0;
    }

    /** Whether the heightmap has been registered yet — false during the
     *  brief window between game-start and the first `MapData` arrival. */
    hasHeightmap(): boolean {
        return this.mapHeightmap !== null;
    }

    /** Bilinear height sample at world (x, z) from the cached heightmap.
     *  Returns NaN when the heightmap hasn't been registered yet — caller
     *  must check and skip re-projection in that case. */
    private sampleHeight(x: number, z: number): number {
        const hm = this.mapHeightmap;
        if (!hm) return NaN;
        const fx = x / this.mapSquareSize;
        const fz = z / this.mapSquareSize;
        const x0 = Math.max(0, Math.min(this.mapHmW - 1, Math.floor(fx)));
        const z0 = Math.max(0, Math.min(this.mapHmH - 1, Math.floor(fz)));
        const x1 = Math.min(this.mapHmW - 1, x0 + 1);
        const z1 = Math.min(this.mapHmH - 1, z0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0));
        const tz = Math.max(0, Math.min(1, fz - z0));
        const h00 = hm[z0 * this.mapHmW + x0];
        const h10 = hm[z0 * this.mapHmW + x1];
        const h01 = hm[z1 * this.mapHmW + x0];
        const h11 = hm[z1 * this.mapHmW + x1];
        const h0 = h00 * (1 - tx) + h10 * tx;
        const h1 = h01 * (1 - tx) + h11 * tx;
        const raw = h0 * (1 - tz) + h1 * tz;
        return this.mapMinH + (raw / 65535) * (this.mapMaxH - this.mapMinH);
    }

    /**
     * Register unit defs received from the server. Stores the metadata
     * for later use but does NOT trigger model / texture fetches —
     * those happen lazily on first sighting via `ensureModelLoaded()`.
     *
     * Eager loading at this point used to fire a glb + 4–5 ktx2
     * fetches per def in the batch; with ZK's ~250 unit roster that
     * easily saturates the browser's HTTP/1.1 6-connection limit and
     * triggers spurious aborts (`status 0`) on textures that were
     * already 100% queueable. Lazy loading keeps the load curve flat
     * — only models actually used in the current match pay the cost.
     */
    setUnitDefs(defs: UnitDefInfo[]): void {
        let registered = 0;
        let alreadyKnown = 0;

        for (const def of defs) {
            if (this.defInfos.has(def.defId)) {
                alreadyKnown++;
                continue;
            }

            this.defInfos.set(def.defId, def);
            this.defModelUrls.set(def.defId, def.modelUrl);
            if ((def.flags & UDF_FLAG_IS_BUILDING) !== 0) {
                this.defIsBuilding.add(def.defId);
            }

            // PLAN-metalstorm-beta-units.md §2.1 / engine ask B1: hand the
            // impostor renderer its per-def atlas + LOD thresholds as soon as
            // they stream, so the first ensureModelLoaded/tick sighting of
            // this def can already resolve to the Impostor tier.
            if (this.impostorRenderer) {
                if (def.impostor) this.impostorRenderer.registerAtlas(def.defId, def.impostor);
                if (def.lodThresholds) {
                    this.impostorRenderer.registerLodThresholds(def.defId, def.lodThresholds);
                }
            }

            // Defs without a model file get their template slot pinned
            // to `null` now so the procedural-shape fallback path skips
            // the load attempt entirely.
            if (!def.modelUrl) {
                this.modelTemplates.set(def.defId, null);
            }

            registered++;
        }

        if (registered > 0 || alreadyKnown > 0) {
            console.log(
                `[entity-renderer] defs batch: ${registered} registered (lazy)` +
                (alreadyKnown > 0 ? `, ${alreadyKnown} already known` : '')
            );
        }
    }

    /**
     * Kick off the model + texture fetch for `defId` if it hasn't been
     * loaded or scheduled yet. Returns immediately; the loaded template
     * lands in `modelTemplates` asynchronously. Until then, entities of
     * this def render as procedural shapes (the existing fallback in
     * the tick path).
     *
     * Idempotent and cheap: a stale Map lookup per call. Safe to invoke
     * once per visible entity per tick.
     */
    private ensureModelLoaded(defId: number): void {
        if (this.modelTemplates.has(defId)) return;   // already resolved (incl. null)
        if (this.loadingModels.has(defId)) return;    // already in flight
        const def = this.defInfos.get(defId);
        if (!def || !def.modelUrl) return;            // no def registered, or no model

        const p = this.loadModel(def).then(tmpl => {
            this.modelTemplates.set(defId, tmpl);
            this.loadingModels.delete(defId);
            return tmpl;
        });
        this.loadingModels.set(defId, p);
    }

    private async loadModel(def: UnitDefInfo): Promise<ModelTemplate | null> {
        try {
            const lastSlash = def.modelUrl.lastIndexOf('/');
            const baseUrl = def.modelUrl.substring(0, lastSlash + 1);
            const fileName = def.modelUrl.substring(lastSlash + 1);

            // Don't stamp model URLs — the glTF loader resolves
            // sibling .bin / .ktx2 files relative to the document URL,
            // and a `?v=` on the parent breaks that resolution. Cache
            // validation comes from Last-Modified / ETag served by the
            // Vite static-data plugin (see client/vite.config.ts).
            //
            // --- Model-load diagnostics ---------------------------------
            // The render scene lives in the game-processor worker
            // (OffscreenCanvas), so Babylon's DOM Inspector can't reach it.
            // These are the worker-safe equivalents. Toggle verbose mode
            // from the main devtools console BEFORE spawning:
            //     window.__gp('globalThis.__MODEL_DEBUG = true')
            // then dump any already-loaded model's geometry with:
            //     window.__gp('__entityRenderer.dumpGeometry()')
            const debug = !!(globalThis as Record<string, unknown>).__MODEL_DEBUG;
            // Always-on loader tweak: DISABLE glTF animation autoplay. Babylon's
            // glTF loader plays the first animation group (our `walk` clip, which
            // drives the leg nodes) the instant the model parses — BEFORE the
            // piece walk below captures each piece's `restWorldMatrix` via
            // node.getWorldMatrix(). Animated pieces then capture a mid-animation
            // pose as their "rest" transform, which comes out as garbage
            // thin-instance bounds and the pieces (legs) fail to render — the
            // "few pieces / extra foot" bug. The clips are extracted and disposed
            // right after load anyway (they were never meant to run at load time),
            // so suppress the autoplay at the source. animationStartMode = NONE (0)
            // — GLTFLoaderAnimationStartMode.NONE; the groups are still parsed and
            // returned in result.animationGroups for extractClips().
            const pluginObserver = SceneLoader.OnPluginActivatedObservable.add((loader) => {
                const g = loader as unknown as {
                    name?: string; animationStartMode?: number;
                    loggingEnabled?: boolean; validate?: boolean;
                    onValidatedObservable?: { add(cb: (r: unknown) => void): void };
                };
                if (g.name !== 'gltf') return;
                g.animationStartMode = 0;
                if (debug) {
                    // Per-load glTF diagnostics: log every parse step and run the
                    // bundled Khronos glTF-Validator, reporting issues to console.
                    g.loggingEnabled = true;
                    g.validate = true;
                    g.onValidatedObservable?.add((r) =>
                        console.log(`[model-debug] ${def.name}: glTF-validate`, r));
                }
            });
            // Stall watchdog (always on, cheap). ImportMeshAsync awaits
            // geometry AND every material texture, so a KTX2 transcode that
            // never completes leaves this promise pending forever — the model
            // then "times out" downstream (hasModel stays null) with no root
            // cause. Report the stall and how far the load got.
            const t0 = performance.now();
            const meshesAtStart = this.scene.meshes.length;
            const texAtStart = this.scene.textures.length;
            const watchdog = setInterval(() => {
                console.warn(
                    `[model-debug] ${def.name}: ImportMeshAsync still pending after ` +
                    `${((performance.now() - t0) / 1000).toFixed(0)}s — ` +
                    `+${this.scene.meshes.length - meshesAtStart} meshes, ` +
                    `+${this.scene.textures.length - texAtStart} textures parsed so far. ` +
                    `Likely a stalled KTX2 transcode or oversized texture upload.`);
            }, 8000);

            let result;
            try {
                result = await SceneLoader.ImportMeshAsync(
                    '', baseUrl, fileName, this.scene,
                );
            } finally {
                clearInterval(watchdog);
                if (pluginObserver) SceneLoader.OnPluginActivatedObservable.remove(pluginObserver as never);
            }

            if (debug) {
                const rows = result.meshes.map((m) => ({
                    name: m.name,
                    verts: (m as Mesh).getTotalVertices?.() ?? 0,
                    faces: (m as Mesh).getTotalIndices?.() ? (m as Mesh).getTotalIndices() / 3 : 0,
                    mat: m.material?.name ?? null,
                }));
                console.log(
                    `[model-debug] ${def.name}: ImportMeshAsync resolved in ` +
                    `${((performance.now() - t0) / 1000).toFixed(1)}s — ` +
                    `${result.meshes.length} meshes, ${result.transformNodes?.length ?? 0} transform nodes, ` +
                    `${result.animationGroups?.length ?? 0} clips`, rows);
            }

            // Phase 2d (PLAN-coordinate-system): with scene RH and the
            // glTF already spec-RH on disk, Babylon's glTF loader
            // passes the file through without inserting an axis-flip
            // __root__. No reset hack needed.

            // Build piece list from the imported hierarchy. We need to
            // map glb nodes to pieces, preserving parent relationships.
            // The glb node tree may contain TransformNodes (no geometry)
            // as structural parents — we keep those as pieces too so the
            // hierarchy chain is unbroken.
            const allNodes = result.meshes as (Mesh | TransformNode)[];
            // Also include transform nodes that aren't meshes
            for (const tn of result.transformNodes || []) {
                if (!allNodes.includes(tn)) allNodes.push(tn);
            }

            // Map each node to an index for parent lookups
            const nodeToIndex = new Map<TransformNode, number>();
            for (let i = 0; i < allNodes.length; i++) {
                nodeToIndex.set(allNodes[i], i);
            }

            // Compute world matrices while hierarchy is intact
            for (const n of allNodes) n.computeWorldMatrix(true);

            // Build piece infos
            const pieces: PieceInfo[] = [];
            const nodeTopiece = new Map<TransformNode, number>();
            // Source glb node per piece — clip retargeting needs to map
            // animation-channel targets to FINAL piece indices after the
            // config reorder below (PLAN-model-harness task 6).
            const pieceNode = new Map<PieceInfo, TransformNode>();

            // Babylon's GLB loader splits multi-primitive meshes into a
            // parent TransformNode and child Mesh nodes named
            // `<parent>_primitive<n>`. The parent has the JSON-config
            // name; the children carry the geometry. Pre-pass: claim each
            // such primitive for its parent so the main loop emits one
            // piece (the parent name + densest primitive's geometry).
            const primitiveByParent = new Map<TransformNode, Mesh>();
            const absorbedPrimitives = new Set<Mesh>();
            for (const child of allNodes) {
                if (!(child instanceof Mesh)) continue;
                const parent = child.parent;
                if (!parent) continue;
                const re = new RegExp(`^${parent.name}_primitive\\d+$`);
                if (!re.test(child.name)) continue;
                const verts = child.getTotalVertices();
                const existing = primitiveByParent.get(parent as TransformNode);
                if (!existing || existing.getTotalVertices() < verts) {
                    primitiveByParent.set(parent as TransformNode, child);
                }
            }
            // Mark all primitives belonging to a parent as absorbed (we
            // only render the densest one; the rest are dropped).
            for (const child of allNodes) {
                if (!(child instanceof Mesh)) continue;
                const parent = child.parent;
                if (!parent) continue;
                const re = new RegExp(`^${parent.name}_primitive\\d+$`);
                if (re.test(child.name)) absorbedPrimitives.add(child);
            }

            for (let i = 0; i < allNodes.length; i++) {
                const node = allNodes[i];
                let isMesh = node instanceof Mesh && node.getTotalVertices() > 0;

                // Skip the __root__ container Babylon creates
                if (node.name === '__root__') continue;
                // Skip a primitive child whose geometry was rolled up
                // into its parent piece.
                if (node instanceof Mesh && absorbedPrimitives.has(node)) continue;

                // If this is a TransformNode with absorbed primitive
                // children, surface the chosen primitive as our geometry.
                let primitiveMesh: Mesh | null = null;
                if (!isMesh) {
                    primitiveMesh = primitiveByParent.get(node) ?? null;
                    if (primitiveMesh) isMesh = true;
                }

                // Find parent piece index
                let parentIndex = -1;
                let p = node.parent;
                while (p) {
                    if (nodeTopiece.has(p as TransformNode)) {
                        parentIndex = nodeTopiece.get(p as TransformNode)!;
                        break;
                    }
                    p = p.parent;
                }

                // Get local matrix relative to parent
                const localMatrix = node.getWorldMatrix().clone();
                if (parentIndex >= 0) {
                    // localMatrix = parentWorldInverse × worldMatrix
                    const parentWorld = pieces[parentIndex].restWorldMatrix;
                    const parentInv = Matrix.Invert(parentWorld);
                    localMatrix.copyFrom(parentInv.multiply(node.getWorldMatrix()));
                }

                const restWorldMatrix = node.getWorldMatrix().clone();

                const pieceIdx = pieces.length;
                nodeTopiece.set(node, pieceIdx);

                if (isMesh) {
                    const mesh = (primitiveMesh ?? node) as Mesh;
                    // glTF material name of this piece, for per-piece texture
                    // binding on multi-material models (captured before the
                    // material is replaced by our team-colour material).
                    const materialKey = mesh.material?.name;
                    // Detach from hierarchy, keep vertices in piece-local space
                    mesh.parent = null;
                    mesh.position.set(0, 0, 0);
                    mesh.rotationQuaternion = Quaternion.Identity();
                    mesh.scaling.set(1, 1, 1);
                    mesh.isPickable = false;
                    mesh.isVisible = false;
                    mesh.thinInstanceEnablePicking = false;
                    mesh.alwaysSelectAsActiveMesh = true;
                    mesh.renderingGroupId = 2;

                    const info: PieceInfo = {
                        mesh,
                        name: node.name,
                        parentIndex,
                        localMatrix,
                        restWorldMatrix,
                        materialKey,
                    };
                    pieces.push(info);
                    pieceNode.set(info, node);
                } else {
                    // Structural node (no geometry) — still needed for
                    // hierarchy chain. Use a dummy mesh reference.
                    const info: PieceInfo = {
                        mesh: null!,
                        name: node.name,
                        parentIndex,
                        localMatrix,
                        restWorldMatrix,
                    };
                    pieces.push(info);
                    pieceNode.set(info, node);
                    // Hide the node
                    node.setEnabled(false);
                }
            }

            // Fetch model config — texture URIs from the four PBR slots
            // (PLAN-pbr-mapping.md) plus the canonical (server-side)
            // piece array. We need to align our piece indices with the
            // server's, since the piece-state envelope identifies
            // pieces by their JSON-config index.
            const config = await fetchModelConfig(def.modelUrl);

            // Reorder our GLB-traversal pieces array to match the
            // canonical config order. Pieces present in the JSON tree
            // but missing from the GLB (rare; structural-only nodes
            // sometimes get optimised out) get null-mesh placeholders
            // so descendants can still chain their parents correctly.
            let orderedPieces = pieces;
            let orderedNodes: (TransformNode | null)[] | null = null;
            if (config?.pieceNames && config.pieceParents) {
                // The converter emits two parallel views of the piece
                // tree: glTF nodes use unique names (the converter
                // mirrors Recoil's `CAssParser::FindNewPieceName` and
                // appends `_node` / `_node_0` / `_node_1` … to
                // disambiguate duplicates so the file is spec-valid),
                // while `SPRINGRTS_geometry.pieces[]` keeps the
                // original S3O names with duplicates so unit scripts
                // can still reference them.
                //
                // Babylon's glTF loader returns `result.meshes` first
                // then `result.transformNodes`, so `pieces[]` is *not*
                // in the same order as `config.pieceNames[]` (which is
                // depth-first). We can't pair by index — we have to
                // resolve by name. The previous version did a plain
                // name lookup which collapsed every duplicate onto the
                // first matching piece (hoveraa's cabin + rear pads
                // never rendered — the visible "lying-down tower" was
                // a duplicate of the front body that resolved through
                // a `body` lookup).
                //
                // Resolution rule: strip the converter's `_node[_N]`
                // suffix back to the canonical name, then bucket
                // pieces under it. The Nth occurrence of a name in
                // `config.pieceNames` consumes the Nth piece in its
                // canonical bucket.
                const stripSuffix = (n: string): string => {
                    const m1 = n.match(/^(.+)_node_\d+$/);
                    if (m1) return m1[1];
                    const m2 = n.match(/^(.+)_node$/);
                    if (m2) return m2[1];
                    return n;
                };
                const byCanonical = new Map<string, PieceInfo[]>();
                for (const p of pieces) {
                    const canon = stripSuffix(p.name);
                    let arr = byCanonical.get(canon);
                    if (!arr) { arr = []; byCanonical.set(canon, arr); }
                    arr.push(p);
                }
                const nameUsage = new Map<string, number>();
                const ordered: PieceInfo[] = [];
                const orderedSrcNodes: (TransformNode | null)[] = [];
                for (let i = 0; i < config.pieceNames.length; i++) {
                    const name = config.pieceNames[i];
                    const parentIdx = config.pieceParents[i];
                    const arr = byCanonical.get(name);
                    const usage = nameUsage.get(name) ?? 0;
                    nameUsage.set(name, usage + 1);
                    const found = arr && usage < arr.length ? arr[usage] : undefined;
                    if (found) {
                        ordered.push({
                            mesh: found.mesh,
                            name,
                            parentIndex: parentIdx,
                            localMatrix: found.localMatrix,
                            restWorldMatrix: found.restWorldMatrix,
                        });
                        orderedSrcNodes.push(pieceNode.get(found) ?? null);
                    } else {
                        ordered.push({
                            mesh: null!,
                            name,
                            parentIndex: parentIdx,
                            localMatrix: Matrix.Identity(),
                            restWorldMatrix: Matrix.Identity(),
                        });
                        orderedSrcNodes.push(null);
                    }
                }
                orderedNodes = orderedSrcNodes;

                // The GLB hierarchy may not match the JSON config (Assimp
                // can flatten or re-parent during import), so the imported
                // localMatrix isn't reliably local-to-(named-parent).
                // restWorldMatrix *is* reliable though — it's the GLB's
                // node.getWorldMatrix() captured at import. Use that as
                // ground truth and rebuild localMatrix relative to the
                // JSON-config parent: local = world × parent_world⁻¹.
                for (let i = 0; i < ordered.length; i++) {
                    const p = ordered[i];
                    if (p.parentIndex >= 0 && p.parentIndex < ordered.length) {
                        const parentRest = ordered[p.parentIndex].restWorldMatrix;
                        const parentInv = Matrix.Invert(parentRest);
                        ordered[i].localMatrix = p.restWorldMatrix.multiply(parentInv);
                    } else {
                        ordered[i].localMatrix = p.restWorldMatrix.clone();
                    }
                }

                orderedPieces = ordered;
            }

            // PLAN-model-harness task 6: retarget authored clips from glb
            // nodes onto the FINAL piece order, then dispose the imported
            // AnimationGroups — Babylon's glTF loader autoplays the first
            // group by default, which would otherwise tick forever against
            // the detached template nodes.
            const finalNodes: (TransformNode | null)[] = orderedNodes
                ?? pieces.map((p) => pieceNode.get(p) ?? null);
            const clips = extractClips(result.animationGroups ?? [], (target) => {
                const idx = finalNodes.indexOf(target as TransformNode);
                return idx >= 0 ? idx : undefined;
            });
            for (const g of result.animationGroups ?? []) {
                g.stop();
                g.dispose();
            }
            if (clips.length > 0) {
                console.log(`[entity-renderer] ${def.name}: ${clips.length} authored clip(s): `
                    + clips.map((c) => c.name).join(', '));
            }

            // Filter to only pieces with geometry for rendering
            const geometryPieces = orderedPieces.filter(p => p.mesh != null);

            if (geometryPieces.length === 0) {
                console.warn(`[entity-renderer] ${def.name}: glb has no geometry`);
                return null;
            }

            // Compute the model's vertical extent from the rest-pose
            // bounding boxes. Used both to pick yOffset and to size the
            // build-progress scan plane in the shader.
            let bbMinY = Infinity;
            let bbMaxY = -Infinity;
            for (const p of geometryPieces) {
                p.mesh.refreshBoundingInfo();
                const bb = p.mesh.getBoundingInfo().boundingBox;
                const corners = [
                    Vector3.TransformCoordinates(bb.minimum, p.restWorldMatrix),
                    Vector3.TransformCoordinates(bb.maximum, p.restWorldMatrix),
                ];
                for (const c of corners) {
                    if (c.y < bbMinY) bbMinY = c.y;
                    if (c.y > bbMaxY) bbMaxY = c.y;
                }
            }
            const modelHeight = Math.max(1, bbMaxY - bbMinY);

            // Faithful Recoil placement: the model's origin sits at the
            // unit's ground position with NO vertical lift. Recoil authors
            // models feet-at-origin and never re-seats them from a bounding
            // box; the unit's world Y already places the origin on the
            // terrain.
            //
            // The previous `-minY` heuristic lifted "mech-style" models so
            // their AABB bottom met the ground. That AABB comes from the
            // BIND pose, which is unreliable: BAR commanders park decorative
            // pieces (medalsilver/bronze/gold at restY≈-50, crown at -46)
            // far below the body, pulling minY to -66 while the actual body
            // bottom is ≈0. The lift then launched the whole unit ~64 elmos
            // off the ground, detached from its shadow. Removed per user
            // decision 2026-06-19 (CORE directive: reproduce Recoil; don't
            // keep a custom re-seating hack). If a unit now sinks, its model
            // origin is mis-authored / mis-imported — fix that at the import,
            // not with a render-time lift.
            //
            // (bbMinY/bbMaxY are still computed above — `modelHeight` feeds
            // the build-progress scan plane.)
            const yOffset = 0;

            // Load textures (sharing across all teams; team color is
            // applied per-team via the shader uniform). One UnitTextures per
            // glTF material, deduped by diffuse URI so pieces that share a
            // page (or a single-material model) share GPU textures. `textures`
            // stays the model-wide default (materials[0]) used by pieces whose
            // material isn't in the map.
            const texByUri = new Map<string, UnitTextures>();
            const loadCached = (uris: MaterialTextureUris | undefined): UnitTextures | null => {
                if (!uris?.diffuseUri) return null;
                let t = texByUri.get(uris.diffuseUri);
                if (!t) {
                    const nt = loadUnitTextures(uris, def.modelUrl, this.scene);
                    if (!nt) return null;
                    t = nt;
                    texByUri.set(uris.diffuseUri, nt);
                }
                return t;
            };
            const materialTextures = new Map<string, UnitTextures>();
            if (config?.materials) {
                for (const [name, uris] of config.materials) {
                    const t = loadCached(uris);
                    if (t) materialTextures.set(name, t);
                }
            }
            const textures = config ? loadCached(config) : null;

            console.log(
                `[entity-renderer] ${def.name}: model loaded, ` +
                `${geometryPieces.length} piece(s) with geometry, ` +
                `${orderedPieces.length} total nodes, yOffset=${yOffset.toFixed(1)}` +
                (materialTextures.size > 1 ? `, ${materialTextures.size} materials` : '') +
                (config?.diffuseUri  ? `, diffuse=${config.diffuseUri}`   : '') +
                (config?.emissiveUri ? `, emissive=${config.emissiveUri}` : '') +
                (config?.ormUri      ? `, orm=${config.ormUri}`           : '') +
                (config?.teamMaskUri ? `, team=${config.teamMaskUri}`     : '') +
                (config?.pieceNames ? `, aligned to config (${config.pieceNames.length} pieces)` : ''),
            );

            return {
                pieces: orderedPieces, yOffset, modelHeight, textures, materialTextures,
                // Ghost prototypes are built lazily on first request to
                // keep model load lean for defs the player never builds.
                ghostPrototypes: [],
                ghostLocalTransforms: [],
                ghostMaterial: null,
                clips,
            };
        } catch (err) {
            // Babylon raises "Scene has been disposed" when ImportMeshAsync
            // is in-flight while the scene tears down (game exit / lobby
            // restart). Not a content failure — drop silently.
            if (this.scene.isDisposed) return null;
            console.warn(
                `[entity-renderer] ${def.name}: failed to load ${def.modelUrl}`,
                err,
            );
            return null;
        }
    }

    /** Replace the selected-unit id list. Called by InputManager. */
    setSelection(ids: readonly number[]): void {
        this.selectedIds = ids.slice();
    }

    /**
     * Build a fallback Mesh for one (shape, team) pair.
     */
    private buildFallbackMesh(shape: UnitShape, team: number): Mesh {
        const name = `render_fallback_${shape}_${team}`;
        let mesh: Mesh;
        let height: number;
        switch (shape) {
            case UnitShape.Box:
                height = 12;
                mesh = MeshBuilder.CreateBox(name, { width: 16, height, depth: 20 }, this.scene);
                break;
            case UnitShape.Cylinder:
                height = 14;
                mesh = MeshBuilder.CreateCylinder(name, { height, diameter: 18, tessellation: 8 }, this.scene);
                break;
            case UnitShape.Cone:
                height = 16;
                mesh = MeshBuilder.CreateCylinder(name, { height, diameterTop: 0, diameterBottom: 16, tessellation: 8 }, this.scene);
                break;
            case UnitShape.Sphere:
            default:
                height = 14;
                mesh = MeshBuilder.CreateSphere(name, { diameter: 14, segments: 6 }, this.scene);
                break;
        }
        mesh.position.y = height / 2;
        mesh.bakeCurrentTransformIntoVertices();
        mesh.material = this.teamMaterials[team];
        mesh.thinInstanceEnablePicking = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.renderingGroupId = 2;
        mesh.receiveShadows = true;
        this.shadowGenerator?.addShadowCaster(mesh);
        return mesh;
    }

    /**
     * Build (lazily) the per-team radar-blip thin-instance mesh — a
     * small inverted cone (point downwards) sized to read at minimap
     * scale. One mesh per team, shared across every radar contact of
     * that team. Uses the existing team material so the colour matches
     * the player's faction without dragging the team-colour shader in.
     */
    private getOrCreateRadarBlipMesh(team: number): Mesh {
        let mesh = this.radarBlipMeshes.get(team);
        if (mesh) return mesh;
        const teamIdx = team % this.teamMaterials.length;
        const name = `radar_blip_t${team}`;
        mesh = MeshBuilder.CreateCylinder(
            name,
            { height: 18, diameterTop: 0, diameterBottom: 14, tessellation: 6 },
            this.scene,
        );
        // Cone points down (apex at the contact). Lift so the base sits
        // ~18 elmos above the ground for a clear "blip" silhouette.
        mesh.position.y = 18;
        mesh.rotation.x = Math.PI;
        mesh.bakeCurrentTransformIntoVertices();
        mesh.material = this.teamMaterials[teamIdx];
        mesh.thinInstanceEnablePicking = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.renderingGroupId = 2;
        this.radarBlipMeshes.set(team, mesh);
        // Track in renderMeshes so the per-tick activeKeys hide-pass
        // takes care of it when no blips are active that frame.
        this.renderMeshes.set(`radar:${team}`, mesh);
        return mesh;
    }

    /**
     * Get or create the thin-instance render mesh for a specific piece
     * of a specific (defId, team). Clones the template piece mesh.
     */
    private getOrCreatePieceMesh(defId: number, team: number, pieceIdx: number, piece: PieceInfo): Mesh {
        const key = `model:${defId}:${team}:${pieceIdx}`;
        let mesh = this.renderMeshes.get(key);
        if (!mesh) {
            mesh = piece.mesh.clone(`unit_${defId}_t${team}_p${pieceIdx}_${piece.name}`);
            mesh.makeGeometryUnique();

            mesh.material = this.resolvePieceMaterial(defId, team, piece);

            mesh.isPickable = false;
            mesh.isVisible = false;
            mesh.thinInstanceEnablePicking = false;
            mesh.alwaysSelectAsActiveMesh = true;
            mesh.renderingGroupId = 2;
            mesh.receiveShadows = true;
            this.renderMeshes.set(key, mesh);
            this.shadowGenerator?.addShadowCaster(mesh);
        }
        return mesh;
    }

    /**
     * Resolve (and cache) the team-colour material for one model piece. Shared
     * by the per-piece unit render path (getOrCreatePieceMesh) and the squad
     * member-model path (getMemberModel), so a member mesh takes the exact same
     * team tinting + lighting/shadow pipeline as a full unit.
     *
     * Always replaces the imported glTF material with our own team-colour
     * material so every piece gets team tinting regardless of whether the model
     * ships a texture sidecar (skipping the replacement left sidecar-less units
     * — e.g. ZK's `factoryveh` — rendering with the broken imported PBR
     * material). Binds the piece's own material on multi-material models, else
     * the model-wide default; reads the glTF material name LIVE from the
     * template mesh because Babylon's glTF loader often hasn't assigned
     * `mesh.material` at load-time capture but always has by first render.
     * Materials are shared across pieces resolving to the same texture set
     * (keyed by def/team/materialKey) — one PBRMaterial instead of one per piece.
     */
    private resolvePieceMaterial(
        defId: number, team: number, piece: PieceInfo, forMember = false,
    ): Material {
        const tmpl = this.modelTemplates.get(defId);
        const teamColor = TEAM_COLORS[team % TEAM_COLORS.length];
        const customParams = this.defInfos.get(defId)?.customParams;
        const materialKey = piece.mesh?.material?.name ?? piece.materialKey;
        const pieceTextures = (materialKey
            ? tmpl?.materialTextures.get(materialKey) : undefined)
            ?? tmpl?.textures;

        // Member materials are cached separately (they carry DitherFadePlugin,
        // which must never leak onto the shared full-unit material).
        const cache = forMember ? this.memberMaterials : this.unitMaterials;
        const matCacheKey = `${defId}:${team}:${materialKey ?? (pieceTextures ? '_default' : '_fallback')}`;
        let mat = cache.get(matCacheKey);
        if (!mat) {
            const matName = `unit_${defId}_t${team}_${materialKey ?? 'mat'}`;
            if (pieceTextures) {
                mat = createUnitMaterial(
                    matName, pieceTextures, teamColor, this.scene, customParams);
            } else {
                // No texture sidecar — synthesise a white diffuse and mark it
                // syntheticFallback, which flips the team-colour plugin's
                // syntheticAlbedo flag → full team tint, so the piece renders
                // as a flat team-coloured shape rather than flat white.
                const fallbackDiffuse = getWhiteFallbackDiffuse(this.scene);
                mat = createUnitMaterial(
                    matName,
                    { diffuse: fallbackDiffuse, emissive: null, orm: null,
                      teamMask: null, normal: null, invertTeamColor: false,
                      syntheticFallback: true },
                    teamColor, this.scene, customParams,
                );
            }
            // Member material: attach the screen-door LOD crossfade plugin,
            // reading a per-instance `ditherFade` attribute. A no-op at fade=1
            // (the common case); the squad backend drives fade 1→0 only inside
            // the model↔impostor transition band. Pattern polarity is the
            // NON-inverted half — the sprite material takes the inverted half
            // (createImpostorMaterial), so the two tiers interleave exactly
            // rather than overlapping.
            if (forMember) {
                const fade = new DitherFadePlugin(mat);
                fade.useAttribute = true;
                fade.invertPattern = false;
                fade.isEnabled = true;
            }
            cache.set(matCacheKey, mat);
        }
        return mat;
    }

    /**
     * Member-tier 3D model source for the squad fan-out (PLAN-metalstorm-impostors
     * M4). Ensures the def's model is loaded, then returns one thin-instance-ready
     * render mesh PER GEOMETRY PIECE (team-coloured through the same material
     * pipeline as full units) plus the transform data SquadRenderBackend composes
     * each close-range member against. Returns `undefined` while the model is
     * still loading or when the def has no model at all.
     *
     * Multi-piece bodies are supported: infantry are one static `body` piece by
     * the M1 contract, but a squad of vehicles (`ms_tanks_s2` → `fable_tank`:
     * hull / tracks_l / tracks_r / turret / barrel) is not, and gating this on a
     * single piece stranded those defs on the proxy capsule. Each piece becomes
     * its own thin-instance pool, so the cost is per PIECE per (defId, team) —
     * not per member — and pieces are drawn in their rest pose (a member's
     * turret does not aim; see MemberModel in squad-render-backend.ts).
     *
     * The returned meshes are NOT stored in `renderMeshes` (see memberModelMeshes)
     * so the entity render loop never fights the squad backend for them. Each
     * (defId, team, piece) yields one shared mesh; the backend owns its
     * thin-instance matrix buffer.
     */
    getMemberModel(defId: number, team: number): MemberModel | undefined {
        this.ensureModelLoaded(defId);
        const tmpl = this.modelTemplates.get(defId);
        if (!tmpl) return undefined;                       // not loaded yet / no model
        const geometry = tmpl.pieces.filter((p) => p.mesh != null);
        if (geometry.length === 0) return undefined;       // no drawable geometry

        const pieces = geometry.map((piece, i) => {
            const key = `member:${defId}:${team}:${i}`;
            let mesh = this.memberModelMeshes.get(key);
            if (!mesh) {
                mesh = piece.mesh.clone(`member_${defId}_t${team}_p${i}_${piece.name}`);
                mesh.makeGeometryUnique();
                mesh.material = this.resolvePieceMaterial(defId, team, piece, true);
                mesh.isPickable = false;
                mesh.isVisible = false;                    // shown once instances populate
                mesh.thinInstanceEnablePicking = false;
                mesh.alwaysSelectAsActiveMesh = true;
                mesh.renderingGroupId = 2;
                mesh.receiveShadows = true;
                this.memberModelMeshes.set(key, mesh);
                // Cast shadows like full units — one caster mesh with N thin
                // instances (not N casters), so the cost is one extra depth-pass
                // draw per (defId, team, piece), which the M5 perf pass re-checks.
                this.shadowGenerator?.addShadowCaster(mesh);
            }
            return { mesh, restWorld: piece.restWorldMatrix };
        });
        return { pieces, yOffset: tmpl.yOffset, height: tmpl.modelHeight };
    }

    private getFallbackMesh(defId: number, team: number): Mesh {
        const shape = defIdToShape(defId);
        const teamIdx = team % this.teamMaterials.length;
        const key = `shape:${shape}:${teamIdx}`;
        let mesh = this.renderMeshes.get(key);
        if (!mesh) {
            mesh = this.buildFallbackMesh(shape, teamIdx);
            this.renderMeshes.set(key, mesh);
        }
        return mesh;
    }

    /**
     * Build the selection-ring template on first use.
     */
    private ensureSelectionMesh(): Mesh {
        if (this.selectionMesh) return this.selectionMesh;
        const mesh = MeshBuilder.CreateTorus('selection_ring', {
            diameter: 26,
            thickness: 3,
            tessellation: 24,
        }, this.scene);
        mesh.scaling.y = 0.15;
        mesh.bakeCurrentTransformIntoVertices();

        const mat = new StandardMaterial('selectionMat', this.scene);
        mat.diffuseColor = new Color3(0, 0, 0);
        mat.emissiveColor = new Color3(1.0, 0.9, 0.2);
        mat.specularColor = new Color3(0, 0, 0);
        mat.disableLighting = true;
        mesh.material = mat;

        mesh.thinInstanceEnablePicking = false;
        mesh.alwaysSelectAsActiveMesh = true;
        // Ring sits in the same rendering group as units so depth
        // testing hides the half that's behind the unit's geometry.
        // Previously this was group 3 (drawn after units regardless of
        // depth), which made the ring appear floating above the model.
        mesh.renderingGroupId = 2;
        mesh.isVisible = false;
        this.selectionMesh = mesh;
        return mesh;
    }

    private updateSelectionRings(cursorFrame: number): void {
        if (this.selectedIds.length === 0) {
            if (this.selectionMesh) {
                this.selectionMesh.isVisible = false;
                this.selectionMesh.thinInstanceCount = 0;
            }
            return;
        }

        const mesh = this.ensureSelectionMesh();
        const matrices: number[] = [];
        let count = 0;
        const tmp = new Float32Array(16);
        for (const id of this.selectedIds) {
            const p = this.interpolator.getInterpolated(id, cursorFrame);
            if (!p) continue;
            const m = Matrix.Compose(
                new Vector3(1, 1, 1),
                Quaternion.Identity(),
                new Vector3(p.x, p.y + 1.0, p.z),
            );
            m.copyToArray(tmp, 0);
            for (let j = 0; j < 16; j++) matrices.push(tmp[j]);
            count++;
        }

        if (count === 0) {
            mesh.isVisible = false;
            mesh.thinInstanceCount = 0;
            return;
        }

        mesh.isVisible = true;
        const buf = new Float32Array(matrices);
        mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
        mesh.thinInstanceCount = count;
    }

    /**
     * Build the model-space world matrix for every piece in a template,
     * applying server overrides where present. Pieces without an
     * override fall back to their precomputed rest local matrix. The
     * pieces array is in topological order (parent before child) — see
     * loadModel — so a single forward pass suffices.
     *
     * The GLB encodes the Spring→Babylon basis change as a rotation
     * baked into the *root* piece's world matrix — every parent-relative
     * `localMatrix` along the chain stays in Spring-aligned axes, with
     * pure Spring offsets in m[12..14] and rotations about Spring's
     * own X/Y/Z. The chain `local.multiply(parent)` then carries the
     * basis rotation outward and lands the leaf in Babylon coordinates.
     *
     * So overrides convert *directly*: translation = Spring (px,py,pz)
     * unchanged, and rotation = Spring's `T(pos) * RY * RX * RZ`
     * (RZ first, RY last) about the literal axes (1,0,0)/(0,1,0)/(0,0,1).
     */
    private computePieceWorldMatrices(
        tmpl: ModelTemplate,
        overrides: PieceOverrides | null,
        clipPose?: ReadonlyMap<number, Matrix> | null,
        aimPose?: PieceOverrides | null,
        wheelPose?: PieceOverrides | null,
    ): Matrix[] {
        const out = new Array<Matrix>(tmpl.pieces.length);
        for (let i = 0; i < tmpl.pieces.length; i++) {
            const piece = tmpl.pieces[i];
            // §16c merge policy, highest precedence first:
            //   streamed 0x05 (overrides) > aim controller > wheel spin >
            //   authored clip > rest pose. aimPose/wheelPose piece indices
            //   never overlap (turret/barrel vs axleN), so their relative
            //   order doesn't matter in practice.
            // 0x05, aim and wheel are Spring-euler (springToBabylonLocal);
            // the clip pose is already a Babylon parent-relative local matrix.
            let local: Matrix;
            const serverOv = overrides?.get(i);
            const aimOv = aimPose?.get(i);
            const wheelOv = wheelPose?.get(i);
            const clip = clipPose?.get(i);
            if (serverOv) local = this.springToBabylonLocal(serverOv);
            else if (aimOv) local = this.springToBabylonLocal(aimOv);
            else if (wheelOv) local = this.springToBabylonLocal(wheelOv);
            else if (clip) local = clip;
            else local = piece.localMatrix;
            out[i] = piece.parentIndex >= 0
                ? local.multiply(out[piece.parentIndex])
                : local.clone();
        }
        return out;
    }

    /** Build a parent-relative local matrix from a server piece pose. */
    private springToBabylonLocal(ov: {
        px: number; py: number; pz: number;
        rx: number; ry: number; rz: number;
    }): Matrix {
        // Match the server's `RotateEulerYXZ(rot)` in
        // rts/Sim/Units/Scripts/LocalModelPieceStub.h. Spring's LH
        // primitive RotateY(+a) produces a matrix numerically equal to
        // Babylon's RH RotationAxis(Y, -a) — same for X and Z — so the
        // client negates every axis to land on the same world matrix
        // the server uses for emit-dir and weapon spawn math. Without
        // the negation a script-driven `Turn(piece, x_axis, +a)`
        // intended as "pitch down" / "stand leg" renders as the
        // opposite (legs flip up, turrets aim mirrored).
        //
        // Babylon q1.multiply(q2) = q1*q2 applies q2 first then q1, so
        // qY * qX * qZ applies in order qZ → qX → qY (Spring's order).
        const qZ = Quaternion.RotationAxis(new Vector3(0, 0, 1), -ov.rz);
        const qX = Quaternion.RotationAxis(new Vector3(1, 0, 0), -ov.rx);
        const qY = Quaternion.RotationAxis(new Vector3(0, 1, 0), -ov.ry);
        const rot = qY.multiply(qX).multiply(qZ);

        return Matrix.Compose(
            new Vector3(1, 1, 1),
            rot,
            new Vector3(ov.px, ov.py, ov.pz),
        );
    }

    /**
     * Apply a server-streamed piece-state snapshot. Overwrites the per-
     * unit override map so pieces that fell back to rest pose (and so
     * weren't included by the server) automatically clear.
     */
    applyPieceState(snapshot: PieceStateSnapshot): void {
        // Track the units mentioned this snapshot; any unit previously
        // animated but absent here goes back to rest pose.
        const seen = new Set<number>();
        for (const u of snapshot.units) {
            seen.add(u.unitId);
            // The sim owns this unit's pieces — latch it out of cosmetic aim
            // (§16c) for the rest of its life. Latched, not per-snapshot,
            // because a sim turret slewing back to rest drops out of the
            // stream and must not hand control back to the aim controller.
            this.pieceStreamed.add(u.unitId);
            let map = this.pieceOverrides.get(u.unitId);
            if (!map) {
                map = new Map();
                this.pieceOverrides.set(u.unitId, map);
            } else {
                map.clear();
            }
            for (const p of u.pieces) {
                map.set(p.pieceIdx, {
                    px: p.px, py: p.py, pz: p.pz,
                    rx: p.rx, ry: p.ry, rz: p.rz,
                });
            }
        }
        // Clear overrides for units that have animations on file but
        // were left out of this snapshot — those pieces are at rest now.
        for (const id of this.pieceOverrides.keys()) {
            if (!seen.has(id)) this.pieceOverrides.delete(id);
        }
    }

    update(snapshot: EntityStateSnapshot, isDelta: boolean = false): void {
        const { count, entityIds, positionsX, positionsY, positionsZ, headings, health, defIds, teams, buildProgress, pitch, roll, losStates, stateBits } = snapshot;

        // Advance the presentation clock to this snapshot's server frame
        // (once per packet, before per-entity samples). Done before the
        // early-return so empty delta packets still advance the leading edge.
        this.presClock?.observeFrame(snapshot.baseFrame);

        if (!entityIds) return;

        const frame = snapshot.baseFrame;
        // Quanta → radians: server packs angles as i8 with 127 buckets
        // covering [-π/2, π/2]. Pre-compute the inverse scale once.
        const angleScale = 1.5707963267948966 / 127;

        for (let i = 0; i < count; i++) {
            const id = entityIds[i];

            const newLos = losStates ? losStates[i] : 0x0F;
            const inLos = (newLos & LOS_INLOS) !== 0;
            const alwaysVisibleThisFrame = stateBits
                ? (stateBits[i] & STATE_BIT_ALWAYS_VISIBLE) !== 0
                : false;

            // Only push fresh interpolator state when the contact is
            // genuinely in LOS. Radar-only contacts have their position
            // deceived by the server (posErrorVector) and that drift
            // would otherwise feed the interpolator and make the dot
            // wobble. PREVLOS-only buildings get their pose frozen
            // below — we don't want lerping to keep tracking the live
            // server-side position once we've lost LOS on them.
            // alwaysVisible units are streamed at their *true* position
            // by the server (the engine bypasses posErrorVector for
            // them) so the interpolator can consume them safely.
            if (inLos || alwaysVisibleThisFrame) {
                this.interpolator.pushState(
                    id,
                    frame,
                    positionsX ? positionsX[i] : 0,
                    positionsY ? positionsY[i] : 0,
                    positionsZ ? positionsZ[i] : 0,
                    headings ? headings[i] : 0,
                    pitch ? pitch[i] * angleScale : 0,
                    roll  ? roll[i]  * angleScale : 0,
                );
            }

            let meta = this.entityMeta.get(id);
            const isNew = !meta;
            if (!meta) {
                meta = { defId: 0, team: 0, healthScale: 1.0, buildProgress: 1.0, losState: 0x0F, alwaysVisible: false, lastStateFrame: 0 };
                this.entityMeta.set(id, meta);
            }
            // Monotonic — a reordered (late) snapshot must not roll it back.
            if (frame > meta.lastStateFrame) meta.lastStateFrame = frame;
            if (defIds) meta.defId = defIds[i];
            if (teams) meta.team = teams[i];
            if (stateBits) meta.alwaysVisible = (stateBits[i] & STATE_BIT_ALWAYS_VISIBLE) !== 0;
            if (health) meta.healthScale = 0.3 + (health[i] / 65535) * 0.7;
            if (buildProgress) meta.buildProgress = buildProgress[i] / 255;

            const prevLos = isNew ? newLos : meta.losState;
            meta.losState = newLos;

            // Building ghost handling: when a building's LOS flips off
            // and PREVLOS is set, freeze its pose so subsequent ticks
            // keep drawing it where we last saw it (Recoil semantics).
            // When the building re-enters LOS, drop the ghost.
            const wasInLos = (prevLos & LOS_INLOS) !== 0;
            if (wasInLos && !inLos && (newLos & LOS_PREVLOS) !== 0) {
                this.captureGhostPose(id, meta, snapshot, i, angleScale);
            } else if (inLos && this.ghostPoses.has(id)) {
                this.ghostPoses.delete(id);
            }
        }

        if (!isDelta) {
            const seen = new Set<number>();
            for (let i = 0; i < count; i++) seen.add(entityIds[i]);
            for (const id of this.entityMeta.keys()) {
                if (!seen.has(id)) {
                    this.entityMeta.delete(id);
                    this.interpolator.remove(id);
                    this.pieceOverrides.delete(id);
                    // A building destroyed while out of LOS will simply
                    // stop appearing in the snapshot. Drop the ghost too
                    // so we don't leave a phantom forever.
                    this.ghostPoses.delete(id);
                }
            }
        }
    }

    /** Snapshot the unit's current pose for ghost rendering. Called
     *  on the LOS→!LOS transition for PREVLOS buildings. We pull from
     *  the live snapshot rather than the interpolator so we get the
     *  exact server-authoritative last-seen pose, not whatever was
     *  being lerped towards. */
    private captureGhostPose(
        id: number,
        meta: EntityMeta,
        snap: EntityStateSnapshot,
        i: number,
        angleScale: number,
    ): void {
        this.ghostPoses.set(id, {
            x: snap.positionsX ? snap.positionsX[i] : 0,
            y: snap.positionsY ? snap.positionsY[i] : 0,
            z: snap.positionsZ ? snap.positionsZ[i] : 0,
            heading: snap.headings ? snap.headings[i] : 0,
            pitch: snap.pitch ? snap.pitch[i] * angleScale : 0,
            roll: snap.roll ? snap.roll[i] * angleScale : 0,
            defId: meta.defId,
            team: meta.team,
            buildProgress: meta.buildProgress,
        });
    }

    tick(): void {
        // Advance the presentation cursor and snapshot the frame to render at.
        // Before the clock anchors (or if unwired) fall back to the freshest
        // received frame — i.e. render with no display delay.
        this.presClock?.tick();
        const cursorFrame = this.presClock?.isAnchored
            ? this.presClock.P
            : (this.presClock?.newestObservedFrame ?? Number.POSITIVE_INFINITY);
        this.cursorFrame = cursorFrame;

        // Collect per-piece instance matrices.
        // Key: render mesh key → { mesh, matrices[], count }
        const groups = new Map<string, { mesh: Mesh; matrices: number[]; count: number }>();

        for (const [id, meta] of this.entityMeta) {
            // Squad-fan-out defs (client/squads) draw their cosmetic members
            // via the squad adapter, not a single unit mesh here. Skip so the
            // sim body isn't rendered under the soldiers. (Still interpolated
            // + tracked above — the adapter samples getEntityPose(id).)
            if (this.squadDefIds.size && this.squadDefIds.has(meta.defId)) continue;

            // LOS bucket: own units & permissive sessions read 0x0F (all
            // bits set) so the INLOS check passes naturally. Enemy units
            // bucket into in-LOS / radar-blip / ghost / hidden.
            const los = meta.losState;
            const inLos = (los & LOS_INLOS) !== 0;
            const inRadar = (los & LOS_INRADAR) !== 0;
            const prevLos = (los & LOS_PREVLOS) !== 0;
            const isBuilding = this.defIsBuilding.has(meta.defId);

            // Frozen ghost pose for buildings out of LOS but PREVLOS.
            // Render the unit's normal model at the captured pose so
            // players still see what's there. (Polish item: tinted
            // ghost material — see Phase 6 in PLAN-intel.md.)
            const ghost = !inLos && prevLos && isBuilding ? this.ghostPoses.get(id) : undefined;

            // Hide entities with no visibility bits at all (e.g. mobile
            // units that left LOS without entering radar). For permissive
            // sessions losState is 0x0F and this never fires.
            // `alwaysVisible` (state_bits bit 7 — engine landmarks plus
            // Spring.SetUnitAlwaysVisible targets) overrides the hide so
            // the unit stays drawn at the server-streamed pose even when
            // none of the LOS bits are set.
            if (los === 0 && !ghost && !meta.alwaysVisible) continue;

            // Radar-only contact: render a small team-coloured blip
            // instead of the full unit. Skip the model path entirely.
            if (!inLos && !ghost && inRadar) {
                const lerpedR = this.interpolator.getInterpolated(id, cursorFrame);
                if (!lerpedR) continue;
                const groundYR = this.sampleHeight(lerpedR.x, lerpedR.z);
                const blipY = Number.isNaN(groundYR) ? lerpedR.y : groundYR;
                const blipKey = `radar:${meta.team}`;
                let blipGroup = groups.get(blipKey);
                if (!blipGroup) {
                    const mesh = this.getOrCreateRadarBlipMesh(meta.team);
                    blipGroup = { mesh, matrices: [], count: 0 };
                    groups.set(blipKey, blipGroup);
                }
                const matrix = Matrix.Compose(
                    new Vector3(1, 1, 1),
                    Quaternion.Identity(),
                    new Vector3(lerpedR.x, blipY, lerpedR.z),
                );
                const arrR = new Float32Array(16);
                matrix.copyToArray(arrR, 0);
                for (let j = 0; j < 16; j++) blipGroup.matrices.push(arrR[j]);
                blipGroup.count++;
                continue;
            }

            // Normal / ghost render path: pick the source pose. Ghosts
            // use the captured snapshot; live units use the interpolator.
            const lerped = ghost
                ? { x: ghost.x, y: ghost.y, z: ghost.z, heading: ghost.heading,
                    pitch: ghost.pitch, roll: ghost.roll }
                : this.interpolator.getInterpolated(id, cursorFrame);
            if (!lerped) continue;

            // PLAN-metalstorm-beta-units.md §2.1 / engine ask B1: LOD tier
            // decision. Icon tier isn't rendered here at all (strategic map
            // symbol — PLAN-macro-map.md owns that); Impostor tier routes to
            // the billboard renderer instead of the per-piece model path
            // below. No impostorRenderer wired, or no thresholds registered
            // for this def, both fall through to Full (pre-B1 behaviour).
            // TODO(beta-units-crossfade): blend both tiers over 0.3s at the
            // model↔impostor boundary instead of a hard cut (deferred, §7).
            if (this.impostorRenderer) {
                const camPos = this.scene.activeCamera?.position
                    ?? new Vector3(lerped.x, lerped.y, lerped.z);
                const tier = this.impostorRenderer.determineLodTier(
                    meta.defId,
                    new Vector3(lerped.x, lerped.y, lerped.z),
                    camPos,
                    this.forceLodTier ?? undefined,
                );
                if (tier === LodTier.Icon) continue;
                if (tier === LodTier.Impostor) {
                    const groundYI = this.sampleHeight(lerped.x, lerped.z);
                    const yI = Number.isNaN(groundYI) ? lerped.y : Math.max(lerped.y, groundYI);
                    const rotationI = (lerped.heading / 65535) * Math.PI * 2;
                    this.impostorRenderer.addInstance(
                        meta.defId, meta.team, lerped.x, yI, lerped.z, rotationI);
                    continue;
                }
            }

            // Lazy-load: trigger the glb + texture fetch the first
            // time we see an entity of this def. Until the load
            // completes the entity falls through to the procedural
            // shape branch below.
            this.ensureModelLoaded(meta.defId);
            const tmpl = this.modelTemplates.get(meta.defId);

            if (tmpl) {
                // Entity world transform.
                // Re-project Y onto the terrain when the lerped Y is at
                // or below ground level: between 10Hz state snapshots,
                // a unit traversing varied terrain has Y linearly lerped
                // and can drift above (over a valley) or below (over a
                // peak) the actual ground. Clamping to terrain Y for
                // ground-bound units gives a stable contact pose. We
                // leave aircraft alone via the explicit-flying check
                // (lerped Y significantly above terrain).
                const groundY = this.sampleHeight(lerped.x, lerped.z);
                let renderY = lerped.y;
                if (!Number.isNaN(groundY)) {
                    const aboveGround = lerped.y - groundY;
                    // Treat units within ±8 elmos of ground as "on the
                    // surface" — this covers genuine ground vehicles
                    // including those clipping slightly into terrain
                    // due to interpolation, while leaving aircraft
                    // (which fly tens of elmos up) on their streamed Y.
                    if (aboveGround < 8) {
                        renderY = groundY;
                    }
                }
                const rotation = (lerped.heading / 65535) * Math.PI * 2;
                // PLAN-coordinate-system Phase 2d sign convention:
                //
                // Server packs `pitch = asin(frontdir.y)` and
                // `roll = asin(rightdir.y)`. Under the RH server
                // (Phase 2a), frontdir defaults to -Z and rightdir to
                // +X, so positive pitch = nose-up and positive roll =
                // right-side rises (CCW about local Z viewed forward).
                //
                // Babylon's RotationYawPitchRoll in an RH scene (Phase
                // 2d) maps the same convention directly: positive
                // pitch is X-axis rotation that tilts local +Y toward
                // local +Z (= nose-up when forward is local -Z), and
                // positive roll is Z-axis rotation that tilts local
                // +X toward local +Y. No negation needed.
                const entityMatrix = Matrix.Compose(
                    new Vector3(1, 1, 1),
                    Quaternion.RotationYawPitchRoll(rotation, lerped.pitch, lerped.roll),
                    new Vector3(lerped.x, renderY + tmpl.yOffset, lerped.z),
                );

                // Compute per-piece world-in-model matrices. Animated
                // pieces (those with a server override or a dev clip-
                // player pose) replace their rest local matrix; all others
                // reuse the precomputed rest world matrix to avoid the
                // chain walk in the static case.
                const overrides = this.pieceOverrides.get(id) ?? null;
                const clipPose = this.clipPoses.get(id) ?? null;
                const aimPose = this.aimPoses.get(id) ?? null;
                const wheelPose = this.wheelPoses.get(id) ?? null;
                const pieceWorld = (overrides || clipPose || aimPose || wheelPose)
                    ? this.computePieceWorldMatrices(tmpl, overrides, clipPose, aimPose, wheelPose)
                    : null;

                // Push one instance matrix per piece with geometry
                for (let pi = 0; pi < tmpl.pieces.length; pi++) {
                    const piece = tmpl.pieces[pi];
                    if (!piece.mesh) continue; // structural node, no geometry

                    const key = `model:${meta.defId}:${meta.team}:${pi}`;
                    let group = groups.get(key);
                    if (!group) {
                        const mesh = this.getOrCreatePieceMesh(meta.defId, meta.team, pi, piece);
                        group = { mesh, matrices: [], count: 0 };
                        groups.set(key, group);
                    }

                    // Instance matrix = entityWorld × pieceModelWorld
                    // This places piece-local vertices into final world position.
                    const modelWorld = pieceWorld ? pieceWorld[pi] : piece.restWorldMatrix;
                    const instanceMatrix = modelWorld.multiply(entityMatrix);
                    const arr = new Float32Array(16);
                    instanceMatrix.copyToArray(arr, 0);
                    // Keep the matrix a clean affine transform — do NOT
                    // pack groundY / buildProgress into arr[7] / arr[15].
                    // See docs/lighting.md "thin-instance matrix packing
                    // breaks shadow casting".
                    void renderY;
                    for (let j = 0; j < 16; j++) group.matrices.push(arr[j]);
                    group.count++;
                }
            } else {
                // Fallback shape
                const shape = defIdToShape(meta.defId);
                const teamIdx = meta.team % this.teamMaterials.length;
                const key = `shape:${shape}:${teamIdx}`;
                let group = groups.get(key);
                if (!group) {
                    const mesh = this.getFallbackMesh(meta.defId, meta.team);
                    group = { mesh, matrices: [], count: 0 };
                    groups.set(key, group);
                }

                // Same terrain re-projection as the modelled path so
                // procedural-fallback shapes don't float / sink either.
                const groundYf = this.sampleHeight(lerped.x, lerped.z);
                let renderYf = lerped.y;
                if (!Number.isNaN(groundYf) && lerped.y - groundYf < 8) {
                    renderYf = groundYf;
                }
                const rotation = (lerped.heading / 65535) * Math.PI * 2;
                const matrix = Matrix.Compose(
                    new Vector3(1, meta.healthScale, 1),
                    Quaternion.RotationYawPitchRoll(rotation, lerped.pitch, lerped.roll),
                    new Vector3(lerped.x, renderYf, lerped.z),
                );
                const arr = new Float32Array(16);
                matrix.copyToArray(arr, 0);
                for (let j = 0; j < 16; j++) group.matrices.push(arr[j]);
                group.count++;
            }
        }

        // Update render meshes
        const activeKeys = new Set<string>();
        for (const [key, group] of groups) {
            activeKeys.add(key);
            group.mesh.isVisible = true;
            const buf = new Float32Array(group.matrices);
            group.mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
            group.mesh.thinInstanceCount = group.count;
            // Required for the CSM cascade fitter to see where the live
            // instances actually are — see docs/lighting.md "thin-instance
            // bounds".
            group.mesh.thinInstanceRefreshBoundingInfo(false);
        }

        // Hide meshes not active this frame
        for (const [rKey, mesh] of this.renderMeshes) {
            if (!activeKeys.has(rKey)) {
                mesh.isVisible = false;
                mesh.thinInstanceCount = 0;
            }
        }

        this.updateSelectionRings(cursorFrame);
    }

    get entityCount(): number {
        return this.entityMeta.size;
    }

    getEntities(): IterableIterator<[number, EntityMeta]> {
        return this.entityMeta.entries();
    }

    getEntityMeta(id: number): EntityMeta | undefined {
        return this.entityMeta.get(id);
    }

    getEntityPosition(id: number): { x: number; y: number; z: number } | null {
        return this.interpolator.getInterpolated(id, this.cursorFrame);
    }

    /**
     * World-space bounding sphere for one entity — the orbit rig's framing
     * input (PLAN-model-harness §5). `hasModel` doubles as the E1
     * fallback-shape probe: false = def pinned to a procedural shape
     * (model missing), null = model still loading, true = real template.
     *
     * NOTE: the sphere comes from the BIND-pose AABB, which some models
     * pollute with parked decorative pieces (see the yOffset comment in
     * loadModelTemplate) — good enough for framing, not for physics.
     */
    getEntityBounds(id: number): {
        x: number; y: number; z: number; radius: number; hasModel: boolean | null;
    } | null {
        const meta = this.entityMeta.get(id);
        if (!meta) return null;
        const lerped = this.interpolator.getInterpolated(id, this.cursorFrame);
        if (!lerped) return null;
        const tmpl = this.modelTemplates.get(meta.defId);
        const hasModel = tmpl === undefined ? null : tmpl !== null;
        let local = tmpl ? this.modelBoundsFor(meta.defId, tmpl) : null;
        if (!local) {
            // Fallback shape / still loading: def radius around the origin.
            const defR = this.defInfos.get(meta.defId)?.radius ?? 0;
            const r = Math.max(10, defR);
            local = { cx: 0, cy: r * 0.5, cz: 0, radius: r };
        }
        // Rotate the model-space centre offset by the unit heading (yaw
        // only — pitch/roll wobble is negligible for framing).
        const yaw = (lerped.heading / 65535) * Math.PI * 2;
        const cos = Math.cos(yaw), sin = Math.sin(yaw);
        return {
            x: lerped.x + local.cx * cos + local.cz * sin,
            y: lerped.y + (tmpl?.yOffset ?? 0) + local.cy,
            z: lerped.z - local.cx * sin + local.cz * cos,
            radius: local.radius,
            hasModel,
        };
    }

    /**
     * Worker-safe geometry dump — the debug facility the DOM Inspector
     * can't give us for the OffscreenCanvas scene. Lists every loaded
     * model template (or fallback/loading status) with per-piece vertex
     * counts and local-space bounding boxes, so "what geometry does this
     * model actually have" is answerable from the main devtools console:
     *     window.__gp('__entityRenderer.dumpGeometry("fable_colossus")')
     * Omit the name to dump every loaded def. Also console.tables it.
     */
    dumpGeometry(defName?: string): unknown {
        const out: Array<Record<string, unknown>> = [];
        for (const [defId, tmpl] of this.modelTemplates) {
            const info = this.defInfos.get(defId);
            if (defName && info?.name !== defName) continue;
            const status = tmpl === null ? 'FALLBACK (no model)' : 'loaded';
            const pieces = (tmpl?.pieces ?? []).map((p) => {
                const mesh = p.mesh as Mesh | null;
                let bbox: string | null = null;
                let verts = 0;
                if (mesh && mesh.getTotalVertices?.() > 0) {
                    verts = mesh.getTotalVertices();
                    mesh.refreshBoundingInfo();
                    const e = mesh.getBoundingInfo().boundingBox.extendSize;
                    bbox = `${(e.x * 2).toFixed(1)}×${(e.y * 2).toFixed(1)}×${(e.z * 2).toFixed(1)}`;
                }
                return { name: p.name, parent: p.parentIndex, verts, bbox, mat: p.materialKey ?? null };
            });
            const row = {
                def: info?.name ?? `#${defId}`, defId, status,
                pieces: pieces.length,
                geomPieces: pieces.filter((p) => p.verts > 0).length,
                totalVerts: pieces.reduce((s, p) => s + p.verts, 0),
                clips: tmpl?.clips?.map((c) => c.name) ?? [],
                detail: pieces,
            };
            out.push(row);
        }
        for (const defId of this.loadingModels.keys()) {
            const info = this.defInfos.get(defId);
            if (defName && info?.name !== defName) continue;
            if (!this.modelTemplates.has(defId)) {
                out.push({ def: info?.name ?? `#${defId}`, defId, status: 'STILL LOADING', pieces: 0 });
            }
        }
        for (const r of out) {
            console.log(`[model-debug] ${r.def}: ${r.status}, ${r.pieces} pieces `
                + `(${r.geomPieces ?? 0} with geometry), ${r.totalVerts ?? 0} verts`);
            if (Array.isArray(r.detail) && (r.detail as unknown[]).length) console.table(r.detail);
        }
        return out;
    }

    /** Rest-pose AABB of every geometry piece (all 8 corners through
     *  restWorldMatrix — rest matrices can rotate pieces) → centre +
     *  half-diagonal radius. Cached per defId. */
    private modelBoundsFor(defId: number, tmpl: ModelTemplate):
        { cx: number; cy: number; cz: number; radius: number } | null {
        const cached = this.defBoundsCache.get(defId);
        if (cached) return cached;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const corner = new Vector3();
        for (const p of tmpl.pieces) {
            if (!p.mesh) continue;
            const bb = p.mesh.getBoundingInfo().boundingBox;
            const mn = bb.minimum, mx = bb.maximum;
            for (let i = 0; i < 8; i++) {
                corner.set(
                    (i & 1) ? mx.x : mn.x,
                    (i & 2) ? mx.y : mn.y,
                    (i & 4) ? mx.z : mn.z);
                const w = Vector3.TransformCoordinates(corner, p.restWorldMatrix);
                if (w.x < minX) minX = w.x; if (w.x > maxX) maxX = w.x;
                if (w.y < minY) minY = w.y; if (w.y > maxY) maxY = w.y;
                if (w.z < minZ) minZ = w.z; if (w.z > maxZ) maxZ = w.z;
            }
        }
        if (!Number.isFinite(minX)) return null;
        const bounds = {
            cx: (minX + maxX) / 2,
            cy: (minY + maxY) / 2,
            cz: (minZ + maxZ) / 2,
            radius: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
        };
        this.defBoundsCache.set(defId, bounds);
        return bounds;
    }

    /**
     * Resolve the live world-space position of one piece on a unit.
     * Honours both the entity's interpolated position/heading and any
     * server-streamed piece-pose override; pieces missing from the
     * override map use their rest-pose transform. Returns null if the
     * unit has no model template, no interpolated position, or the
     * piece index is out of range.
     *
     * BuildBeamRenderer uses this to anchor nano-spray beams at the
     * builder's actual emitter pieces (NanoPieceCache) instead of the
     * unit's centre — so a hovercraft's two side nozzles emit two
     * beams from the right place rather than one beam from the middle.
     */
    getPieceWorldPosition(
        id: number,
        pieceIdx: number,
    ): { x: number; y: number; z: number } | null {
        const meta = this.entityMeta.get(id);
        if (!meta) return null;
        const tmpl = this.modelTemplates.get(meta.defId);
        if (!tmpl || pieceIdx < 0 || pieceIdx >= tmpl.pieces.length) return null;
        const lerped = this.interpolator.getInterpolated(id, this.cursorFrame);
        if (!lerped) return null;

        const overrides = this.pieceOverrides.get(id) ?? null;
        const clipPose = this.clipPoses.get(id) ?? null;
        const aimPose = this.aimPoses.get(id) ?? null;
        const wheelPose = this.wheelPoses.get(id) ?? null;
        const modelWorld = (overrides || clipPose || aimPose || wheelPose)
            ? this.computePieceWorldMatrices(tmpl, overrides, clipPose, aimPose, wheelPose)[pieceIdx]
            : tmpl.pieces[pieceIdx].restWorldMatrix;

        const rotation = (lerped.heading / 65535) * Math.PI * 2;
        const entityMatrix = Matrix.Compose(
            new Vector3(1, 1, 1),
            Quaternion.RotationYawPitchRoll(rotation, lerped.pitch, lerped.roll),
            new Vector3(lerped.x, lerped.y + tmpl.yOffset, lerped.z),
        );
        const piece = modelWorld.multiply(entityMatrix);
        // Translation lives in row 3 of a row-major Babylon Matrix.
        return { x: piece.m[12], y: piece.m[13], z: piece.m[14] };
    }

    // ── Dev clip player (PLAN-model-harness §2 clip row / task 6) ────────

    /** Authored .glb clip names for a unit's model. null = unknown unit
     *  or template still loading (poll, like entityBounds); [] = model
     *  loaded with no clips (every converted S3O/DAE model today). */
    getClipNames(id: number): string[] | null {
        const meta = this.entityMeta.get(id);
        if (!meta) return null;
        const tmpl = this.modelTemplates.get(meta.defId);
        if (tmpl === undefined) return null; // still loading
        return tmpl ? tmpl.clips.map((c) => c.name) : [];
    }

    /** Def id of a live entity, or undefined once it's unknown (never
     *  streamed, died, evicted). Lets the clip auto-policy reach the def's
     *  speed / customParams without a second entity table. */
    getEntityDefId(id: number): number | undefined {
        return this.entityMeta.get(id)?.defId;
    }

    /** Resolve a piece's index by name (glb node name, e.g. "Turret") for
     *  an entity's model — the lookup a `pieceSpin` FX binding
     *  (fx-bindings.ts, PLAN-fx-offload X4) needs before it can call
     *  setClipPose(). Null when the entity/template is unknown or no piece
     *  with that name exists. */
    getPieceIndex(id: number, pieceName: string): number | null {
        const meta = this.entityMeta.get(id);
        if (!meta) return null;
        const tmpl = this.modelTemplates.get(meta.defId);
        if (!tmpl) return null;
        const idx = tmpl.pieces.findIndex((p) => p.name === pieceName);
        return idx >= 0 ? idx : null;
    }

    /** Rest-pose parent-relative local matrix for every piece in an
     *  entity's model, indexed like setClipPose()'s pose map expects. A
     *  `pieceSpin` binding composes its own spin rotation on top of the
     *  relevant entry rather than starting from identity, so a spinning
     *  wheel keeps its authored offset from the hull instead of snapping
     *  to the origin. Null when the entity/template is unknown. */
    getRestLocalMatrices(id: number): Matrix[] | null {
        const meta = this.entityMeta.get(id);
        if (!meta) return null;
        const tmpl = this.modelTemplates.get(meta.defId);
        if (!tmpl) return null;
        return tmpl.pieces.map((p) => p.localMatrix);
    }

    /** Resolve one authored clip plus the rest-pose local matrices the
     *  ClipPlayer composes unanimated channels from. */
    getClip(id: number, name: string): { clip: ModelClip; restLocals: Matrix[] } | null {
        const meta = this.entityMeta.get(id);
        if (!meta) return null;
        const tmpl = this.modelTemplates.get(meta.defId);
        const clip = tmpl?.clips.find((c) => c.name === name);
        if (!tmpl || !clip) return null;
        return { clip, restLocals: tmpl.pieces.map((p) => p.localMatrix) };
    }

    /** Clip-player pose override: raw Babylon parent-relative local
     *  matrices per piece index, taking precedence over server piece-state
     *  overrides for that unit. Pass null to clear. Returns false when the
     *  unit is unknown (lets the ClipPlayer auto-stop on death/respawn). */
    setClipPose(id: number, pose: ReadonlyMap<number, Matrix> | null): boolean {
        if (pose === null) {
            this.clipPoses.delete(id);
            return true;
        }
        if (!this.entityMeta.has(id)) {
            this.clipPoses.delete(id);
            return false;
        }
        this.clipPoses.set(id, pose);
        return true;
    }

    /** Cosmetic turret-aim pose override (DESIGN-MODEL-BUILDING §16c): a
     *  Spring-euler per-piece pose for the unit's turret/barrel, sitting
     *  below the server's 0x05 stream and above the authored clip in the
     *  per-piece merge. Pass null to clear. Returns false for an unknown
     *  unit so TurretAimController can drop it. */
    setAimPose(id: number, pose: ReadonlyMap<number, {
        px: number; py: number; pz: number;
        rx: number; ry: number; rz: number;
    }> | null): boolean {
        if (pose === null) {
            this.aimPoses.delete(id);
            return true;
        }
        if (!this.entityMeta.has(id)) {
            this.aimPoses.delete(id);
            return false;
        }
        this.aimPoses.set(id, pose as PieceOverrides);
        return true;
    }

    /** Cosmetic wheel-spin pose override (PLAN-metalstorm-train T6): a
     *  Spring-euler per-piece pose for a train car's axle pieces. Separate
     *  channel from setAimPose — see the `wheelPoses` field comment for why
     *  sharing it would clobber a simultaneously-engaged turret. Pass null
     *  to clear. Returns false for an unknown unit. */
    setWheelPose(id: number, pose: ReadonlyMap<number, {
        px: number; py: number; pz: number;
        rx: number; ry: number; rz: number;
    }> | null): boolean {
        if (pose === null) {
            this.wheelPoses.delete(id);
            return true;
        }
        if (!this.entityMeta.has(id)) {
            this.wheelPoses.delete(id);
            return false;
        }
        this.wheelPoses.set(id, pose as PieceOverrides);
        return true;
    }

    /** Live interpolated pose (world position + wire heading u16) for a
     *  unit, or null if it has no held position. Backs TurretAimController's
     *  unit-pose + target-pose sampling. */
    getEntityPose(id: number): { x: number; y: number; z: number; heading: number } | null {
        const p = this.interpolator.getInterpolated(id, this.cursorFrame);
        return p ? { x: p.x, y: p.y, z: p.z, heading: p.heading } : null;
    }

    /** Register a defId as a squad-fan-out def: its entities keep being
     *  interpolated + tracked but stop drawing a single unit mesh (the
     *  Metalstorm squad adapter renders their members instead). Idempotent. */
    markSquadDef(defId: number): void {
        this.squadDefIds.add(defId);
    }

    /** True if `defId` renders via the squad fan-out (see markSquadDef). */
    isSquadDef(defId: number): boolean {
        return this.squadDefIds.has(defId);
    }

    /** Team colour for the squad adapter's cosmetic member material —
     *  same palette the unit meshes use, so soldiers match their vehicles. */
    getTeamColor(team: number): Color3 {
        return TEAM_COLORS[team % TEAM_COLORS.length];
    }

    /** True once the sim has streamed a 0x05 piece-state snapshot for this
     *  unit — the sim owns its pieces, so the cosmetic aim controller
     *  declines it (ZK/BAR turrets, future s4 sim aim). */
    hasPieceStream(id: number): boolean {
        return this.pieceStreamed.has(id);
    }

    /**
     * Resolve the turret (+ optional barrel) pieces of a unit's model for the
     * cosmetic aim controller. Returns null unless the model has a piece
     * named `turret` (case-insensitive). The barrel is the first descendant
     * of the turret whose name reads as a barrel/sleeve/gun. Offsets are the
     * pieces' rest translations in Spring space (localMatrix m[12..14]).
     */
    /** Turret (+ optional barrel) pieces for a unit, one entry per weapon
     *  slot (`turret`, `turret2`, …) — see matchAimSlots for the naming
     *  convention. null when the model has no turret piece at all. Backs
     *  TurretAimController's cosmetic aim (DESIGN-MODEL-BUILDING §16c/§19). */
    getAimPieces(id: number): UnitAimPieces | null {
        const meta = this.entityMeta.get(id);
        if (!meta) return null;
        const tmpl = this.modelTemplates.get(meta.defId);
        if (!tmpl) return null;
        const pieces = tmpl.pieces;
        const matches = matchAimSlots(pieces);
        if (matches.length === 0) return null;
        const offOf = (i: number): AimPiece => {
            const m = pieces[i].localMatrix.m;
            return { idx: i, px: m[12], py: m[13], pz: m[14] };
        };
        return {
            slots: matches.map((m) => ({
                slot: m.slot,
                turret: offOf(m.turretIdx),
                barrel: m.barrelIdx !== undefined ? offOf(m.barrelIdx) : undefined,
            })),
        };
    }

    removeEntity(id: number): void {
        this.entityMeta.delete(id);
        this.interpolator.remove(id);
        this.pieceOverrides.delete(id);
        this.clipPoses.delete(id);
        this.aimPoses.delete(id);
        this.wheelPoses.delete(id);
        this.pieceStreamed.delete(id);
    }

    /**
     * PLAN-quickstart.md §3.2 (Part B — resync): flush all *dynamic* per-entity
     * state while keeping every *static* asset the re-entry would otherwise pay
     * to reload — loaded models (`modelTemplates`), their textures, `defInfos`,
     * team materials and the thin-instance meshes themselves.
     *
     * After a detach the game connection is re-opened against a fresh
     * server-side ClientSession, which delivers a full (non-delta) snapshot.
     * That snapshot reconciles the entity set on its own via `update()`, but the
     * interpolator carries a stale timestamp history across the detach gap and
     * the thin-instance buffers still hold the pre-detach unit poses. Zeroing
     * the derived per-entity state here means the first post-reconnect snapshot
     * repacks instances cleanly from an empty base — no ghosts, no interpolation
     * jump — the documented-correct behaviour for a late/re-join.
     */
    resetForResync(): void {
        this.entityMeta.clear();
        this.interpolator.clear();
        this.ghostPoses.clear();
        this.pieceOverrides.clear();
        this.clipPoses.clear();
        for (const mesh of this.radarBlipMeshes.values()) mesh.thinInstanceCount = 0;
        this.selectedIds = [];
        // Thin-instance buffers are derived from entityMeta and repacked every
        // update(); zero their live counts so nothing renders from the parked
        // session before the first post-reconnect snapshot rebuilds them.
        for (const mesh of this.renderMeshes.values()) mesh.thinInstanceCount = 0;
        if (this.selectionMesh) this.selectionMesh.thinInstanceCount = 0;
    }

    /**
     * Clear PREVLOS ghosts whose tile has come back into LOS.
     *
     * Recoil's ghost-preservation contract: the server only sends an
     * `EntityDestroy` to clients that currently see the unit, so a
     * building killed out of LOS leaves a stale ghost. When the player
     * later scans the spot and finds nothing there, the ghost should
     * auto-clear. This is the "regained LOS" sweep — called whenever a
     * fresh LOS bitmap arrives (~1 Hz). For each ghost we sample the
     * in-LOS plane at its world position; if set, the player has eyes
     * on that tile right now and the server has not re-streamed the
     * building (because it's dead), so the ghost is stale and we drop
     * it.
     *
     * Mapping: bitmap squares cover `mapWidthElmos / bitmap.width`
     * elmos per column. The same column/row indexing used by the
     * widget-worker `Spring.IsPosInLos` and the minimap fog overlay.
     */
    clearGhostsInLos(bitmap: LosBitmap, mapWidthElmos: number, mapHeightElmos: number): void {
        if (this.ghostPoses.size === 0) return;
        const { width, height, inLos } = bitmap;
        if (width === 0 || height === 0) return;
        const toRemove: number[] = [];
        for (const [id, pose] of this.ghostPoses) {
            let col = Math.floor((pose.x / mapWidthElmos) * width);
            let row = Math.floor((pose.z / mapHeightElmos) * height);
            if (col < 0) col = 0; else if (col >= width) col = width - 1;
            if (row < 0) row = 0; else if (row >= height) row = height - 1;
            const idx = row * width + col;
            const byte = idx >> 3;
            const bit = 7 - (idx & 7);
            const inLosNow = (inLos[byte] & (1 << bit)) !== 0;
            if (inLosNow) toRemove.push(id);
        }
        for (const id of toRemove) {
            this.ghostPoses.delete(id);
            // If the meta survived snapshot eviction (server kept
            // streaming it as PREVLOS until the player re-LOSed the
            // spot — but it's actually dead), clear that too so the
            // renderer doesn't try to draw a unit with no template.
            this.entityMeta.delete(id);
            this.interpolator.remove(id);
            this.pieceOverrides.delete(id);
            this.clipPoses.delete(id);
        }
    }

    /** Map dimensions in elmos — derived from the heightmap. Used by
     *  `clearGhostsInLos` to scale ghost positions into bitmap
     *  coordinates. Returns null until `setMapHeightmap` has been
     *  called with the MapData arrival. */
    getMapSizeElmos(): { width: number; height: number } | null {
        if (this.mapHmW === 0 || this.mapHmH === 0) return null;
        return {
            width:  (this.mapHmW - 1) * this.mapSquareSize,
            height: (this.mapHmH - 1) * this.mapSquareSize,
        };
    }

    /**
     * Build a translucent ghost of a unit's model rooted at a TransformNode.
     * Returns null when the model template isn't loaded yet, when no
     * ghost prototypes were built for this def, or when an exception
     * occurs during instance creation. Caller should fall back to a box
     * ghost on null.
     *
     * Implementation: lazy-initialised ghost prototype set per def. The
     * first ghost request for a def builds a single hidden Mesh per
     * piece — geometry-shared with the regular thin-instance prototype
     * but with its own translucent green material. Subsequent ghost
     * requests just create InstancedMeshes off those prototypes, which
     * is cheap (one draw call per piece across all queued ghosts).
     *
     * Used by InputManager for build-placement hover and as a "pending
     * build" marker at queued construction sites until the unit actually
     * starts going up.
     */
    createGhostMesh(defId: number, name: string): TransformNode | null {
        // Build-placement hover queries this every frame the cursor is
        // over a buildable tile — kick off the lazy load so the ghost
        // shape replaces the null fallback as soon as the .glb lands.
        this.ensureModelLoaded(defId);
        const tmpl = this.modelTemplates.get(defId);
        if (!tmpl || tmpl.pieces.length === 0) return null;

        try {
            this.ensureGhostPrototypes(tmpl, defId);
        } catch (err) {
            console.warn(`[entity-renderer] ghost prototype build failed for def ${defId}`, err);
            return null;
        }

        const protos = tmpl.ghostPrototypes;
        const xforms = tmpl.ghostLocalTransforms;
        if (!protos || protos.length === 0) return null;

        const root = new TransformNode(name, this.scene);
        root.position.y = tmpl.yOffset;

        let createdAny = false;
        for (let i = 0; i < protos.length; i++) {
            const proto = protos[i];
            if (!proto) continue;
            try {
                const inst = proto.createInstance(`${name}_p${i}`);
                inst.parent = root;
                inst.isPickable = false;
                inst.isVisible = true;
                inst.renderingGroupId = 2;
                const x = xforms[i];
                inst.position.copyFrom(x.trans);
                inst.rotationQuaternion = x.rot.clone();
                inst.scaling.copyFrom(x.scale);
                inst.alwaysSelectAsActiveMesh = true;
                createdAny = true;
            } catch (err) {
                console.warn(`[entity-renderer] ghost piece ${i} failed`, err);
            }
        }

        if (!createdAny) {
            root.dispose();
            return null;
        }
        return root;
    }

    /** Lazily build the per-def ghost prototype set. Called on first
     *  createGhostMesh for a def; results are cached on the template
     *  for the lifetime of the EntityRenderer (i.e. until quit-to-lobby
     *  triggers a full dispose).
     *
     *  Each prototype is a hidden Mesh that shares geometry with the
     *  regular thin-instance prototype but carries its own translucent
     *  ghost material. Sharing geometry keeps memory flat — the only
     *  per-def cost is one extra Mesh + one Material. */
    private ensureGhostPrototypes(tmpl: ModelTemplate, defId: number): void {
        if (tmpl.ghostPrototypes && tmpl.ghostPrototypes.length > 0) return;

        const ghostMat = new StandardMaterial(`ghost_${defId}_mat`, this.scene);
        ghostMat.diffuseColor = new Color3(0.4, 1.0, 0.5);
        ghostMat.emissiveColor = new Color3(0.15, 0.4, 0.2);
        ghostMat.specularColor = new Color3(0, 0, 0);
        ghostMat.alpha = 0.45;
        ghostMat.backFaceCulling = false;
        ghostMat.disableLighting = false;

        const protos: (Mesh | null)[] = [];
        const xforms: { trans: Vector3; rot: Quaternion; scale: Vector3 }[] = [];

        for (let i = 0; i < tmpl.pieces.length; i++) {
            const piece = tmpl.pieces[i];
            if (!piece.mesh || !piece.mesh.getTotalVertices()) {
                protos.push(null);
                xforms.push({ trans: new Vector3(), rot: new Quaternion(), scale: new Vector3(1, 1, 1) });
                continue;
            }

            const proto = new Mesh(`ghost_${defId}_p${i}`, this.scene);
            // Share geometry with the regular prototype. Babylon binds
            // the geometry attributes lazily during the first render, so
            // sharing has no upfront cost. Thin-instance buffers live on
            // the source mesh, not the geometry — so even though both
            // meshes touch the same vertex buffer, only the original
            // does instanced rendering with thin-instance attributes.
            piece.mesh.geometry?.applyToMesh(proto);
            proto.material = ghostMat;
            proto.isVisible = false;             // source-only, never drawn directly
            proto.isPickable = false;
            proto.alwaysSelectAsActiveMesh = true;
            proto.renderingGroupId = 2;
            proto.parent = null;
            protos.push(proto);

            const scale = new Vector3();
            const rot = new Quaternion();
            const trans = new Vector3();
            piece.restWorldMatrix.decompose(scale, rot, trans);
            xforms.push({ trans, rot, scale });
        }

        tmpl.ghostPrototypes = protos;
        tmpl.ghostLocalTransforms = xforms;
        tmpl.ghostMaterial = ghostMat;
    }

    dispose(): void {
        for (const mesh of this.renderMeshes.values()) mesh.dispose();
        this.renderMeshes.clear();
        // Member-tier meshes (M4) share the unit material cache (freed below)
        // but own their cloned geometry — dispose them here since the render
        // loop never tracks them. SquadRenderBackend borrows these and must
        // NOT dispose them itself.
        for (const mesh of this.memberModelMeshes.values()) mesh.dispose();
        this.memberModelMeshes.clear();
        // Shared unit materials are owned here (mesh.dispose() doesn't free
        // them), so dispose them explicitly. NOT their textures — those are
        // the shared template textures, disposed by the template loop below.
        // (The 1×1 white fallback diffuse is per-scene, not per-template —
        // it dies with the scene via WHITE_TEX_CACHE's WeakMap.)
        for (const mat of this.unitMaterials.values()) mat.dispose();
        this.unitMaterials.clear();
        for (const mat of this.memberMaterials.values()) mat.dispose();
        this.memberMaterials.clear();
        for (const tmpl of this.modelTemplates.values()) {
            if (tmpl) {
                for (const p of tmpl.pieces) {
                    if (p.mesh) p.mesh.dispose();
                }
                // Dispose every texture the template loaded: the model-wide
                // default set AND the per-material sets (multi-material
                // models). The two can share UnitTextures objects (deduped
                // by diffuse URI at load), so collect unique sets first —
                // Texture.dispose() is idempotent, but no point relying on it.
                const texSets = new Set<UnitTextures>();
                if (tmpl.textures) texSets.add(tmpl.textures);
                for (const t of tmpl.materialTextures.values()) texSets.add(t);
                for (const t of texSets) {
                    t.diffuse.dispose();
                    t.emissive?.dispose();
                    t.orm?.dispose();
                    t.teamMask?.dispose();
                    t.normal?.dispose();
                }
                for (const proto of tmpl.ghostPrototypes) {
                    if (proto) proto.dispose();
                }
                tmpl.ghostMaterial?.dispose();
            }
        }
        this.modelTemplates.clear();
        this.defInfos.clear();
        this.loadingModels.clear();
        if (this.selectionMesh) {
            this.selectionMesh.dispose();
            this.selectionMesh = null;
        }
        this.selectedIds = [];
        this.entityMeta.clear();
        this.ghostPoses.clear();
        this.pieceOverrides.clear();
        this.clipPoses.clear();
        this.aimPoses.clear();
        this.wheelPoses.clear();
        this.pieceStreamed.clear();
        this.radarBlipMeshes.clear();
        this.defIsBuilding.clear();
        this.interpolator.clear();
        for (const mat of this.teamMaterials) mat.dispose();
    }
}
