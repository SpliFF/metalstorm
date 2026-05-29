/**
 * DecalRenderer — persistent ground scars (and, later, vehicle tracks)
 * projected onto the terrain.
 *
 * PLAN-decals.md Phase D3 + D6. The server (envelope 0x08, see
 * decal-events.ts) authoritatively decides when a scar appears and
 * with what radius / lifetime / tint — faithful to Recoil's
 * CGroundDecalHandler. This renderer owns the *presentation*: a pool
 * of ground-projected quads that fade over their TTL.
 *
 * Texture sourcing (D6): ZK ships its scar bitmaps under
 * `bitmaps/Unknown/scars_newer/` and lists the active set in
 * `gamedata/scars.lua`, surfaced to the client as `graphics.scars`
 * in `/api/games/<id>/resources.json`. gameconverter already emits a
 * `.ktx2` sibling for every bitmap, resolved through the recursive
 * `bitmaps/manifest.json` — the exact pipeline projectile textures use
 * (see projectile-texture-resolver.ts). No bespoke textures: we render
 * ZK's authored scars as authored. The scar *list* is render-only data
 * fetched client-side over HTTP, not streamed from the headless server
 * (consistent with the lighting/map-render-data rule).
 *
 * Rendering approach (matches Recoil's "one quad per live decal,
 * grouped by texture"): one ground quad mesh per loaded scar texture,
 * thin-instanced. Each scar is one thin instance — a 16-float world
 * matrix (translate to the impact point, scale to the radius, random
 * yaw for variety) plus a `color` buffer (tint.rgb + current alpha).
 * A custom ShaderMaterial samples the scar texture and applies Recoil's
 * 0.5-grey-is-neutral tint scaling. The instance buffers are rebuilt
 * each tick from the live pool as scars age out.
 *
 * v1 cuts (documented in PLAN-decals.md "Out of scope"):
 *   - Quads are flat: the impact point's terrain height is sampled at
 *     spawn (CPU), but the quad does not follow undulations within its
 *     own footprint. Correct on flat maps; a heightmap-following vertex
 *     shader is the documented upgrade.
 *   - scarProjVector / scarDotElimination (oblique projection) ignored.
 *   - glow / glowTtl carried on the wire but not yet rendered as a
 *     separate additive pass.
 */

import {
    Scene,
    Mesh,
    VertexData,
    ShaderMaterial,
    Matrix,
    Vector3,
    Quaternion,
    Texture,
} from '@babylonjs/core';
import { stampUrl } from '../config.js';
import { loadDirManifest, type DirManifest } from './dir-manifest.js';
import type { ScarEvent } from './decal-events.js';

const ENGINE_BASE = '/api/engine/data/bitmaps';

/** Lift above terrain to avoid z-fighting with the ground mesh. */
const DECAL_Y_LIFT = 1.0;

/** Hard cap on live scars (Recoil-style ring buffer). Oldest evicted. */
const MAX_SCARS = 4096;

const DECAL_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
// Thin-instance world matrix (Babylon injects world0..world3) + per-
// instance colour (tint.rgb, current alpha).
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
attribute vec4 color;
uniform mat4 viewProjection;
varying vec2 vUv;
varying vec4 vColor;
void main() {
    mat4 finalWorld = mat4(world0, world1, world2, world3);
    vUv = uv;
    vColor = color;
    gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
}
`;

const DECAL_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D scarTex;
varying vec2 vUv;
varying vec4 vColor;
void main() {
    vec4 tex = texture2D(scarTex, vUv);
    // Recoil scarColorTint: 0.5 grey = no change, 1.0 = twice as bright.
    vec3 tinted = tex.rgb * vColor.rgb * 2.0;
    float a = tex.a * vColor.a;
    if (a < 0.01) discard;
    gl_FragColor = vec4(tinted, a);
}
`;

interface LiveScar {
    x: number;
    y: number;
    z: number;
    radius: number;
    yaw: number;
    ttl: number;
    age: number;
    alpha0: number;
    r: number;
    g: number;
    b: number;
    layer: number; // index into this.textures
}

type HeightSampler = (x: number, z: number) => number;

export class DecalRenderer {
    private scene: Scene;
    private material: ShaderMaterial;
    /** One ground quad mesh per loaded scar texture. */
    private meshes: Mesh[] = [];
    private textures: Texture[] = [];
    private scars: LiveScar[] = [];
    private heightSampler: HeightSampler | null = null;
    private ready = false;
    /** Scars that arrived before textures finished loading. */
    private pending: ScarEvent[] = [];
    private matrixScratch = Matrix.Identity();
    private scaleScratch = new Vector3(1, 1, 1);
    private posScratch = new Vector3(0, 0, 0);
    private rotScratch = new Quaternion(0, 0, 0, 1);

    constructor(scene: Scene) {
        this.scene = scene;
        this.material = new ShaderMaterial(
            'groundScar',
            scene,
            { vertexSource: DECAL_VERTEX, fragmentSource: DECAL_FRAGMENT },
            {
                attributes: ['position', 'uv'],
                uniforms: ['viewProjection', 'scarTex'],
                needAlphaBlending: true,
            },
        );
        this.material.backFaceCulling = false;
        // Don't write depth — scars are flush with the ground and
        // overlapping scars should alpha-blend, not z-fight.
        this.material.disableDepthWrite = true;
    }

    /** Set the terrain height lookup used to pin each scar to the
     *  ground at spawn. Until set, scars use the wire y verbatim. */
    setHeightSampler(fn: HeightSampler): void {
        this.heightSampler = fn;
    }

    /**
     * Load the game's authored scar textures. Fetches
     * `/api/games/<id>/resources.json`, reads `graphics.scars` (the
     * active scar list from ZK's `gamedata/scars.lua`), and resolves
     * each relative bitmap path (e.g. `unknown/scars_newer/scar1.png`)
     * to its served `.ktx2` URL through the game + engine manifests,
     * mirroring ProjectileTextureResolver. Idempotent per game.
     */
    async init(gameId: string, lobbyHttpUrl = ''): Promise<void> {
        if (!gameId) return;
        const base = lobbyHttpUrl || '';

        let scarNames: string[] = [];
        try {
            const resp = await fetch(stampUrl(`${base}/api/games/${gameId}/resources.json`));
            if (resp.ok) {
                const data = await resp.json() as { graphics?: { scars?: unknown } };
                scarNames = normaliseScarList(data.graphics?.scars);
            } else {
                console.warn(`[decals] resources.json returned ${resp.status} for ${gameId}`);
            }
        } catch (e) {
            console.warn('[decals] resources.json fetch failed:', e);
        }
        if (scarNames.length === 0) {
            console.warn('[decals] no graphics.scars list — scars disabled');
            return;
        }

        const [gameManifest, engineManifest] = await Promise.all([
            loadDirManifest(`${base}/api/games/data/${gameId}/bitmaps`),
            loadDirManifest(`${base}${ENGINE_BASE}`),
        ]);

        const urls: string[] = [];
        const seen = new Set<string>();
        for (const name of scarNames) {
            const url = resolveScarUrl(name, gameId, gameManifest, engineManifest, base);
            if (url && !seen.has(url)) { seen.add(url); urls.push(url); }
        }
        if (urls.length === 0) {
            console.warn('[decals] no scar textures resolved from resources.json graphics.scars');
            return;
        }

        for (let i = 0; i < urls.length; i++) {
            const tex = new Texture(
                stampUrl(urls[i]), this.scene,
                /*noMipmap*/ false, /*invertY*/ true,
                Texture.TRILINEAR_SAMPLINGMODE,
            );
            tex.hasAlpha = true;
            tex.wrapU = Texture.CLAMP_ADDRESSMODE;
            tex.wrapV = Texture.CLAMP_ADDRESSMODE;
            this.textures.push(tex);

            const mesh = buildGroundQuad(this.scene, `scarQuad${i}`);
            const mat = this.material.clone(`groundScar${i}`);
            mat.setTexture('scarTex', tex);
            mesh.material = mat;
            mesh.isPickable = false;
            mesh.alwaysSelectAsActiveMesh = true; // bounds are dynamic
            // Composite after terrain/water, alongside other ground FX.
            mesh.renderingGroupId = 1;
            mesh.thinInstanceCount = 0;
            this.meshes.push(mesh);
        }

        this.ready = true;
        console.log(`[decals] loaded ${this.textures.length} scar textures`);

        // Flush any scars that arrived during load.
        const queued = this.pending;
        this.pending = [];
        for (const s of queued) this.addScar(s);
    }

    /** Ingest one server decal frame. */
    onSnapshot(scars: ScarEvent[]): void {
        for (const s of scars) this.addScar(s);
    }

    private addScar(ev: ScarEvent): void {
        if (!this.ready) {
            // Hold a bounded backlog; drop oldest if the texture load
            // somehow never completes.
            if (this.pending.length < 256) this.pending.push(ev);
            return;
        }
        if (this.textures.length === 0) return;

        const layer = (Math.random() * this.textures.length) | 0;
        const y = this.heightSampler
            ? this.heightSampler(ev.x, ev.z) + DECAL_Y_LIFT
            : ev.y + DECAL_Y_LIFT;

        const scar: LiveScar = {
            x: ev.x, y, z: ev.z,
            radius: ev.radius,
            yaw: Math.random() * Math.PI * 2,
            ttl: Math.max(0.5, ev.ttl),
            age: 0,
            alpha0: ev.alpha > 0 ? ev.alpha : 1,
            r: ev.r, g: ev.g, b: ev.b,
            layer,
        };

        if (this.scars.length >= MAX_SCARS) this.scars.shift(); // evict oldest
        this.scars.push(scar);
    }

    /** Age scars, evict expired, rebuild thin-instance buffers. Call
     *  once per frame with the real frame delta in seconds. */
    tick(dtSeconds: number): void {
        if (!this.ready || this.scars.length === 0) {
            for (const m of this.meshes) m.thinInstanceCount = 0;
            return;
        }

        // Age + compact.
        let w = 0;
        for (let i = 0; i < this.scars.length; i++) {
            const s = this.scars[i];
            s.age += dtSeconds;
            if (s.age < s.ttl) this.scars[w++] = s;
        }
        this.scars.length = w;

        // Bucket by texture layer.
        const perLayer: LiveScar[][] = this.meshes.map(() => []);
        for (const s of this.scars) perLayer[s.layer].push(s);

        for (let layer = 0; layer < this.meshes.length; layer++) {
            const mesh = this.meshes[layer];
            const bucket = perLayer[layer];
            const n = bucket.length;
            if (n === 0) { mesh.thinInstanceCount = 0; continue; }

            const matrices = new Float32Array(n * 16);
            const colors = new Float32Array(n * 4);
            for (let i = 0; i < n; i++) {
                const s = bucket[i];
                // Linear fade over the back half of the lifetime; the
                // front half holds full opacity (Recoil-ish curve).
                const t = s.age / s.ttl;
                const fade = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
                const alpha = s.alpha0 * Math.max(0, fade);

                // Flat ground quad: scale to full diameter (2·radius),
                // yaw around Y, translate to the impact point. The quad
                // already lies in the XZ plane (built with +Y normal).
                const d = 2 * s.radius;
                this.scaleScratch.set(d, 1, d);
                this.posScratch.set(s.x, s.y, s.z);
                Quaternion.RotationYawPitchRollToRef(s.yaw, 0, 0, this.rotScratch);
                Matrix.ComposeToRef(
                    this.scaleScratch,
                    this.rotScratch,
                    this.posScratch,
                    this.matrixScratch,
                );
                this.matrixScratch.copyToArray(matrices, i * 16);

                colors[i * 4 + 0] = s.r;
                colors[i * 4 + 1] = s.g;
                colors[i * 4 + 2] = s.b;
                colors[i * 4 + 3] = alpha;
            }
            mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
            mesh.thinInstanceSetBuffer('color', colors, 4, false);
            mesh.thinInstanceCount = n;
        }
    }

    dispose(): void {
        for (const m of this.meshes) m.dispose();
        for (const t of this.textures) t.dispose();
        this.material.dispose();
        this.meshes = [];
        this.textures = [];
        this.scars = [];
        this.ready = false;
    }
}

/** Resolve a `graphics.scars` entry → served `.ktx2` URL (game first,
 *  then engine), mirroring ProjectileTextureResolver. */
function resolveScarUrl(
    name: string,
    gameId: string,
    gameManifest: DirManifest | null,
    engineManifest: DirManifest | null,
    base: string,
): string | null {
    if (!name) return null;
    const rel = stripExt(name) + '.ktx2';
    if (gameManifest?.has(rel)) {
        return `${base}/api/games/data/${gameId}/bitmaps/${rel}`;
    }
    if (engineManifest?.has(rel)) {
        return `${base}${ENGINE_BASE}/${rel}`;
    }
    console.warn(`[decals] scar '${name}' → '${rel}' not in game or engine manifest`);
    return null;
}

function stripExt(p: string): string {
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dot = p.lastIndexOf('.');
    if (dot <= slash) return p;
    return p.substring(0, dot);
}

/** `graphics.scars` is a 1-based Lua array; the JSON encoder may emit
 *  it as a JSON array or as an object keyed "1".."N". Accept both and
 *  return a flat string list. */
function normaliseScarList(scars: unknown): string[] {
    if (Array.isArray(scars)) {
        return scars.filter((s): s is string => typeof s === 'string');
    }
    if (scars && typeof scars === 'object') {
        return Object.values(scars as Record<string, unknown>)
            .filter((s): s is string => typeof s === 'string');
    }
    return [];
}

/** Build a unit ground quad (1×1 in the XZ plane, centred at origin,
 *  +Y normal). Scaled per-instance to the scar diameter. Winding +
 *  UVs match the RH scene convention used by terrain. */
function buildGroundQuad(scene: Scene, name: string): Mesh {
    const mesh = new Mesh(name, scene);
    const positions = new Float32Array([
        -0.5, 0, -0.5,
         0.5, 0, -0.5,
         0.5, 0,  0.5,
        -0.5, 0,  0.5,
    ]);
    const uvs = new Float32Array([
        0, 0,
        1, 0,
        1, 1,
        0, 1,
    ]);
    const normals = new Float32Array([
        0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]);
    // Two triangles, CCW from above (RH scene front face).
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2]);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.normals = normals;
    vd.indices = indices;
    vd.applyToMesh(mesh);
    return mesh;
}
