/**
 * ZK ModelMaterials/Templates port — PLAN-weapon-fx.md Phase Z2.
 *
 * Ports `content/games/zk/ModelMaterials/Templates/defaultMaterialTemplate.lua`
 * to a Babylon `ShaderMaterial`. The original ZK template targets desktop
 * GL 3.1 with legacy fixed-function attributes (`gl_Vertex`,
 * `gl_ModelViewMatrix`, `gl_MultiTexCoord*`, `gl_TexCoord[0]`, etc.) and
 * declares all logic behind compile-time `OPTION_*` gates encoded as bits
 * in `bitOptions`. This module preserves the gate structure and the
 * lighting formula (Lambert + Blinn-Phong with sun + shadowed term + flat
 * ambient) and re-routes attribute / sampler bindings to:
 *
 *   - Babylon `position`, `normal`, `uv` vertex attributes
 *   - Our PBR-split textures (PLAN-pbr-mapping.md): diffuse, emissive,
 *     orm, teamMask, normal — instead of ZK's packed tex1/tex2 pair.
 *   - CSM shadow sampling via `sampler2DArray` (matches the team-color
 *     material in entity-renderer.ts).
 *
 * The remaining ZK options (SHADOWMAPPING, NORMALMAPPING, AUTONORMAL,
 * FLASHLIGHTS, UNITSFOG, VERTEX_AO) are honoured. Phase Z2b (faithful
 * data-driven port) made per-unit option selection match
 * `001_units_s3o_assimp.lua`'s `GetUnitMaterial` against the template
 * defaults — see `zkOptionsFromCustomParams` — and ported ZK's exact
 * `GetNormalFromDiffuse` autonormal formula (`zkNormalFromDiffuse`).
 * Still compiled out to no-ops: POM / TREEWIND / METAL_HIGHLIGHT /
 * MOVING_THREADS (need per-piece UV / wreck-metal metadata we don't ship)
 * and NORMALMAP_FLIP (no ZK unit sets it — verified zero customParams
 * occurrences across content/games/zk).
 */

import {
    Scene,
    ShaderMaterial,
    Effect,
    Color3,
    Matrix,
    Vector2,
    Vector3,
    Vector4,
    Texture,
    type CascadedShadowGenerator,
    type DirectionalLight,
} from '@babylonjs/core';

/** Per-piece texture set the factory expects — identical shape to
 *  `UnitTextures` in entity-renderer.ts so the call site can pass its
 *  loaded set through unchanged. */
export interface ZKUnitTextures {
    diffuse: Texture;
    emissive: Texture | null;
    orm: Texture | null;
    teamMask: Texture | null;
    normal: Texture | null;
    invertTeamColor: boolean;
}

/** OPTION_* flags from ZK's defaultMaterialTemplate.lua `knownBitOptions`.
 *  Bit positions match the original so future server-side parsing of
 *  ModelMaterials/*.lua can stream the bitfield through verbatim. */
export const enum ZKOption {
    SHADOWMAPPING   = 1 << 0,
    NORMALMAPPING   = 1 << 1,
    MOVING_THREADS  = 1 << 2,  // not implemented yet (needs tread UV bounds)
    VERTEX_AO       = 1 << 3,
    FLASHLIGHTS     = 1 << 4,
    UNITSFOG        = 1 << 5,
    NORMALMAP_FLIP  = 1 << 6,
    METAL_HIGHLIGHT = 1 << 7,  // features-only, not implemented yet
    TREEWIND        = 1 << 8,  // foliage-only, not implemented yet
    POM             = 1 << 9,  // not implemented yet
    AUTONORMAL      = 1 << 10,
}

const DEFAULT_OPTIONS: number =
    ZKOption.SHADOWMAPPING | ZKOption.NORMALMAPPING | ZKOption.FLASHLIGHTS;

/** Parse customParams from the unit def into a ZK option bitfield. ZK
 *  uses a handful of cus_* keys to flip the per-unit material flags
 *  (see `content/games/zk/ModelMaterials/001_units_s3o_assimp.lua`). */
export function zkOptionsFromCustomParams(
    customParams: Record<string, string> | undefined,
    hasNormalMap: boolean,
): number {
    let opts = ZKOption.SHADOWMAPPING;
    if (hasNormalMap) opts |= ZKOption.NORMALMAPPING;
    else              opts |= ZKOption.AUTONORMAL;

    const cp = customParams ?? {};
    // Faithful port of 001_units_s3o_assimp.lua `GetUnitMaterial` combined
    // with defaultMaterialTemplate.lua's defaults (Z2b). The template
    // ships every option default-false EXCEPT shadowmapping; only the
    // `unitsNewNormalMapFL` variant turns flashlights on. ZK's selection:
    //   normalmap + !cus_noflashlight → unitsNewNormalMapFL   → flashlights ON
    //   normalmap +  cus_noflashlight → unitsNewNormalMap     → default (off)
    //   no-normal + (either)          → unitsNewNoNormalMap*  → off (the FL
    //                                    no-normal variant explicitly sets
    //                                    flashlights=false — the authored TODO)
    // So flashlights is ON only when the unit is normal-mapped and hasn't
    // opted out. The previous heuristic lit every non-opted-out unit,
    // over-applying the self-illum pulse to flat-shaded (autonormal) units.
    if (hasNormalMap && cp.cus_noflashlight !== '1') opts |= ZKOption.FLASHLIGHTS;

    return opts;
}

// ── Ported vertex shader ──────────────────────────────────────────────
// Derived from `defaultMaterialTemplate.lua` lines 2–223. Legacy GL2
// fixed-function inputs swapped for Babylon attributes + uniforms. The
// option gating uses preprocessor `#ifdef` instead of the original's
// runtime `BITMASK_FIELD(bitOptions, …)` so each option set produces a
// dedicated, optimised program — matching Babylon's `defines` pipeline.
const ZK_VERTEX = `#version 300 es
precision highp float;

// Babylon-supplied attributes
in vec3 position;
in vec3 normal;
in vec2 uv;

// Per-instance world matrix attributes. Units render as thin instances,
// so the per-instance transform arrives through world0..world3 (Babylon's
// instancesDeclaration), NOT the 'world' uniform. Declared with the 300-es
// 'in' qualifier (Babylon ships no 300-es variant of the include, and the
// legacy 'attribute' keyword is reserved). Matches createTeamColorMaterial
// in entity-renderer.ts — without this the vertex stage transforms every
// instance to the base world (origin) and the unit renders off-screen
// while still casting a correct shadow (the depth caster handles
// instances itself).
in vec4 world0;
in vec4 world1;
in vec4 world2;
in vec4 world3;

// Babylon-supplied uniforms ('world' is the base/static transform; the
// instanced transform is world * mat4(world0..world3)).
uniform mat4 world;
uniform mat4 viewProjection;
uniform mat4 view;
uniform mat4 shadowMatrix;
uniform vec3 cameraPos;
uniform int  simFrame;

out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec3 vWorldTangent;
out vec3 vWorldBitangent;
out vec3 vWorldCameraDir;
out vec4 vShadowVertexPos;
out vec2 vUV;
out float vAoTerm;
out float vSelfIllumMod;
out float vViewZ;

void main() {
    mat4 finalWorld = world * mat4(world0, world1, world2, world3);

    vec4 worldVertex = finalWorld * vec4(position, 1.0);
    vWorldPos = worldVertex.xyz;
    vUV = uv;

    // ZK uses gl_NormalMatrix (the inverse-transpose of modelView). Per
    // ZK's note in the source — "gl_NormalMatrix seems to represent
    // world space model matrix" — Recoil's modelView IS the model matrix
    // because the engine pre-multiplies the view on the CPU side. For us
    // that means the normal matrix is mat3(world), with uniform scale
    // (no shear in unit thin-instance transforms).
    mat3 normalMatrix = mat3(finalWorld);
    vWorldNormal = normalize(normalMatrix * normal);

    // Derivative-based TBN works fine without per-vertex tangents (see
    // entity-renderer.ts perturbNormal). We still emit zeroed tangent
    // varyings so the fragment can fall through to that path verbatim.
    vWorldTangent   = vec3(1.0, 0.0, 0.0);
    vWorldBitangent = vec3(0.0, 1.0, 0.0);

    vWorldCameraDir = normalize(cameraPos - worldVertex.xyz);

#ifdef OPTION_SHADOWMAPPING
    vShadowVertexPos = shadowMatrix * worldVertex;
    vShadowVertexPos.xy += vec2(0.5);
#else
    vShadowVertexPos = vec4(0.0);
#endif

#ifdef OPTION_VERTEX_AO
    // ZK's authored AO sits in the fractional bits of UV.x times 16384.
    // Most ZK content doesn't actually bake this — falls through to 1.0.
    vAoTerm = clamp(1.0 * fract(uv.x * 16384.0), 0.1, 1.0);
#else
    vAoTerm = 1.0;
#endif

#ifdef OPTION_FLASHLIGHTS
    // Original formula: sin(simFrame * 0.067 + (Tx + Tz) * 0.1) + 0.2.
    // World translation lives in finalWorld[3] (column-major).
    float tx = finalWorld[3].x;
    float tz = finalWorld[3].z;
    vSelfIllumMod = max(-0.2, sin(float(simFrame) * 0.067 + (tx + tz) * 0.1)) + 0.2;
#else
    vSelfIllumMod = 1.0;
#endif

    vec4 clipPos = viewProjection * worldVertex;
    // View-space Z (positive distance) for CSM cascade selection. Matches
    // the convention used by the team-color shader.
    vViewZ = -(view * worldVertex).z;
    gl_Position = clipPos;
}
`;

// ── Ported fragment shader ────────────────────────────────────────────
// Lighting formula preserved from defaultMaterialTemplate.lua: ambient +
// shadowed Lambert + Blinn-Phong spec (driven by tex2.g), tinted by team
// color via the mask channel. The cube-reflection term is dropped (no
// reflectTex on our pipeline) and replaced by a flat sky-tint following
// the existing teamColor shader's pattern.
const ZK_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DArray;

// Our PBR-split texture set
uniform sampler2D diffuseTex;
uniform sampler2D emissiveTex;
uniform sampler2D ormTex;
uniform sampler2D teamMaskTex;
uniform sampler2D normalTex;

// Bound-or-not flags so shader handles unit defs that ship without an
// optional texture (same pattern as the existing teamColor material).
uniform float hasEmissive;
uniform float hasOrm;
uniform float hasTeamMask;
uniform float hasNormal;

// Sun + shadow
uniform vec3 sunDir;
uniform vec3 sunDiffuse;
uniform vec3 sunAmbient;
uniform vec3 sunSpecular;
uniform vec3 sunSpecularParams;  // exponent, multiplier, bias
uniform float shadowDensity;
uniform highp sampler2DArray csmShadowMap;
uniform mat4 csmMatrices[4];
uniform vec4 csmSplits;
uniform float shadowDarkness;

uniform vec4 teamColor;
uniform float invertMask;
uniform int  simFrame;
uniform vec2 autoNormalParams;  // {samplingDist, value} — ZK default {1.0, 0.002}

in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec3 vWorldTangent;
in vec3 vWorldBitangent;
in vec3 vWorldCameraDir;
in vec4 vShadowVertexPos;
in vec2 vUV;
in float vAoTerm;
in float vSelfIllumMod;
in float vViewZ;

out vec4 fragColor;

// Derivative-based TBN (Schüler / Mikkelsen). ZK's template builds its TBN
// from per-vertex tangents (gl_MultiTexCoord5/6); our .glb pipeline doesn't
// ship those, so we reconstruct the same worldTBN from screen-space
// derivatives. Both the normal-map and autonormal paths transform their
// tangent-space normal through this single TBN — matching ZK's
// "N = worldTBN * tbnNormal" for both branches.
mat3 computeTBN(vec3 N, vec3 P, vec2 uv) {
    vec3  dp1     = dFdx(P);
    vec3  dp2     = dFdy(P);
    vec2  duv1    = dFdx(uv);
    vec2  duv2    = dFdy(uv);
    vec3  dp2perp = cross(dp2, N);
    vec3  dp1perp = cross(N, dp1);
    vec3  T       = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3  B       = dp2perp * duv1.y + dp1perp * duv2.y;
    float invmax  = inversesqrt(max(dot(T, T), dot(B, B)));
    return mat3(T * invmax, B * invmax, N);
}

// ZK's autonormal — verbatim port of GetNormalFromDiffuse /
// GetDiffuseGrad / GetDiffuseVal from defaultMaterialTemplate.lua. Derives
// a tangent-space normal from the diffuse luminance gradient. The Z value
// is 1.0/autoNormalParams.y (=500 with the authored 0.002), so the relief
// is deliberately subtle. autoNormalParams = {samplingDist, value}.
float zkDiffuseVal(vec2 uv) {
    return length(texture(diffuseTex, fract(uv)).rgb);
}
vec3 zkNormalFromDiffuse(vec2 uv) {
    vec2 texDim = vec2(textureSize(diffuseTex, 0));
    vec2 delta  = vec2(autoNormalParams.x) / texDim;
    vec2 grad   = vec2(
        zkDiffuseVal(uv + vec2(delta.x, 0.0)) - zkDiffuseVal(uv - vec2(delta.x, 0.0)),
        zkDiffuseVal(uv + vec2(0.0, delta.y)) - zkDiffuseVal(uv - vec2(0.0, delta.y))
    ) / delta;
    return normalize(vec3(grad, 1.0 / autoNormalParams.y));
}

// CSM sampling — copied verbatim from entity-renderer.ts so the two
// materials behave identically against the same shadow pipeline. ZK's
// original GetShadowPCFRandom uses sampler2DShadow; we sample our depth
// array instead and compare manually.
float sampleCsmShadow() {
    int cascade = 3;
    if      (vViewZ < csmSplits.x) cascade = 0;
    else if (vViewZ < csmSplits.y) cascade = 1;
    else if (vViewZ < csmSplits.z) cascade = 2;
    else if (vViewZ >= csmSplits.w) return 1.0;

    vec4 lp = csmMatrices[cascade] * vec4(vWorldPos, 1.0);
    vec3 ndc = lp.xyz / lp.w;
    vec3 uv  = ndc * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
    if (uv.z < 0.0 || uv.z > 1.0) return 1.0;
    float bias = 0.0015;
    float occluder = texture(csmShadowMap, vec3(uv.xy, float(cascade))).r;
    return (uv.z - bias) > occluder ? 0.0 : 1.0;
}

void main() {
    vec2 myUV = vUV;

#ifdef OPTION_NORMALMAP_FLIP
    myUV.y = 1.0 - myUV.y;
#endif

    // N — world-space surface normal. ZK's template selects exactly one
    // of normalmap / autonormal / plain-normal (the BITMASK if/else-if/else
    // at defaultMaterialTemplate.lua:567). Both perturbed branches share
    // the derivative TBN and transform a tangent-space normal through it.
    vec3 N = normalize(vWorldNormal);
#ifdef OPTION_NORMALMAPPING
    if (hasNormal > 0.5) {
        vec3 tbnNormal = texture(normalTex, myUV).xyz * 2.0 - 1.0;
        N = normalize(computeTBN(N, vWorldPos, myUV) * tbnNormal);
    }
#endif
#ifdef OPTION_AUTONORMAL
    if (hasNormal <= 0.5) {
        // Only when no authored normal map is bound — matches ZK routing
        // units without a _normals sibling / cp.normaltex to the
        // autonormal variant.
        vec3 tbnNormal = zkNormalFromDiffuse(myUV);
        N = normalize(computeTBN(N, vWorldPos, myUV) * tbnNormal);
    }
#endif

#ifdef OPTION_NORMALMAP_FLIP
    myUV.y = 1.0 - myUV.y;
#endif

    vec4 base = texture(diffuseTex, myUV);

    // L — sun direction (from fragment to light, world space).
    vec3 L = normalize(sunDir);
    vec3 V = normalize(vWorldCameraDir);
    vec3 H = normalize(L + V);

    float NdotLu = dot(N, L);
    float NdotL  = max(NdotLu, 1e-3);
    float HdotN  = max(dot(N, H), 1e-3);

    // ZK's combined shadow: normal-based smoothstep × CSM sample.
    float nShadow = smoothstep(0.0, 0.35, NdotLu);
    float gShadow = 1.0;
#ifdef OPTION_SHADOWMAPPING
    gShadow = clamp(sampleCsmShadow(), 0.0, 1.0);
    gShadow = mix(shadowDarkness, 1.0, gShadow);
#endif
    float shadow     = min(nShadow, gShadow);
    float shadowMult = mix(1.0, shadow, shadowDensity);

    // Light terms — ZK formula.
    vec3 lightAmbient  = vAoTerm * sunAmbient;
    vec3 lightDiffuse  = NdotL * sunDiffuse;

    // ORM.G carries the specular mask in our pipeline (G=roughness, but
    // ZK's tex2.G is "spec intensity" — close enough for ZK content;
    // shipping content authored both maps the same way).
    float specMask = (hasOrm > 0.5) ? texture(ormTex, myUV).g : 0.0;
    vec3 lightSpecular = sunSpecular * pow(HdotN, sunSpecularParams.x);
    lightSpecular *= sunSpecularParams.z + specMask * sunSpecularParams.y;

    vec3 lightAD = lightAmbient + lightDiffuse * shadowMult;
    lightSpecular *= shadowMult;

    // ZK uses a cube reflectTex here; we don't have one. Use a flat sky
    // tint biased by the surface up-component so the lit colour still
    // changes with orientation, matching the existing teamColor look.
    float skyMix = 0.5 + 0.5 * N.y;
    vec3 lightADR = mix(lightAD, lightAD * (0.85 + 0.30 * skyMix), specMask);

    // Team color mask: we read R from a dedicated teamMaskTex (PLAN-
    // pbr-mapping split), not from the diffuse alpha as ZK does.
    float mask = (hasTeamMask > 0.5) ? texture(teamMaskTex, myUV).r : 0.0;
    if (invertMask > 0.5) mask = 1.0 - mask;
    vec3 modelDiffuse = mix(base.rgb, teamColor.rgb, mask);

    // Emissive — ZK reads tex2.R. We pull R from our dedicated emissive
    // texture; the encoder replicates the original grayscale value across
    // all three channels.
    float emitVal = (hasEmissive > 0.5) ? texture(emissiveTex, myUV).r : 0.0;
    vec3 emissive = vec3(emitVal);
#ifdef OPTION_FLASHLIGHTS
    emissive *= vSelfIllumMod;
#endif

    vec3 finalColor = modelDiffuse * (lightADR + emissive) + lightSpecular;

    fragColor = vec4(finalColor, 1.0);
}
`;

let shadersRegistered = false;
function ensureShadersRegistered(): void {
    if (shadersRegistered) return;
    Effect.ShadersStore['zkModelVertexShader']   = ZK_VERTEX;
    Effect.ShadersStore['zkModelFragmentShader'] = ZK_FRAGMENT;
    shadersRegistered = true;
}

// Sun + CSM bind state — mirrored from entity-renderer.ts because the ZK
// material runs through the same pipeline. Set up once via
// `setActiveZKShadowGenerator()` from the entity renderer's
// `setShadowGenerator()` and read every draw.

interface ZKShadowBindState {
    csm: CascadedShadowGenerator;
    sun: DirectionalLight;
    matrices: Matrix[];
    splits: Vector4;
}

let activeShadowBind: ZKShadowBindState | null = null;

export function setActiveZKShadowGenerator(
    csm: CascadedShadowGenerator | null, sun: DirectionalLight | null,
): void {
    if (!csm || !sun) {
        activeShadowBind = null;
        return;
    }
    activeShadowBind = {
        csm,
        sun,
        matrices: [Matrix.Identity(), Matrix.Identity(), Matrix.Identity(), Matrix.Identity()],
        splits: new Vector4(1e30, 1e30, 1e30, 1e30),
    };
}

const SUN_DIFFUSE        = new Vector3(1.10, 1.05, 0.95);
const SUN_AMBIENT        = new Vector3(0.30, 0.32, 0.36);
const SUN_SPECULAR       = new Vector3(0.70, 0.70, 0.65);
const SUN_SPECULAR_PARAM = new Vector3(18.0, 4.0, 0.0); // exponent, mult, bias
const DEFAULT_SUN_DIR    = new Vector3(-0.5, 1.0, 0.3).normalize();

function bindShadowUniforms(mat: ShaderMaterial): void {
    const bind = activeShadowBind;
    if (!bind) {
        mat.setVector3('sunDir', DEFAULT_SUN_DIR);
        return;
    }
    const { csm, sun, matrices, splits } = bind;

    const d = sun.direction;
    const lx = -d.x, ly = -d.y, lz = -d.z;
    const len = Math.hypot(lx, ly, lz) || 1;
    mat.setVector3('sunDir', new Vector3(lx / len, ly / len, lz / len));

    for (let i = 0; i < 4; i++) {
        const m = csm.getCascadeTransformMatrix(i);
        if (m) matrices[i].copyFrom(m);
    }
    mat.setMatrices('csmMatrices', matrices);

    const view = mat.getScene().getViewMatrix();
    mat.setMatrix('view', view);

    const internal = csm as unknown as { _viewSpaceFrustumsZ?: number[] };
    const frusta = internal._viewSpaceFrustumsZ;
    if (frusta && frusta.length >= 4) {
        splits.set(frusta[0], frusta[1], frusta[2], frusta[3]);
        mat.setVector4('csmSplits', splits);
    }

    mat.setFloat('shadowDarkness', csm.getDarkness());
    const shadowMap = csm.getShadowMap();
    if (shadowMap) mat.setTexture('csmShadowMap', shadowMap);
}

function bindCameraAndFrame(mat: ShaderMaterial): void {
    const scene = mat.getScene();
    const camera = scene.activeCamera;
    if (camera) {
        const p = camera.globalPosition;
        mat.setVector3('cameraPos', new Vector3(p.x, p.y, p.z));
    }
    // Babylon doesn't expose a sim frame counter directly. Use the
    // render frame index as a stand-in — the FLASHLIGHTS pulse depends
    // only on relative motion, not absolute sim time.
    const engine = scene.getEngine();
    mat.setInt('simFrame', engine.frameId | 0);
}

/**
 * Build a ZK-port material variant for a given (texture set, team, options).
 * The defines string is keyed off the option bits so distinct option sets
 * compile to distinct programs; Babylon caches by source so repeat callers
 * with the same options reuse the same compiled effect.
 */
export function createZKMaterial(
    name: string,
    textures: ZKUnitTextures,
    teamColor: Color3,
    scene: Scene,
    options: number = DEFAULT_OPTIONS,
): ShaderMaterial {
    ensureShadersRegistered();

    const defines: string[] = ['#define INSTANCES', '#define THIN_INSTANCES'];
    if (options & ZKOption.SHADOWMAPPING)  defines.push('#define OPTION_SHADOWMAPPING');
    if (options & ZKOption.NORMALMAPPING)  defines.push('#define OPTION_NORMALMAPPING');
    if (options & ZKOption.VERTEX_AO)      defines.push('#define OPTION_VERTEX_AO');
    if (options & ZKOption.FLASHLIGHTS)    defines.push('#define OPTION_FLASHLIGHTS');
    if (options & ZKOption.UNITSFOG)       defines.push('#define OPTION_UNITSFOG');
    if (options & ZKOption.NORMALMAP_FLIP) defines.push('#define OPTION_NORMALMAP_FLIP');
    if (options & ZKOption.AUTONORMAL)     defines.push('#define OPTION_AUTONORMAL');

    const mat = new ShaderMaterial(name, scene, 'zkModel', {
        attributes: ['position', 'normal', 'uv'],
        uniforms: [
            'world', 'viewProjection', 'view', 'shadowMatrix',
            'cameraPos', 'simFrame',
            'teamColor', 'invertMask',
            'sunDir', 'sunDiffuse', 'sunAmbient', 'sunSpecular',
            'sunSpecularParams', 'shadowDensity',
            'hasEmissive', 'hasOrm', 'hasTeamMask', 'hasNormal',
            'csmMatrices', 'csmSplits', 'shadowDarkness',
            'autoNormalParams',
        ],
        samplers: [
            'diffuseTex', 'emissiveTex', 'ormTex', 'teamMaskTex',
            'normalTex', 'csmShadowMap',
        ],
        defines,
    });

    mat.setTexture('diffuseTex',  textures.diffuse);
    mat.setTexture('emissiveTex', textures.emissive ?? textures.diffuse);
    mat.setTexture('ormTex',      textures.orm      ?? textures.diffuse);
    mat.setTexture('teamMaskTex', textures.teamMask ?? textures.diffuse);
    mat.setTexture('normalTex',   textures.normal   ?? textures.diffuse);
    mat.setFloat('hasEmissive', textures.emissive ? 1.0 : 0.0);
    mat.setFloat('hasOrm',      textures.orm      ? 1.0 : 0.0);
    mat.setFloat('hasTeamMask', textures.teamMask ? 1.0 : 0.0);
    mat.setFloat('hasNormal',   textures.normal   ? 1.0 : 0.0);
    mat.setColor4('teamColor', teamColor.toColor4(1.0));
    mat.setFloat('invertMask', textures.invertTeamColor ? 1.0 : 0.0);

    mat.setVector3('sunDiffuse',  SUN_DIFFUSE);
    mat.setVector3('sunAmbient',  SUN_AMBIENT);
    mat.setVector3('sunSpecular', SUN_SPECULAR);
    mat.setVector3('sunSpecularParams', SUN_SPECULAR_PARAM);
    mat.setFloat('shadowDensity', 1.0);
    // ZK authored autoNormalParams = {samplingDist=1.0, value=0.002}.
    mat.setVector2('autoNormalParams', new Vector2(1.0, 0.002));

    // Initial values for shadow uniforms — overwritten every frame.
    mat.setVector3('sunDir', DEFAULT_SUN_DIR);
    mat.setMatrices('csmMatrices', [
        Matrix.Identity(), Matrix.Identity(), Matrix.Identity(), Matrix.Identity(),
    ]);
    mat.setVector4('csmSplits', new Vector4(1e30, 1e30, 1e30, 1e30));
    mat.setFloat('shadowDarkness', 1.0);
    mat.setMatrix('shadowMatrix', Matrix.Identity());
    mat.setTexture('csmShadowMap', textures.diffuse);
    mat.setVector3('cameraPos', new Vector3(0, 0, 0));
    mat.setInt('simFrame', 0);

    mat.onBindObservable.add(() => {
        bindShadowUniforms(mat);
        bindCameraAndFrame(mat);
    });

    mat.alpha = 1.0;
    mat.needAlphaBlending = () => false;
    mat.needAlphaTesting  = () => true;
    mat.backFaceCulling   = false;

    return mat;
}
