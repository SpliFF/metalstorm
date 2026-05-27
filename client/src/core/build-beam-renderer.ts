/**
 * BuildBeamRenderer — draws the nano-spray beams from active builders.
 *
 * Modelled on ProjectileRenderer: groups beams by (kind), uses thin
 * instances of a single cylinder mesh per group so each kind is one
 * draw call.
 *
 * Server snapshots arrive at ~10 Hz; to mask the gaps each beam
 * carries a client-side intensity that ramps in over a few frames and
 * decays once the beam stops appearing. Same trick the projectile
 * path uses to hide its update cadence.
 *
 * Per-piece origins: when the server sends `pieces[]` (NanoPieceCache
 * emitter indices), the renderer spawns one beam per piece, anchored
 * to that piece's live world position via
 * `EntityRenderer.getPieceWorldPosition`. Falls back to a single beam
 * from the builder's centre when no piece info is available.
 *
 * Stripe shader: each beam runs a scrolling additive stripe pattern
 * along its length. Build/repair/capture/terraform stripes flow
 * from builder → target; reclaim/resurrect reverse direction.
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    ShaderMaterial,
    Effect,
    Color3,
    Vector3,
    Texture,
} from '@babylonjs/core';

import type { EntityRenderer } from './entity-renderer.js';
import {
    KIND_BUILD,
    KIND_REPAIR,
    KIND_RECLAIM,
    KIND_RESURRECT,
    KIND_CAPTURE,
    KIND_TERRAFORM,
    TARGET_FEATURE,
    type BuildActivitySnapshot,
} from './build-activity.js';

/** Tint per build-action kind. Subtle differences so a player can read
 *  "this is reclaim, not build" at a glance even with team color in
 *  play. Build/repair stay close to the team color; reclaim cools to
 *  red, resurrect to gold, terraform to brown. */
const KIND_COLORS: Record<number, [number, number, number]> = {
    [KIND_BUILD]:     [0.5, 0.85, 1.0],
    [KIND_REPAIR]:    [0.5, 1.0, 0.5],
    [KIND_RECLAIM]:   [1.0, 0.45, 0.3],
    [KIND_RESURRECT]: [1.0, 0.85, 0.3],
    [KIND_CAPTURE]:   [0.95, 0.5, 1.0],
    [KIND_TERRAFORM]: [0.85, 0.7, 0.5],
};

/** Stripes flow toward the target for these kinds; the rest run them
 *  in reverse to read as "sucking material away" (reclaim/resurrect). */
function stripeDirection(kind: number): number {
    if (kind === KIND_RECLAIM || kind === KIND_RESURRECT) return -1;
    return 1;
}

interface ActiveBeam {
    builderId: number;
    /** -1 means "no piece info, use builder centre". Otherwise a model-
     *  piece index from NanoPieceCache. */
    pieceIdx: number;
    targetId: number;
    targetPos: Vector3;
    kind: number;
    /** Smooth fade [0..1]; ramps in over RAMP_FRAMES, decays when the
     *  beam stops appearing in fresh snapshots. */
    intensity: number;
    /** Frames since the last snapshot mention. Drives the decay. */
    age: number;
}

const RAMP_FRAMES = 5;

// Vertex shader builds a camera-facing billboard for each beam from a
// unit-quad mesh. Per-instance matrix encodes:
//   translation = beam midpoint (world)
//   X axis (m00,m10,m20)        = unused; we recompute in shader
//   Y axis (m01,m11,m21)        = beam direction × length
//   Z axis (m02,m12,m22)        = unused
//   m30 = beam half-width        (packed into normally-zero row)
//   m31 = scroll-direction sign  (+1 build, -1 reclaim)
// We rebuild a camera-facing quad: the across-axis is camera_right
// projected perpendicular to the beam direction, scaled by half-width.
// The along-axis is the encoded Y. Position.xy ∈ [-0.5, 0.5].
const BEAM_VERTEX = `
    precision highp float;
    attribute vec3 position;
    attribute vec2 uv;

    #include<instancesDeclaration>
    uniform mat4 viewProjection;
    uniform vec3 cameraPosition;

    varying vec2 vUV;
    varying float vDirection;

    void main() {
        // Beam axis (length encoded in vector magnitude) and midpoint.
        vec3 alongVec = vec3(world1.x, world1.y, world1.z);
        vec3 mid      = vec3(world3.x, world3.y, world3.z);
        // Half-width and direction packed into the unused matrix row.
        float halfW = world0.w;
        vDirection = world1.w;

        // Camera-facing across-axis: perpendicular to both beam and
        // view direction, then renormalised so width stays consistent
        // regardless of beam length.
        vec3 viewDir = normalize(mid - cameraPosition);
        vec3 across  = normalize(cross(alongVec, viewDir)) * halfW;

        // position.x ∈ [-0.5, 0.5] across, position.y ∈ [-0.5, 0.5] along.
        vec3 worldPos = mid + across * (position.x * 2.0)
                            + alongVec * position.y;

        vUV = uv;
        gl_Position = viewProjection * vec4(worldPos, 1.0);
    }
`;

// Fragment samples a tileable nano-falloff texture as a scrolling
// brightness pattern. UV.x runs across the beam, UV.y along it.
// Scrolling vUV.y reads as material flowing toward the target (or away,
// for reclaim).
//
// The shipped largelaserfalloff.png is RGB only (no alpha channel) so
// tex.a is locked at 1.0 — relying on it produces a solid-looking bar
// across the full beam width. Derive the cross-section taper procedurally
// from vUV.x, and use the texture's red channel only for the longitudinal
// scrolling pattern.
const BEAM_FRAGMENT = `
    precision highp float;

    uniform sampler2D beamTex;
    uniform vec3 baseColor;
    uniform float time;
    uniform float intensityMul;

    varying vec2 vUV;
    varying float vDirection;

    void main() {
        vec2 uv = vec2(vUV.x, vUV.y - time * 1.6 * vDirection);
        float pattern = texture2D(beamTex, uv).r;

        // Cross-section falloff: 1.0 at the centre, 0 at the edges.
        // The hard edge would alias on a thin beam — use smoothstep so
        // the shoulders are anti-aliased.
        float dx = abs(vUV.x - 0.5) * 2.0; // 0 at centre, 1 at edges
        float across = 1.0 - smoothstep(0.4, 1.0, dx);

        // Soft head/tail along the beam so it doesn't abut the builder
        // or the build site as a hard edge.
        float along = (vDirection > 0.0) ? vUV.y : (1.0 - vUV.y);
        float env = smoothstep(0.0, 0.15, along) *
                    (1.0 - smoothstep(0.8, 1.0, along));

        float a = pattern * across * env * intensityMul;
        // Premultiplied alpha so the colour pre-darkens at the edges
        // instead of compositing the full baseColor over a low-alpha
        // pixel and looking washed-out.
        gl_FragColor = vec4(baseColor * a, a);
    }
`;

let shadersRegistered = false;
function ensureShadersRegistered() {
    if (shadersRegistered) return;
    Effect.ShadersStore['buildBeamVertexShader'] = BEAM_VERTEX;
    Effect.ShadersStore['buildBeamFragmentShader'] = BEAM_FRAGMENT;
    shadersRegistered = true;
}

export class BuildBeamRenderer {
    private scene: Scene;
    private entityRenderer: EntityRenderer | null = null;

    /** Beam template meshes keyed by `${kind}` — material colour comes
     *  from the kind tint. Per-team variants can be added later. */
    private templates = new Map<number, { mesh: Mesh; material: ShaderMaterial }>();

    /** Active beams keyed by `${builderId}:${pieceIdx}` so the same
     *  builder can drive multiple piece-anchored beams at once. */
    private beams = new Map<string, ActiveBeam>();

    /** Wall-clock seconds for the stripe scroll uniform. Reset to 0
     *  on construction to keep the scrolling integer-stable for short
     *  sessions; it will lose precision after several days, which is
     *  fine for a debug-build session. */
    private startTime = performance.now() / 1000;

    /** Shared nano-stream texture (ZK's largelaserfalloff). Loaded
     *  lazily on first beam render and reused across all kind
     *  templates. Returns null until the HTTP fetch completes — beams
     *  rendered during that window are tinted but blank. */
    private beamTexture: Texture | null = null;
    private beamTextureUrl = '';

    constructor(scene: Scene) {
        this.scene = scene;
        ensureShadersRegistered();
    }

    /** Tell the renderer where to fetch the nano-stream texture. The
     *  client wires this to the lobby HTTP path for the active game's
     *  bitmaps directory. Safe to call before or after the first
     *  snapshot — late binding triggers a one-time texture fetch. */
    setGameAssetsBaseUrl(gameId: string): void {
        // ZK ships the falloff texture; other games may not. We point
        // at the file unconditionally and accept a 404 → blank tex if
        // the game doesn't have one. (TODO: per-game default and a
        // fallback procedural texture for games without the asset.)
        this.beamTextureUrl = `/api/games/data/${gameId}/bitmaps/GPL/largelaserfalloff.png`;
    }

    setEntityRenderer(er: EntityRenderer): void {
        this.entityRenderer = er;
    }

    private static beamKey(builderId: number, pieceIdx: number): string {
        return `${builderId}:${pieceIdx}`;
    }

    /** Update the active-beam set from a fresh server snapshot. Beams
     *  that disappear from the snapshot decay over the next few frames
     *  rather than popping out instantly — masks the 10 Hz cadence. */
    onSnapshot(snap: BuildActivitySnapshot): void {
        const seen = new Set<string>();
        for (const a of snap.actions) {
            // Per-piece beams when the server provided emitter indices;
            // otherwise a single centre beam. Use sentinel pieceIdx=-1
            // for the centre fallback so the key space stays disjoint
            // from real piece indices.
            const pieceIndices = a.pieces.length > 0 ? a.pieces : [-1];
            for (const pi of pieceIndices) {
                const key = BuildBeamRenderer.beamKey(a.builderId, pi);
                seen.add(key);
                let beam = this.beams.get(key);
                if (!beam) {
                    beam = {
                        builderId: a.builderId,
                        pieceIdx: pi,
                        targetId: a.targetId,
                        targetPos: new Vector3(a.targetX, a.targetY, a.targetZ),
                        kind: a.kind,
                        intensity: 0,
                        age: 0,
                    };
                    this.beams.set(key, beam);
                } else {
                    beam.targetId = a.targetId;
                    beam.targetPos.set(a.targetX, a.targetY, a.targetZ);
                    beam.kind = a.kind;
                }
                beam.age = 0;
            }
        }
        // Anything not seen this snapshot starts decaying.
        for (const [key, beam] of this.beams) {
            if (!seen.has(key)) beam.age++;
        }
    }

    /** Per-frame render pass: advance ramps/decay, resolve world
     *  positions from the EntityRenderer, build thin-instance matrices
     *  per (kind) group, and tick the stripe-scroll time uniform. */
    tick(): void {
        if (!this.entityRenderer) return;

        // Advance ramps and prune fully-decayed beams.
        const dropKeys: string[] = [];
        for (const [key, beam] of this.beams) {
            if (beam.age === 0) {
                beam.intensity = Math.min(1, beam.intensity + 1 / RAMP_FRAMES);
            } else {
                beam.intensity = Math.max(0, beam.intensity - 1 / RAMP_FRAMES);
                if (beam.intensity <= 0) dropKeys.push(key);
            }
        }
        for (const key of dropKeys) this.beams.delete(key);

        // Group instance matrices by kind.
        const groups = new Map<number, number[]>();

        for (const beam of this.beams.values()) {
            // Beam start: piece world position when we have a piece
            // index, otherwise the entity centre.
            let start: { x: number; y: number; z: number } | null = null;
            if (beam.pieceIdx >= 0) {
                start = this.entityRenderer.getPieceWorldPosition(
                    beam.builderId, beam.pieceIdx);
            }
            if (!start) {
                start = this.entityRenderer.getEntityPosition(beam.builderId);
            }
            if (!start) continue;

            // Resolve target world position. For unit targets the
            // server sends a snapshot every ~3 ticks, so we look up
            // the live interpolated entity position instead — that
            // avoids the beam tail trailing behind a moving target.
            let endX = beam.targetPos.x;
            let endY = beam.targetPos.y;
            let endZ = beam.targetPos.z;
            if (beam.targetId !== 0 && beam.targetId !== TARGET_FEATURE) {
                const tp = this.entityRenderer.getEntityPosition(beam.targetId);
                if (tp) { endX = tp.x; endY = tp.y; endZ = tp.z; }
            }

            // Builder centre fallback sits at ground level; lift it a
            // touch so the beam doesn't clip into the model. Piece-
            // origin starts are already in the right place.
            const startLift = beam.pieceIdx >= 0 ? 0 : 8;
            const startV = new Vector3(start.x, start.y + startLift, start.z);
            const endV   = new Vector3(endX, endY + 8, endZ);
            const dir = endV.subtract(startV);
            const length = dir.length();
            if (length < 0.5) continue;
            dir.normalize();

            // Pack the per-instance data the billboard vertex shader
            // expects:
            //   row 0: half-width in .w (rest unused)
            //   row 1: beam direction × length in xyz, scroll sign in .w
            //   row 2: unused
            //   row 3: beam midpoint in xyz (.w unused)
            // Layout matches the row-major Babylon Matrix.m we hand to
            // thinInstanceSetBuffer.
            const halfWidth = (beam.pieceIdx >= 0 ? 1.5 : 2.5) *
                              (0.5 + 0.5 * beam.intensity);
            const center = startV.add(dir.scale(length * 0.5));
            const direction = stripeDirection(beam.kind);
            const arr = new Float32Array(16);
            arr[0] = 0; arr[1] = 0; arr[2] = 0; arr[3] = halfWidth;
            arr[4] = dir.x * length; arr[5] = dir.y * length;
            arr[6] = dir.z * length; arr[7] = direction;
            arr[8] = 0; arr[9] = 0; arr[10] = 0; arr[11] = 0;
            arr[12] = center.x; arr[13] = center.y; arr[14] = center.z;
            arr[15] = 1;

            let group = groups.get(beam.kind);
            if (!group) {
                group = [];
                groups.set(beam.kind, group);
            }
            for (let j = 0; j < 16; j++) group.push(arr[j]);
        }

        // Push instances per kind, hide kinds with no beams this frame.
        const time = performance.now() / 1000 - this.startTime;
        const activeKinds = new Set<number>();
        for (const [kind, mats] of groups) {
            const tmpl = this.getOrCreateTemplate(kind);
            const buf = new Float32Array(mats);
            const count = mats.length / 16;
            tmpl.mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
            tmpl.mesh.thinInstanceCount = count;
            tmpl.mesh.isVisible = true;
            tmpl.material.setFloat('time', time);
            activeKinds.add(kind);
        }
        for (const [kind, tmpl] of this.templates) {
            if (!activeKinds.has(kind)) {
                tmpl.mesh.isVisible = false;
                tmpl.mesh.thinInstanceCount = 0;
            }
        }
    }

    private getOrCreateTemplate(kind: number) {
        let entry = this.templates.get(kind);
        if (entry) return entry;

        const color = KIND_COLORS[kind] ?? KIND_COLORS[KIND_BUILD];
        const mat = new ShaderMaterial(`buildBeamMat_${kind}`, this.scene, 'buildBeam', {
            attributes: ['position', 'uv'],
            uniforms: ['world', 'viewProjection', 'cameraPosition',
                       'baseColor', 'time', 'intensityMul'],
            samplers: ['beamTex'],
            defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
            // Required for `mat.alphaMode = 7` below to take effect —
            // ShaderMaterial defaults to opaque-pass rendering.
            needAlphaBlending: true,
        });
        mat.setColor3('baseColor', new Color3(color[0], color[1], color[2]));
        mat.setFloat('time', 0);
        // Translucent overlay rather than additive glow — additive bleached
        // the model behind into white whenever a multi-piece commander
        // emitted several beams from one base. Cap peak alpha at ~0.45 so
        // the streak is clearly see-through even at the brightest texel.
        mat.setFloat('intensityMul', 0.45);
        if (this.ensureTexture()) mat.setTexture('beamTex', this.beamTexture!);
        // ALPHA_PREMULTIPLIED = 7: result = src + dst * (1 - srcA), with the
        // fragment emitting baseColor * a as the premultiplied colour.
        // Avoids the colour shift you get when low-alpha fragments bleed
        // unmodulated baseColor into the destination.
        mat.alphaMode = 7;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;

        // Unit quad in XY centred on origin. The vertex shader rebuilds
        // the camera-facing orientation per frame; the mesh just
        // provides position.x ∈ [-0.5, 0.5] across, position.y ∈
        // [-0.5, 0.5] along, and matching UVs.
        const mesh = MeshBuilder.CreatePlane(
            `buildBeam_${kind}`,
            { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE },
            this.scene,
        );
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.isVisible = false;
        mesh.thinInstanceEnablePicking = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.renderingGroupId = 2;

        entry = { mesh, material: mat };
        this.templates.set(kind, entry);
        return entry;
    }

    /** Lazily fetch the nano-stream texture. Returns true once the
     *  Texture object has been allocated (Babylon handles async fetch
     *  internally — sampling a not-yet-ready texture just returns
     *  black, which is fine since the beam fades in over its first
     *  few frames anyway). */
    private ensureTexture(): boolean {
        if (this.beamTexture) return true;
        if (!this.beamTextureUrl) return false;
        this.beamTexture = new Texture(this.beamTextureUrl, this.scene,
            /* noMipmap */ true, /* invertY */ false);
        this.beamTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
        this.beamTexture.wrapV = Texture.WRAP_ADDRESSMODE;
        return true;
    }

    dispose(): void {
        for (const t of this.templates.values()) {
            t.mesh.dispose();
            t.material.dispose();
        }
        this.templates.clear();
        this.beams.clear();
    }

    /** Active beam count — used by the HUD/debug overlay. */
    get count(): number {
        return this.beams.size;
    }
}
