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
    ShaderMaterial,
    Effect,
    Color3,
    BoundingInfo,
    SceneLoader,
    Texture,
    RawTexture,
    Engine,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
// KTX2 loader is registered in main.ts (the app entry). All unit
// textures resolve to `.ktx2` URIs after the texture pipeline migration.
import type { EntityStateSnapshot } from './entity-state.js';
import { EntityInterpolator } from './entity-interpolator.js';
import type { UnitDefInfo } from './connection.js';
import type { PieceStateSnapshot } from './piece-state.js';
import type { LosBitmap } from './los-bitmap.js';
import { stampUrl } from '../config.js';
import { loadDirManifest, dirOfUrl } from './dir-manifest.js';

/** Parsed model config — sourced from the .gltf's
 *  `extensions.SPRINGRTS_geometry` block plus the PBR material slots
 *  (PLAN-pbr-mapping.md). A hand-authored `<stem>.config.lua` sidecar
 *  can override `invertteamcolor`; the rest is fully machine-
 *  generated and authoritative from the .gltf. */
interface ModelConfig {
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
    invertTeamColor: boolean;
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
        const r = await fetch(stampUrl(modelUrl));
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

    const mat = gltf?.materials?.[0];
    const diffuseUri  = resolveTextureUri(mat?.pbrMetallicRoughness?.baseColorTexture?.index);
    const emissiveUri = resolveTextureUri(mat?.emissiveTexture?.index);
    const ormUri      = resolveTextureUri(mat?.pbrMetallicRoughness?.metallicRoughnessTexture?.index);
    const teamMaskUri = resolveTextureUri(mat?.extensions?.SPRINGRTS_team_color?.maskTexture?.index);
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
        diffuseUri, emissiveUri, ormUri, teamMaskUri, invertteamcolor,
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

// ─── Team color shader ───
// PLAN-pbr-mapping.md splits Spring's two source textures across four
// spec-compliant glTF PBR slots so a third-party viewer renders units
// correctly out of the box. The runtime composites the four textures
// here:
//   diffuseTex.rgb  → base color (RGB pass-through from S3O tex1)
//   diffuseTex.a    → binary cutout (MASK alphaMode, 0.5 threshold)
//   emissiveTex.rgb → grayscale self-illumination (S3O tex2.R replicated)
//   ormTex.g        → roughness (255 - S3O tex2.G, specular inverted)
//   ormTex.b        → metallic   (S3O tex2.B reflectivity)
//   teamMaskTex.r   → team-color blend amount (raw S3O tex1.A)
// `invertMask` flips the team-mask interpretation at sample time so
// the same encoded image works for both authoring conventions.
//
// Uses Babylon's instancesDeclaration/instancesVertex includes for
// thin-instance support.

// Nanoframe is encoded inline in the team-color shader so we don't
// duplicate the per-piece pipeline. Two per-instance values ride along
// in the 4x4 thin-instance matrix's normally-zero W row:
//   m33 (column 3, row 3) = buildProgress (0..1, 1=finished)
//   m31 (column 1, row 3) = groundY        (entity foot world Y)
// Affine transforms always have m30=m31=m32=0 / m33=1, so packing
// values there only corrupts wp.w — which we discard before projection.
const TEAMCOLOR_VERTEX = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec2 uv;

    #include<instancesDeclaration>

    uniform mat4 viewProjection;

    varying vec2 vUV;
    varying vec3 vNormal;
    varying float vBuildProgress;
    varying float vAboveGround;

    void main() {
        #include<instancesVertex>

        vBuildProgress = finalWorld[3][3];
        float groundY  = finalWorld[1][3];

        vec4 wp = finalWorld * vec4(position, 1.0);
        vAboveGround = wp.y - groundY;
        vNormal = normalize(mat3(finalWorld) * normal);
        vUV = uv;
        // wp.w is corrupted by our packed values — rebuild as homogeneous 1.
        gl_Position = viewProjection * vec4(wp.xyz, 1.0);
    }
`;

const TEAMCOLOR_FRAGMENT = `
    precision highp float;
    uniform sampler2D diffuseTex;
    uniform sampler2D emissiveTex;
    uniform sampler2D ormTex;
    uniform sampler2D teamMaskTex;
    uniform vec3 teamColor;
    uniform float invertMask;
    uniform vec3 lightDir;
    uniform float modelHeight;
    // Each of these is 1.0 when the matching texture was bound, 0.0
    // when the unit def shipped without one. Unbound samplers still
    // resolve in WebGL — they hit a 1×1 default — so we route around
    // them explicitly to keep the result well-defined.
    uniform float hasEmissive;
    uniform float hasOrm;
    uniform float hasTeamMask;

    varying vec2 vUV;
    varying vec3 vNormal;
    varying float vBuildProgress;
    varying float vAboveGround;

    void main() {
        vec4 base = texture2D(diffuseTex, vUV);
        // glTF MASK alphaMode (PLAN-pbr-mapping.md): the channel-split
        // pipeline binarises diffuse.A at the 0.5 threshold so an
        // alpha < 0.5 fragment is genuinely cut out (tank-wheel windows,
        // fan blades). Without the discard the cutout silhouette
        // collapses to a solid rectangle in third-party viewers.
        if (base.a < 0.5) discard;

        // Team-color mask now lives in a dedicated R8 KTX2 (teamMaskTex.r)
        // rather than the diffuse alpha channel — so cutout and team
        // tinting don't compete for the same bits. Defaults to 0 (no
        // team color) for unit defs that don't supply a mask texture.
        float mask = hasTeamMask > 0.5 ? texture2D(teamMaskTex, vUV).r : 0.0;
        if (invertMask > 0.5) mask = 1.0 - mask;
        vec3 color = mix(base.rgb, teamColor * base.rgb, mask);

        // Half-Lambert + hemispheric ambient. Plain N·L Lambert (with a
        // flat ambient floor) leaves the side faces of tall, thin units
        // — radar masts, the Lotus turret spire — sitting at the
        // minimum 40% term whenever the camera is far enough away that
        // their bright top face has shrunk to a few pixels. Half-Lambert
        // shifts the diffuse range from [0..1] to [0.5..1] so dark
        // sides keep some shape, and a small upward sky-tint lifts the
        // floor for upward-facing surfaces without crushing downward
        // ones. The combined output ranges roughly 0.55–1.05 so well-
        // lit faces stay visibly brighter than poorly-lit ones.
        float halfLambert = dot(vNormal, lightDir) * 0.5 + 0.5;
        float skyTint     = vNormal.y * 0.5 + 0.5;
        vec3  lit         = color * (0.45 + 0.55 * halfLambert + 0.05 * skyTint);

        // PBR-ish specular driven by ORM.G (roughness) and ORM.B
        // (metallic). Pure dielectric: spec base = 4% albedo-neutral;
        // metallic interp tints toward the albedo (standard PBR
        // convention). Shininess maps roughness to a Blinn-Phong
        // exponent so a model with roughness=1 (the modelimporter
        // default when tex2 is absent or its G channel is zero) gets
        // no highlight — matching how those legacy units rendered
        // before PBR mapping.
        if (hasOrm > 0.5) {
            vec2  mr        = texture2D(ormTex, vUV).gb;
            float roughness = mr.x;
            float metallic  = mr.y;
            vec3  specBase  = mix(vec3(0.04), color, metallic);
            float shininess = mix(8.0, 128.0, 1.0 - roughness);
            float specTerm  = pow(halfLambert, shininess) * (1.0 - roughness);
            lit += specBase * specTerm;
        }

        // Additive self-illumination from S3O tex2.R (replicated to
        // grayscale RGB by the encoder). Most ZK units have no glow
        // regions and ship a black emissive map; the encoder/Zstd pair
        // compresses that to a few hundred bytes per file.
        if (hasEmissive > 0.5) {
            lit += texture2D(emissiveTex, vUV).rgb;
        }

        // Nanoframe pass — only active during construction. Below the
        // rising plane the model is fully lit; above it we cut a
        // checkerboard stipple so the unfinished portion reads as
        // "ghosted" without using alpha blending (which would force
        // the whole material into Babylon's transparent pass and break
        // depth ordering between pieces). A bright scan band sits at
        // the plane to sell the "construction in progress" look.
        if (vBuildProgress < 1.0) {
            float planeY = vBuildProgress * max(modelHeight, 1.0);
            if (vAboveGround > planeY) {
                // Checkerboard discard — 50% coverage keeps the unit's
                // silhouette readable from a distance while still
                // looking visibly under-construction up close.
                vec2 px = floor(gl_FragCoord.xy);
                if (mod(px.x + px.y, 2.0) < 1.0) discard;
                // Tint the surviving pixels toward the team color so
                // the ghosted region looks like an active build site.
                lit = mix(lit, teamColor * 0.7, 0.6);
            }
            // 3-elmo-wide gaussian glow centred at the plane.
            float bandIntensity = exp(-pow((vAboveGround - planeY) / 2.0, 2.0)) * 1.5;
            lit += teamColor * bandIntensity;
        }
        gl_FragColor = vec4(lit, 1.0);
    }
`;

// Register the shader once
Effect.ShadersStore['teamColorVertexShader'] = TEAMCOLOR_VERTEX;
Effect.ShadersStore['teamColorFragmentShader'] = TEAMCOLOR_FRAGMENT;

/// 1×1 RGBA(255,255,255,255) fallback diffuse for models without a
/// texture sidecar. Cached per-scene so every textureless piece shares
/// the same GPU resource. Alpha=255 → fully team-coloured in the shader,
/// matching the previous "flat team-coloured shape" fallback behaviour.
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
 * Create a team-color material for a unit piece. Samples team mask from
 * a dedicated `teamMaskTex.R` channel (PLAN-pbr-mapping.md split layout).
 * Supports thin instances via Babylon's instancesDeclaration/instancesVertex
 * includes. Emissive / ORM bindings are optional and default to "no
 * contribution" via the `hasEmissive` / `hasOrm` boolean uniforms.
 */
function createTeamColorMaterial(
    name: string,
    textures: UnitTextures,
    teamColor: Color3,
    modelHeight: number,
    scene: Scene,
): ShaderMaterial {
    const mat = new ShaderMaterial(name, scene, 'teamColor', {
        attributes: ['position', 'normal', 'uv'],
        uniforms: ['world', 'viewProjection', 'teamColor',
                   'invertMask', 'lightDir', 'modelHeight',
                   'hasEmissive', 'hasOrm', 'hasTeamMask'],
        samplers: ['diffuseTex', 'emissiveTex', 'ormTex', 'teamMaskTex'],
        defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
    });

    mat.setTexture('diffuseTex',  textures.diffuse);
    // Bind every sampler slot even when the actual texture is absent
    // — WebGL doesn't allow unbound samplers in a draw call. Reuse the
    // diffuse as a harmless placeholder; the `hasEmissive`/`hasOrm`/
    // `hasTeamMask` flags gate sampling on the shader side.
    mat.setTexture('emissiveTex', textures.emissive ?? textures.diffuse);
    mat.setTexture('ormTex',      textures.orm      ?? textures.diffuse);
    mat.setTexture('teamMaskTex', textures.teamMask ?? textures.diffuse);
    mat.setColor3('teamColor', teamColor);
    mat.setVector3('lightDir', new Vector3(-0.5, 1.0, 0.3).normalize());
    mat.setFloat('modelHeight', modelHeight);
    mat.setFloat('invertMask', textures.invertTeamColor ? 1.0 : 0.0);
    mat.setFloat('hasEmissive', textures.emissive ? 1.0 : 0.0);
    mat.setFloat('hasOrm',      textures.orm      ? 1.0 : 0.0);
    mat.setFloat('hasTeamMask', textures.teamMask ? 1.0 : 0.0);

    // Keep the material fully opaque. The build-progress effect uses
    // discard-based stipple in the fragment shader instead of alpha
    // blending — alpha < 1 would push the material into Babylon's
    // transparent pass, sort pieces back-to-front per camera, and
    // skip depth writes, which produces the per-orbit "texture shift"
    // artefacts we hit when this was set to 0.999.
    mat.alpha = 1.0;
    mat.needAlphaBlending = () => false;
    mat.needAlphaTesting  = () => true;

    // Disable backface culling: modelimporter (Assimp + S3O) emits
    // glTF with CCW winding but Babylon's default is CW, so culling
    // strips the visible surfaces and we end up rendering the inside
    // of each piece. Two-sided is cheap on these low-poly meshes and
    // matches the original Spring renderer's behaviour.
    mat.backFaceCulling = false;
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
    config: ModelConfig,
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
        invertTeamColor: config.invertteamcolor ?? false,
    };
}

// Spring engine's 10 default team colors (from TeamBase::teamDefaultColor).
const TEAM_COLORS = [
    new Color3(90/255, 90/255, 255/255),   // blue
    new Color3(200/255, 0/255, 0/255),     // red
    new Color3(255/255, 255/255, 255/255), // white
    new Color3(38/255, 155/255, 32/255),   // green
    new Color3(7/255, 31/255, 125/255),    // dark blue
    new Color3(150/255, 10/255, 180/255),  // purple
    new Color3(255/255, 255/255, 0/255),   // yellow
    new Color3(50/255, 50/255, 50/255),    // black
    new Color3(152/255, 200/255, 220/255), // light blue
    new Color3(171/255, 171/255, 131/255), // tan
];

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
}

/** Loaded model template for a unit def. */
interface ModelTemplate {
    pieces: PieceInfo[];
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
}

/** Per-piece thin-instance render mesh, keyed by (defId, team, pieceIdx). */
interface PieceRenderEntry {
    mesh: Mesh;
    pieceIdx: number;
}

export class EntityRenderer {
    private scene: Scene;
    private interpolator = new EntityInterpolator();
    private entityMeta = new Map<number, EntityMeta>();
    private teamMaterials: StandardMaterial[] = [];
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
    private modelsReady: Promise<void> = Promise.resolve();
    private defModelUrls = new Map<number, string>();
    /** Per-defId building flag from UnitDefInfo.flags bit 12. Drives the
     *  ghost-building behaviour: only buildings get PREVLOS frozen-pose
     *  rendering; mobile units in PREVLOS just disappear once they leave
     *  radar (mirrors Recoil). */
    private defIsBuilding = new Set<number>();

    // --- Render meshes ---
    // Per-piece thin-instance meshes, keyed by "model:{defId}:{team}:{pieceIdx}"
    // or "shape:{shape}:{team}" for fallbacks.
    private renderMeshes = new Map<string, Mesh>();

    // --- Per-entity piece pose overrides ---
    // Populated by applyPieceState() from server-streamed piece transforms.
    // Pieces missing from a unit's override map render at rest pose.
    private pieceOverrides = new Map<number, PieceOverrides>();

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

    constructor(scene: Scene) {
        this.scene = scene;

        for (let i = 0; i < TEAM_COLORS.length; i++) {
            const mat = new StandardMaterial(`team${i}Mat`, scene);
            mat.diffuseColor = TEAM_COLORS[i];
            mat.specularColor = new Color3(0.3, 0.3, 0.3);
            this.teamMaterials.push(mat);
        }
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
     * Register unit defs and start loading their models.
     */
    setUnitDefs(defs: UnitDefInfo[]): void {
        const loadPromises: Promise<void>[] = [];
        let loaded = 0;
        let skipped = 0;
        let alreadyKnown = 0;

        for (const def of defs) {
            if (this.defModelUrls.has(def.defId)) {
                alreadyKnown++;
                continue;
            }

            this.defModelUrls.set(def.defId, def.modelUrl);
            if ((def.flags & UDF_FLAG_IS_BUILDING) !== 0) {
                this.defIsBuilding.add(def.defId);
            }

            if (!def.modelUrl) {
                this.modelTemplates.set(def.defId, null);
                skipped++;
                continue;
            }

            loadPromises.push(this.loadModel(def).then(tmpl => {
                this.modelTemplates.set(def.defId, tmpl);
                if (tmpl) loaded++;
                else skipped++;
            }));
        }

        if (loadPromises.length > 0 || skipped > 0) {
            const batchReady = Promise.all(loadPromises).then(() => {
                console.log(
                    `[entity-renderer] defs batch: ${loaded} loaded, ${skipped} fallback` +
                    (alreadyKnown > 0 ? `, ${alreadyKnown} already known` : '')
                );
            });
            this.modelsReady = this.modelsReady.then(() => batchReady);
        }
    }

    private async loadModel(def: UnitDefInfo): Promise<ModelTemplate | null> {
        try {
            const lastSlash = def.modelUrl.lastIndexOf('/');
            const baseUrl = def.modelUrl.substring(0, lastSlash + 1);
            const fileName = def.modelUrl.substring(lastSlash + 1);

            const result = await SceneLoader.ImportMeshAsync(
                '', baseUrl, stampUrl(fileName), this.scene,
            );

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
                    // Detach from hierarchy, keep vertices in piece-local space
                    mesh.parent = null;
                    mesh.position.set(0, 0, 0);
                    mesh.rotationQuaternion = Quaternion.Identity();
                    mesh.scaling.set(1, 1, 1);
                    mesh.isPickable = false;
                    mesh.isVisible = false;
                    mesh.thinInstanceEnablePicking = false;
                    mesh.alwaysSelectAsActiveMesh = true;
                    mesh.setBoundingInfo(new BoundingInfo(
                        new Vector3(-1e6, -1e6, -1e6),
                        new Vector3(1e6, 1e6, 1e6),
                    ));
                    mesh.renderingGroupId = 2;

                    pieces.push({
                        mesh,
                        name: node.name,
                        parentIndex,
                        localMatrix,
                        restWorldMatrix,
                    });
                } else {
                    // Structural node (no geometry) — still needed for
                    // hierarchy chain. Use a dummy mesh reference.
                    pieces.push({
                        mesh: null!,
                        name: node.name,
                        parentIndex,
                        localMatrix,
                        restWorldMatrix,
                    });
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
            if (config?.pieceNames && config.pieceParents) {
                const byName = new Map<string, PieceInfo>();
                for (const p of pieces) byName.set(p.name, p);

                const ordered: PieceInfo[] = [];
                for (let i = 0; i < config.pieceNames.length; i++) {
                    const name = config.pieceNames[i];
                    const parentIdx = config.pieceParents[i];
                    const found = byName.get(name);
                    if (found) {
                        ordered.push({
                            mesh: found.mesh,
                            name,
                            parentIndex: parentIdx,
                            localMatrix: found.localMatrix,
                            restWorldMatrix: found.restWorldMatrix,
                        });
                    } else {
                        ordered.push({
                            mesh: null!,
                            name,
                            parentIndex: parentIdx,
                            localMatrix: Matrix.Identity(),
                            restWorldMatrix: Matrix.Identity(),
                        });
                    }
                }

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

            // Pick yOffset based on Spring's authored model conventions.
            //
            // Authors use one of two origin styles:
            //   A. Origin at physical base (typical for tall structures —
            //      windmills, radars, factories). Often these have parts
            //      that extend BELOW origin (foundations) which the
            //      original engine relies on terrain to occlude. midpos.y
            //      sits well above origin (in the body of the structure).
            //      → render with no shift; trust terrain to clip the
            //         foundation.
            //   B. Origin near the visual centre / waist (typical for
            //      humanoid mechs and walking units). midpos.y sits
            //      near zero or below. The model's "feet" live well
            //      below origin and would sink into the ground if drawn
            //      unshifted.
            //      → shift up by -minY so the feet land at ground level.
            //
            // The midpos.y signal cleanly separates the two: structures
            // have midpos high up in their body, mechs have it near the
            // unit's centre-of-mass which is close to origin.
            const minY = config?.minY ?? bbMinY;
            const maxY = config?.maxY ?? bbMaxY;
            const midY = config?.midY;
            // Two structure flavours sit at origin and must NOT be shifted
            // up by -minY (terrain occludes whatever sticks below):
            //   1. Tall structures with body above origin and a small
            //      foundation below. midpos.y sits high in the body.
            //      e.g. radar: midY=+21, height=143, only -50 below.
            //   2. Drill-style structures with a tiny cap above origin
            //      and a long shaft buried below. midpos.y is way below
            //      origin — the original heuristic mis-classified these
            //      as mechs and rocketed the foundation skyward.
            //      e.g. Mex: midY=-113, maxY=+8, minY=-234, height=243
            //      (the "posts" foundation 234 elmos below was rendered
            //      as four giant red columns towering over the surface).
            // baseAtOrigin catches both: midY high in the model OR maxY
            // is a small fraction of modelHeight (drill cap).
            const baseAtOrigin =
                (midY !== undefined && midY > modelHeight * 0.1) ||
                maxY < modelHeight * 0.15;
            const yOffset = baseAtOrigin ? 0 : Math.max(0, -minY);

            // Load textures (sharing across all teams; team color is
            // applied per-team via the shader uniform).
            const textures = config ? loadUnitTextures(config, def.modelUrl, this.scene) : null;

            console.log(
                `[entity-renderer] ${def.name}: model loaded, ` +
                `${geometryPieces.length} piece(s) with geometry, ` +
                `${orderedPieces.length} total nodes, yOffset=${yOffset.toFixed(1)}` +
                (config?.diffuseUri  ? `, diffuse=${config.diffuseUri}`   : '') +
                (config?.emissiveUri ? `, emissive=${config.emissiveUri}` : '') +
                (config?.ormUri      ? `, orm=${config.ormUri}`           : '') +
                (config?.teamMaskUri ? `, team=${config.teamMaskUri}`     : '') +
                (config?.pieceNames ? `, aligned to config (${config.pieceNames.length} pieces)` : ''),
            );

            return {
                pieces: orderedPieces, yOffset, modelHeight, textures,
                // Ghost prototypes are built lazily on first request to
                // keep model load lean for defs the player never builds.
                ghostPrototypes: [],
                ghostLocalTransforms: [],
                ghostMaterial: null,
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
        mesh.setBoundingInfo(new BoundingInfo(
            new Vector3(-1e6, -1e6, -1e6),
            new Vector3(1e6, 1e6, 1e6),
        ));
        mesh.renderingGroupId = 2;
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
        mesh.setBoundingInfo(new BoundingInfo(
            new Vector3(-1e6, -1e6, -1e6),
            new Vector3(1e6, 1e6, 1e6),
        ));
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

            const tmpl = this.modelTemplates.get(defId);
            const teamColor = TEAM_COLORS[team % TEAM_COLORS.length];
            const matName = `unit_${defId}_t${team}_p${pieceIdx}_mat`;

            // Always use the team-color shader. The thin-instance world
            // matrix packs groundY into m31 and buildProgress into m33
            // (see TEAMCOLOR_VERTEX comment). Babylon's default GPU
            // pipeline divides by the corrupted wp.w during projection
            // and renders the geometry as long streaks; only the
            // teamColor shader knows to reconstruct gl_Position from
            // wp.xyz alone. Skipping the replacement (the previous
            // `else if (!mesh.material)` branch) left units without a
            // texture sidecar — e.g. ZK's `factoryveh` — keeping the
            // PBR material from the glTF import and rendering broken.
            if (tmpl?.textures) {
                mesh.material = createTeamColorMaterial(
                    matName, tmpl.textures, teamColor, tmpl.modelHeight, this.scene);
            } else {
                // No texture sidecar — synthesise a white diffuse with
                // alpha=1 so the unit renders as a flat team-coloured
                // shape through the same shader as textured units.
                const fallbackDiffuse = getWhiteFallbackDiffuse(this.scene);
                mesh.material = createTeamColorMaterial(
                    matName,
                    { diffuse: fallbackDiffuse, emissive: null, orm: null,
                      teamMask: null, invertTeamColor: false },
                    teamColor,
                    tmpl?.modelHeight ?? 1,
                    this.scene,
                );
            }

            mesh.isPickable = false;
            mesh.isVisible = false;
            mesh.thinInstanceEnablePicking = false;
            mesh.alwaysSelectAsActiveMesh = true;
            mesh.setBoundingInfo(new BoundingInfo(
                new Vector3(-1e6, -1e6, -1e6),
                new Vector3(1e6, 1e6, 1e6),
            ));
            mesh.renderingGroupId = 2;
            this.renderMeshes.set(key, mesh);
        }
        return mesh;
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
        mesh.setBoundingInfo(new BoundingInfo(
            new Vector3(-1e6, -1e6, -1e6),
            new Vector3(1e6, 1e6, 1e6),
        ));
        // Ring sits in the same rendering group as units so depth
        // testing hides the half that's behind the unit's geometry.
        // Previously this was group 3 (drawn after units regardless of
        // depth), which made the ring appear floating above the model.
        mesh.renderingGroupId = 2;
        mesh.isVisible = false;
        this.selectionMesh = mesh;
        return mesh;
    }

    private updateSelectionRings(now: number): void {
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
            const p = this.interpolator.getInterpolated(id, now);
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
        overrides: PieceOverrides,
    ): Matrix[] {
        const out = new Array<Matrix>(tmpl.pieces.length);
        for (let i = 0; i < tmpl.pieces.length; i++) {
            const piece = tmpl.pieces[i];
            const ov = overrides.get(i);
            const local = ov
                ? this.springToBabylonLocal(ov)
                : piece.localMatrix;
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
        // PLAN-coordinate-system Phase 2d: mirror the server-side
        // RotateEulerYXZ(rot.x, rot.y, -rot.z) from
        // rts/Sim/Units/Scripts/LocalModelPieceStub.h. Under RH, the
        // X/Y axes pass through with their author sign and only Z
        // keeps the legacy negation (rotation about the piece's
        // forward axis is invariant to the world handedness flip).
        //
        // Babylon q1.multiply(q2) = q1*q2 applies q2 first then q1, so
        // qY * qX * qZ applies in order qZ → qX → qY (Spring's order).
        const qZ = Quaternion.RotationAxis(new Vector3(0, 0, 1), -ov.rz);
        const qX = Quaternion.RotationAxis(new Vector3(1, 0, 0), ov.rx);
        const qY = Quaternion.RotationAxis(new Vector3(0, 1, 0), ov.ry);
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
        if (!entityIds) return;

        const now = performance.now();
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
                    positionsX ? positionsX[i] : 0,
                    positionsY ? positionsY[i] : 0,
                    positionsZ ? positionsZ[i] : 0,
                    headings ? headings[i] : 0,
                    now,
                    pitch ? pitch[i] * angleScale : 0,
                    roll  ? roll[i]  * angleScale : 0,
                );
            }

            let meta = this.entityMeta.get(id);
            const isNew = !meta;
            if (!meta) {
                meta = { defId: 0, team: 0, healthScale: 1.0, buildProgress: 1.0, losState: 0x0F, alwaysVisible: false };
                this.entityMeta.set(id, meta);
            }
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
        const now = performance.now();

        // Collect per-piece instance matrices.
        // Key: render mesh key → { mesh, matrices[], count }
        const groups = new Map<string, { mesh: Mesh; matrices: number[]; count: number }>();

        for (const [id, meta] of this.entityMeta) {
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
                const lerpedR = this.interpolator.getInterpolated(id, now);
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
                : this.interpolator.getInterpolated(id, now);
            if (!lerped) continue;

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
                // pieces (those with a server override) replace their
                // rest local matrix with T(pos) * R(rot); all others
                // reuse the precomputed rest world matrix to avoid the
                // chain walk in the static case.
                const overrides = this.pieceOverrides.get(id);
                const pieceWorld = overrides
                    ? this.computePieceWorldMatrices(tmpl, overrides)
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
                    // Pack nanoframe inputs into the matrix's normally-zero
                    // row 3 entries — see TEAMCOLOR_VERTEX comment. These
                    // corrupt wp.w but the shader rebuilds the projection
                    // input from wp.xyz so xyz transforms stay correct.
                    arr[7] = renderY;             // m31 → groundY (entity foot Y)
                    arr[15] = meta.buildProgress; // m33 → buildProgress
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
        }

        // Hide meshes not active this frame
        for (const [rKey, mesh] of this.renderMeshes) {
            if (!activeKeys.has(rKey)) {
                mesh.isVisible = false;
                mesh.thinInstanceCount = 0;
            }
        }

        this.updateSelectionRings(now);
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
        return this.interpolator.getInterpolated(id);
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
        const lerped = this.interpolator.getInterpolated(id);
        if (!lerped) return null;

        const overrides = this.pieceOverrides.get(id);
        const modelWorld = overrides
            ? this.computePieceWorldMatrices(tmpl, overrides)[pieceIdx]
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

    removeEntity(id: number): void {
        this.entityMeta.delete(id);
        this.interpolator.remove(id);
        this.pieceOverrides.delete(id);
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
        for (const tmpl of this.modelTemplates.values()) {
            if (tmpl) {
                for (const p of tmpl.pieces) {
                    if (p.mesh) p.mesh.dispose();
                }
                if (tmpl.textures) {
                    tmpl.textures.diffuse.dispose();
                    tmpl.textures.emissive?.dispose();
                    tmpl.textures.orm?.dispose();
                    tmpl.textures.teamMask?.dispose();
                }
                for (const proto of tmpl.ghostPrototypes) {
                    if (proto) proto.dispose();
                }
                tmpl.ghostMaterial?.dispose();
            }
        }
        this.modelTemplates.clear();
        if (this.selectionMesh) {
            this.selectionMesh.dispose();
            this.selectionMesh = null;
        }
        this.selectedIds = [];
        this.entityMeta.clear();
        this.ghostPoses.clear();
        this.radarBlipMeshes.clear();
        this.defIsBuilding.clear();
        this.interpolator.clear();
        for (const mat of this.teamMaterials) mat.dispose();
    }
}
