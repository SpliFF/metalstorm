import { describe, it, expect, afterEach } from 'vitest';
import {
    NullEngine, Scene, FreeCamera, Vector3, Color3, Matrix, Mesh, MeshBuilder,
} from '@babylonjs/core';
import {
    SquadRenderBackend, FADE_FRAC, setLegacyBackendPlumbing, setLegacyBufferRebind,
    setBboxRefreshEvery, setPoolCompaction, setPoolCompactionGate,
    type MemberModel,
} from './squad-render-backend.js';
import type { ImpostorAtlas } from './impostor-renderer.js';

// Members of defs with an impostor sprite atlas draw as camera-facing billboard
// quads (per-(defId, team) thin-instance pools); defs without an atlas keep the
// proxy capsule pools. With a 3D member model (M4) they swap to the real body
// within impostorDistance and back to the sprite beyond it.

/** A single-view (legacy) sheet: no elevation rows, so its cards stay upright. */
const ATLAS: ImpostorAtlas = {
    diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 12, height: 12,
};

/** The `infantry_v2` shape the four infantry atlases declare (M8): 8 yaw x 3
 *  pitch, 15/45/80 arc, column 0 = the unit's FRONT (phase 180 degrees). */
const DIRECTIONAL: ImpostorAtlas = {
    ...ATLAS,
    layout: {
        yawBins: 8, pitchBins: 3, frames: 1,
        pitchDegrees: [15, 45, 80], azimuthPhase: Math.PI,
    },
};

interface HostOpts {
    /** defId → MemberModel factory (or undefined = model not available yet). */
    models?: Map<number, (scene: Scene) => Mesh | undefined>;
    impostorDist?: number;
    /** Extra rest-pose pieces beyond the factory's, to exercise a multi-piece
     *  body (a vehicle: hull + tracks + turret). */
    extraPieces?: number;
}

function makeBackend(atlasDefs: Set<number>, opts: HostOpts = {}) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera('cam', new Vector3(100, 50, 0), scene);
    scene.activeCamera = camera;
    const memberMeshes = new Map<string, Mesh>();
    const backend = new SquadRenderBackend(scene, {
        getGroundHeight: () => 0,
        getTeamColor: () => new Color3(1, 0, 0),
        getImpostorAtlas: (defId) => (atlasDefs.has(defId) ? ATLAS : undefined),
        getMemberModel: opts.models
            ? (defId, team): MemberModel | undefined => {
                const factory = opts.models!.get(defId);
                if (!factory) return undefined;
                const key = `${defId}:${team}`;
                let mesh = memberMeshes.get(key);
                if (!mesh) {
                    const m = factory(scene);
                    if (!m) return undefined;         // still loading
                    memberMeshes.set(key, m);
                    mesh = m;
                }
                const pieces = [{ mesh, restWorld: Matrix.Identity() }];
                for (let p = 1; p <= (opts.extraPieces ?? 0); p++) {
                    const pk = `${defId}:${team}:${p}`;
                    let pm = memberMeshes.get(pk);
                    if (!pm) {
                        pm = MeshBuilder.CreateBox(
                            `memberPiece_d${defId}_p${p}`, { size: 2 }, scene);
                        memberMeshes.set(pk, pm);
                    }
                    // A non-identity rest pose per piece, so a piece composed
                    // against the wrong one lands visibly off.
                    pieces.push({ mesh: pm, restWorld: Matrix.Translation(0, p * 3, 0) });
                }
                return { pieces, yOffset: 0, height: 10 };
            }
            : undefined,
        getImpostorDistance: opts.models
            ? () => opts.impostorDist ?? 900
            : undefined,
    });
    return { backend, scene, camera, memberMeshes };
}

/** A dedicated body mesh factory for the MODEL tier. */
function bodyFactory(defId: number) {
    return (scene: Scene) =>
        MeshBuilder.CreateBox(`memberModel_d${defId}`, { size: 4 }, scene);
}

function findMesh(scene: Scene, prefix: string): Mesh | undefined {
    return scene.meshes.find((m) => m.name.startsWith(prefix)) as Mesh | undefined;
}

describe('SquadRenderBackend impostor sprite members', () => {
    it('routes members of an atlas def into a per-(defId, team) sprite pool', () => {
        const { backend, scene } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 2);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 10, 0, 20, 0, 0);
        backend.flush();

        const sprite = findMesh(scene, 'squadSprite_d7_t2');
        expect(sprite).toBeDefined();
        expect(sprite!.thinInstanceCount).toBe(1);
        // No capsule pool was created for this member.
        expect(findMesh(scene, 'squadMember_t2')).toBeUndefined();
    });

    it('keeps capsule pools for defs without an atlas', () => {
        const { backend, scene } = makeBackend(new Set());
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        backend.flush();

        expect(findMesh(scene, 'squadMember_t0')).toBeDefined();
        expect(findMesh(scene, 'squadSprite_')).toBeUndefined();
    });

    it('screen-aligned cards do NOT twist when the camera only moves position', () => {
        // The anti-fan-out contract (PLAN M3): every card shares one rotation
        // derived from the camera view, not from each member's position → the
        // matrix is identical when only the camera translates.
        const { backend, scene, camera } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        camera.computeWorldMatrix(true);
        backend.flush();
        const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
        const before = Array.from((mesh.thinInstanceGetWorldMatrices()[0]).toArray());

        // Member is NOT updated again — only the camera translates (no rotation).
        camera.position.set(-100, 50, 0);
        camera.computeWorldMatrix(true);
        backend.flush();
        const after = Array.from((mesh.thinInstanceGetWorldMatrices()[0]).toArray());
        expect(after).toEqual(before);
        // Ground anchor + half-height lift along the (unchanged) card up.
        expect(after[13]).toBeCloseTo(ATLAS.height / 2);
    });

    it('re-orients screen-aligned cards when the camera rotates', () => {
        const { backend, scene, camera } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        camera.computeWorldMatrix(true);
        backend.flush();
        const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
        const before = Array.from((mesh.thinInstanceGetWorldMatrices()[0]).toArray());

        // Camera yaws — the shared card rotation must follow.
        camera.rotation.y += 0.6;
        camera.computeWorldMatrix(true);
        backend.flush();
        const after = Array.from((mesh.thinInstanceGetWorldMatrices()[0]).toArray());
        expect(after).not.toEqual(before);
    });

    // §Card orientation: the card rotation is shared per frame AND whether it
    // tilts with camera pitch is a property of the ATLAS (cardTiltsWithPitch).
    describe('card orientation', () => {
        /** The card's local up in world space = matrix row 1. */
        const localUp = (m: Float32Array | number[]) =>
            [m[4], m[5], m[6]] as [number, number, number];
        /** Where the card's base edge sits = translation − halfH · localUp. */
        const basePoint = (m: Float32Array | number[], halfH: number) =>
            [m[12] - halfH * m[4], m[13] - halfH * m[5], m[14] - halfH * m[6]];

        function spriteMatrix(atlas: ImpostorAtlas, pitchDown: number) {
            const engine = new NullEngine();
            const scene = new Scene(engine);
            const camera = new FreeCamera('cam', new Vector3(0, 200, -200), scene);
            camera.rotation.x = pitchDown; // look down at the ground
            scene.activeCamera = camera;
            const backend = new SquadRenderBackend(scene, {
                getGroundHeight: () => 0,
                getTeamColor: () => new Color3(1, 0, 0),
                getImpostorAtlas: () => atlas,
            });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 0, 0, 0, 0, 0);
            backend.flush();
            const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
            return Array.from(mesh.thinInstanceGetWorldMatrices()[0].toArray());
        }

        it('keeps a single-view atlas card upright under a steep camera', () => {
            // No pitch rows to show, so tilting would lay the one horizon-level
            // view flat on the ground (a unit that looks like it fell over).
            const m = spriteMatrix(ATLAS, 1.2);
            const [ux, uy, uz] = localUp(m);
            expect(ux).toBeCloseTo(0, 6);
            expect(uy).toBeCloseTo(1, 6);
            expect(uz).toBeCloseTo(0, 6);
            // Upright ⇒ the lift is world-up ⇒ base sits on the ground.
            expect(m[13]).toBeCloseTo(ATLAS.height / 2, 6);
        });

        it('tilts a pitch-row atlas card and keeps its base on the ground', () => {
            const m = spriteMatrix(DIRECTIONAL, 1.2);
            // The card leans back to face the steep camera...
            expect(localUp(m)[1]).toBeLessThan(0.9);
            // ...and the ground-anchor lift leans with it, so the base edge
            // stays pinned to the member's ground position (0, 0, 0) rather
            // than the card hovering half its height above the terrain.
            const [bx, by, bz] = basePoint(m, DIRECTIONAL.height / 2);
            expect(bx).toBeCloseTo(0, 5);
            expect(by).toBeCloseTo(0, 5);
            expect(bz).toBeCloseTo(0, 5);
        });

        it('shares one rotation across members, so a squad never fans out', () => {
            const engine = new NullEngine();
            const scene = new Scene(engine);
            const camera = new FreeCamera('cam', new Vector3(0, 40, -40), scene);
            camera.rotation.x = 0.8;
            scene.activeCamera = camera;
            const backend = new SquadRenderBackend(scene, {
                getGroundHeight: () => 0,
                getTeamColor: () => new Color3(1, 0, 0),
                getImpostorAtlas: () => DIRECTIONAL,
            });
            backend.setSquadTeam(1, 0);
            // Two members spread wide either side of the camera axis — the case
            // that produced the visible radial fan-out at point-blank range.
            const a = backend.createMember(1, 0, { defId: 7, variant: 0 });
            const b = backend.createMember(1, 1, { defId: 7, variant: 0 });
            backend.updateMember(a, -30, 0, 0, 0, 0);
            backend.updateMember(b, 30, 0, 0, 0, 0);
            backend.flush();
            const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
            const ma = mesh.thinInstanceGetWorldMatrices()[0].toArray();
            const mb = mesh.thinInstanceGetWorldMatrices()[1].toArray();
            // Identical 3×3 rotation blocks; only the translation differs.
            for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
                expect(mb[i]).toBeCloseTo(ma[i], 6);
            }
            expect(mb[12]).not.toBeCloseTo(ma[12], 3);
        });

        it('selects a per-member atlas cell from its own facing', () => {
            // Directionality comes from cell SELECTION, not card geometry: two
            // members at the same spot with opposite headings must land in
            // different atlas columns even though their cards are identical.
            const engine = new NullEngine();
            const scene = new Scene(engine);
            const camera = new FreeCamera('cam', new Vector3(0, 20, -200), scene);
            scene.activeCamera = camera;
            const backend = new SquadRenderBackend(scene, {
                getGroundHeight: () => 0,
                getTeamColor: () => new Color3(1, 0, 0),
                getImpostorAtlas: () => DIRECTIONAL,
            });
            backend.setSquadTeam(1, 0);
            const a = backend.createMember(1, 0, { defId: 7, variant: 0 });
            const b = backend.createMember(1, 1, { defId: 7, variant: 0 });
            backend.updateMember(a, 0, 0, 0, 0, 0);          // facing +Z (away)
            backend.updateMember(b, 0, 0, 0, Math.PI, 0);    // facing −Z (at cam)
            backend.flush();
            const cells = backend.getSpriteCells(7, 0)!;
            expect(cells[0]).not.toBe(cells[1]);
            // Camera is level with the members, so both pick the lowest
            // elevation row (15°) — the difference is purely the yaw column.
            const yawBins = DIRECTIONAL.layout!.yawBins;
            expect(Math.floor(cells[0] / yawBins)).toBe(0);
            expect(Math.floor(cells[1] / yawBins)).toBe(0);
            // Opposite headings ⇒ columns half the ring apart.
            const delta = Math.abs(cells[0] - cells[1]);
            expect(Math.min(delta, yawBins - delta)).toBe(yawBins / 2);
        });
    });

    it('draws a member within impostorDistance as the 3D model, not a sprite', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 2);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        // Camera at (100,50,0); place the member ~10 elmos away → inside 900.
        backend.updateMember(h, 100, 0, 8, 0, 0);
        backend.flush();

        const model = findMesh(scene, 'memberModel_d7');
        expect(model).toBeDefined();
        expect(model!.thinInstanceCount).toBe(1);
        // Pure model tier: full opacity, and no sprite slot held (slots are
        // allocated lazily — a member that spawns close never touches the
        // sprite pool).
        expect(backend.getMemberFades(h)).toEqual({ model: 1 });
    });

    it('draws a member beyond impostorDistance as the sprite, not the 3D model', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        // Far from the camera (well beyond 900 elmos).
        backend.updateMember(h, -2000, 0, 2000, 0, 0);
        backend.flush();

        const sprite = findMesh(scene, 'squadSprite_d7_t0')!;
        expect(sprite.thinInstanceCount).toBe(1);
        // No model instance is live.
        const model = findMesh(scene, 'memberModel_d7');
        if (model) {
            const mm = model.thinInstanceGetWorldMatrices()[0]?.toArray();
            if (mm) expect(Array.from(mm).every((v) => v === 0)).toBe(true);
        }
    });

    it('migrates a member between sprite and model pools as it nears the camera', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });

        // Start far → sprite.
        backend.updateMember(h, -3000, 0, 0, 0, 0);
        backend.flush();
        const sprite = findMesh(scene, 'squadSprite_d7_t0')!;
        expect(sprite.thinInstanceCount).toBe(1);

        // Move next to the camera → model, and the sprite slot goes dark.
        backend.updateMember(h, 100, 0, 6, 0, 0);
        backend.flush();
        const model = findMesh(scene, 'memberModel_d7')!;
        expect(model.thinInstanceCount).toBe(1);
        const sm = sprite.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(sm).every((v) => v === 0)).toBe(true);

        // Back out → sprite again, model slot goes dark.
        backend.updateMember(h, -3000, 0, 0, 0, 0);
        backend.flush();
        expect(sprite.thinInstanceCount).toBeGreaterThanOrEqual(1);
        const spriteLive = sprite.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(spriteLive).some((v) => v !== 0)).toBe(true);
        const mm = model.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(mm).every((v) => v === 0)).toBe(true);
    });

    it('crossfades BOTH tiers inside the boundary band (M5 no-pop)', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        // Camera at (100,50,0); place the member at dist 820 → inside the
        // [765,900] crossfade band (inner = 900·(1−0.15)).
        backend.updateMember(h, 100, 50, 820, 0, 0);
        backend.flush();

        const fades = backend.getMemberFades(h);
        expect(fades.model).toBeGreaterThan(0);
        expect(fades.model).toBeLessThan(1);
        expect(fades.sprite).toBeGreaterThan(0);
        expect(fades.sprite).toBeLessThan(1);
        // Complementary — the two opacities sum to 1 across the band.
        expect(fades.model! + fades.sprite!).toBeCloseTo(1);
        // Both tiers are actually DRAWN this frame (dual residency = the pop
        // is dissolved, not a hard cut).
        expect(findMesh(scene, 'memberModel_d7')!.thinInstanceCount).toBe(1);
        expect(findMesh(scene, 'squadSprite_d7_t0')!.thinInstanceCount).toBe(1);
    });

    it('shifts the crossfade weighting toward the model as the member nears', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        const inner = 900 * (1 - FADE_FRAC);

        backend.updateMember(h, 100, 50, inner + 5, 0, 0);  // near the model edge
        backend.flush();
        const near = backend.getMemberFades(h);

        backend.updateMember(h, 100, 50, 900 - 5, 0, 0);    // near the sprite edge
        backend.flush();
        const far = backend.getMemberFades(h);

        expect(near.model!).toBeGreaterThan(far.model!);
        expect(near.sprite!).toBeLessThan(far.sprite!);
    });

    it('stays on the sprite tier until the model finishes loading, then migrates', () => {
        // Factory returns undefined (loading) first, then a mesh.
        let ready = false;
        const models = new Map<number, (s: Scene) => Mesh | undefined>([
            [7, (s) => (ready ? MeshBuilder.CreateBox('memberModel_d7', { size: 4 }, s) : undefined)],
        ]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });

        // Close to the camera, but the model isn't loaded → sprite.
        backend.updateMember(h, 100, 0, 6, 0, 0);
        backend.flush();
        expect(findMesh(scene, 'squadSprite_d7_t0')!.thinInstanceCount).toBe(1);
        expect(findMesh(scene, 'memberModel_d7')).toBeUndefined();

        // Model loads → next update migrates it in.
        ready = true;
        backend.updateMember(h, 100, 0, 6, 0, 0);
        backend.flush();
        expect(findMesh(scene, 'memberModel_d7')!.thinInstanceCount).toBe(1);
    });

    it('does NOT dispose the borrowed model mesh on backend.dispose()', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 100, 0, 6, 0, 0);
        backend.flush();
        const model = findMesh(scene, 'memberModel_d7')!;
        expect(model.isDisposed()).toBe(false);

        backend.dispose();
        // EntityRenderer owns the mesh — the backend leaves it alive.
        expect(model.isDisposed()).toBe(false);
    });

    it('keeps members on the sprite tier when the host exposes no model API', () => {
        // No models map → getMemberModel/getImpostorDistance undefined.
        const { backend, scene } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 100, 0, 6, 0, 0);   // right next to the camera
        backend.flush();
        expect(findMesh(scene, 'squadSprite_d7_t0')!.thinInstanceCount).toBe(1);
    });

    // A def with a 3D body but NO impostor atlas (ms_tanks_s2 → fable_tank).
    // The model tier must not be gated on the def ALSO having an atlas — there
    // is simply no sprite tier to hand over to, so the model holds at all
    // ranges and the capsule is only reached when no body loads at all.
    describe('atlas-less defs with a 3D body', () => {
        it('draws the MODEL tier, not the proxy capsule', () => {
            const models = new Map([[7, bodyFactory(7)]]);
            const { backend, scene } = makeBackend(new Set(), { models });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 100, 0, 8, 0, 0);
            backend.flush();

            expect(findMesh(scene, 'memberModel_d7')!.thinInstanceCount).toBe(1);
            expect(backend.getMemberFades(h)).toEqual({ model: 1 });
            // The capsule pool is never even created for this def.
            expect(findMesh(scene, 'squadMember_t0')).toBeUndefined();
            expect(findMesh(scene, 'squadSprite_')).toBeUndefined();
        });

        it('holds the model tier at any range — the sprite tier is unreachable', () => {
            // The host still reports a switch distance; with no atlas behind it
            // the member must NOT fall off the model tier into the capsule.
            const models = new Map([[7, bodyFactory(7)]]);
            const { backend, scene } = makeBackend(new Set(), { models, impostorDist: 900 });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, -9000, 0, 9000, 0, 0);   // far beyond 900
            backend.flush();

            expect(backend.getMemberFades(h)).toEqual({ model: 1 });
            expect(findMesh(scene, 'memberModel_d7')!.thinInstanceCount).toBe(1);
            expect(findMesh(scene, 'squadMember_t0')).toBeUndefined();
        });

        it('uses the capsule while the body loads, then migrates to the model', () => {
            let ready = false;
            const models = new Map<number, (s: Scene) => Mesh | undefined>([
                [7, (s) => (ready ? MeshBuilder.CreateBox('memberModel_d7', { size: 4 }, s) : undefined)],
            ]);
            const { backend, scene } = makeBackend(new Set(), { models });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });

            backend.updateMember(h, 100, 0, 6, 0, 0);
            backend.flush();
            expect(findMesh(scene, 'memberModel_d7')).toBeUndefined();
            const capsule = findMesh(scene, 'squadMember_t0')!;
            expect(capsule.thinInstanceCount).toBe(1);
            expect(backend.getMemberFades(h)).toEqual({ capsule: true });

            ready = true;
            backend.updateMember(h, 100, 0, 6, 0, 0);
            backend.flush();
            expect(findMesh(scene, 'memberModel_d7')!.thinInstanceCount).toBe(1);
            // The capsule slot went dark — the member left it.
            const cm = capsule.thinInstanceGetWorldMatrices()[0].toArray();
            expect(Array.from(cm).every((v) => v === 0)).toBe(true);
            expect(backend.getMemberFades(h)).toEqual({ model: 1 });
        });

        it('keeps the capsule for a def with neither an atlas nor a body', () => {
            // Host exposes the model API, but this def has no entry in it.
            const models = new Map([[99, bodyFactory(99)]]);
            const { backend, scene } = makeBackend(new Set(), { models });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 100, 0, 6, 0, 0);
            backend.flush();

            expect(findMesh(scene, 'squadMember_t0')!.thinInstanceCount).toBe(1);
            expect(backend.getMemberFades(h)).toEqual({ capsule: true });
        });
    });

    // Vehicles are several geometry pieces (fable_tank: hull / tracks_l /
    // tracks_r / turret / barrel); one pool per piece, not one per member.
    describe('multi-piece member bodies', () => {
        it('thin-instances every piece against its own rest pose', () => {
            const models = new Map([[7, bodyFactory(7)]]);
            const { backend, scene } = makeBackend(
                new Set(), { models, extraPieces: 2 });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 100, 0, 8, 0, 0);
            backend.flush();

            const body = findMesh(scene, 'memberModel_d7')!;
            const p1 = findMesh(scene, 'memberPiece_d7_p1')!;
            const p2 = findMesh(scene, 'memberPiece_d7_p2')!;
            expect(body.thinInstanceCount).toBe(1);
            expect(p1.thinInstanceCount).toBe(1);
            expect(p2.thinInstanceCount).toBe(1);
            // Each piece carries ITS OWN rest translation (0 / +3 / +6 in Y)
            // on top of the shared member position.
            const yOf = (m: Mesh) => m.thinInstanceGetWorldMatrices()[0].getTranslation().y;
            expect(yOf(body)).toBeCloseTo(0);
            expect(yOf(p1)).toBeCloseTo(3);
            expect(yOf(p2)).toBeCloseTo(6);
        });

        it('frees every piece slot when the member leaves the model tier', () => {
            const models = new Map([[7, bodyFactory(7)]]);
            const { backend, scene } = makeBackend(
                new Set([7]), { models, impostorDist: 900, extraPieces: 2 });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 100, 0, 8, 0, 0);       // close → model
            backend.flush();
            const pieces = [
                findMesh(scene, 'memberModel_d7')!,
                findMesh(scene, 'memberPiece_d7_p1')!,
                findMesh(scene, 'memberPiece_d7_p2')!,
            ];

            backend.updateMember(h, -3000, 0, 3000, 0, 0);  // far → sprite
            backend.flush();
            for (const m of pieces) {
                const mm = m.thinInstanceGetWorldMatrices()[0].toArray();
                expect(Array.from(mm).every((v) => v === 0)).toBe(true);
            }
            expect(findMesh(scene, 'squadSprite_d7_t0')!.thinInstanceCount).toBe(1);
        });

        it('applies the crossfade opacity to every piece at once', () => {
            const models = new Map([[7, bodyFactory(7)]]);
            const { backend } = makeBackend(
                new Set([7]), { models, impostorDist: 900, extraPieces: 2 });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            // Inside the [765,900] band → partial model opacity.
            backend.updateMember(h, 100, 50, 820, 0, 0);
            backend.flush();

            const fades = backend.getMemberFades(h);
            expect(fades.model).toBeGreaterThan(0);
            expect(fades.model).toBeLessThan(1);
            const perPiece = backend.getModelFades(h);
            expect(perPiece).toHaveLength(3);
            // A body that dissolved piece-by-piece would read as a broken model.
            for (const f of perPiece!) expect(f).toBeCloseTo(fades.model!);
        });
    });

    // --- M13 fix 2: the de-plumbed updateMember preamble --------------------
    //
    // updateMember runs once per rendered member per frame (7 200/frame at the
    // L-battle) and M12 attributed 14.2 % of the whole `entity` phase to it,
    // most of it in the preamble rather than the work. M13 replaced the handle
    // Map with a dense recycled array, the per-call `fallback` closure with a
    // flag, and the `${defId}:${team}` sprite-pool key with a cached pool. The
    // pre-fix path stays reachable so the win can be A/B'd in-session — so both
    // arms have to agree, and the recycling must not let a stale handle alias a
    // live member.
    describe('M13 de-plumbed member lookup', () => {
        afterEach(() => setLegacyBackendPlumbing(false));

        it('ships with the legacy arm off', () => {
            expect(setLegacyBackendPlumbing(false)).toBe(false);
        });

        it('recycles a released handle instead of growing the table forever', () => {
            const { backend } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const first = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.releaseMember(first);
            const second = backend.createMember(1, 1, { defId: 7, variant: 0 });
            // An icon<->full LOD flip releases and recreates every member of a
            // squad, so a monotonic counter would grow without bound.
            expect(second).toBe(first);
        });

        it('a recycled handle addresses the NEW member, and the old one is gone', () => {
            const { backend } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 5, 0, 5, 0, 0);
            backend.releaseMember(h);
            // Stale writes through the released handle must not resurrect it.
            backend.updateMember(h, 9, 0, 9, 0, 0);
            expect(backend.getMemberFades(h)).toEqual({});

            const reused = backend.createMember(1, 1, { defId: 7, variant: 0 });
            expect(reused).toBe(h);
            backend.updateMember(reused, 11, 0, 11, 0, 0);
            expect(backend.getMemberFades(reused).sprite).toBe(1);
        });

        it('member and wreck handles stay in separate tables even when they collide', () => {
            const { backend } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const member = backend.createMember(1, 0, { defId: 7, variant: 0 });
            const wreck = backend.spawnWreck(3, 0, 3, 0, {});
            backend.updateMember(member, 5, 0, 5, 0, 0);
            // Despawning a wreck whose id happens to equal a live member's must
            // not touch the member.
            backend.despawnWreck(wreck);
            if (wreck === member) backend.despawnWreck(member);
            expect(backend.getMemberFades(member).sprite).toBe(1);
        });

        it('places a member identically with the legacy arm on and off', () => {
            const models = new Map([[7, bodyFactory(7)]]);
            const read = (legacy: boolean) => {
                setLegacyBackendPlumbing(legacy);
                const { backend, scene } = makeBackend(
                    new Set([7]), { models, impostorDist: 900 });
                backend.setSquadTeam(1, 0);
                const near = backend.createMember(1, 0, { defId: 7, variant: 0 });
                const far = backend.createMember(1, 1, { defId: 7, variant: 0 });
                backend.updateMember(near, 100, 50, 10, 0.3, 0.5);   // model tier
                backend.updateMember(far, 100, 50, 2000, 0.3, 0.5);  // sprite tier
                backend.flush();
                const sprite = findMesh(scene, 'squadSprite_d7_t0')!;
                return {
                    nearFades: backend.getMemberFades(near),
                    farFades: backend.getMemberFades(far),
                    spriteMatrices: sprite.thinInstanceGetWorldMatrices()
                        .map((m) => Array.from(m.toArray())),
                };
            };
            expect(read(false)).toEqual(read(true));
        });

        it('caches the sprite pool per entry without changing which pool it is', () => {
            const { backend, scene } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            backend.setSquadTeam(2, 3);
            const a = backend.createMember(1, 0, { defId: 7, variant: 0 });
            const b = backend.createMember(2, 0, { defId: 7, variant: 0 });
            backend.updateMember(a, 5, 0, 5, 0, 0);
            backend.updateMember(b, 6, 0, 6, 0, 0);
            backend.flush();
            // Different teams must still land in different pools — a cache keyed
            // on the wrong thing would collapse them into one.
            expect(findMesh(scene, 'squadSprite_d7_t0')).toBeDefined();
            expect(findMesh(scene, 'squadSprite_d7_t3')).toBeDefined();
            expect(backend.getMemberFades(a).sprite).toBe(1);
            expect(backend.getMemberFades(b).sprite).toBe(1);
        });
    });

    it('a released sprite slot stops rendering and is reusable', () => {
        const { backend, scene } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 5, 0, 5, 0, 0);
        backend.releaseMember(h);
        backend.flush();
        const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
        // Slot collapsed to zero scale — matrix is all zeros.
        const m = mesh.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(m).every((v) => v === 0)).toBe(true);
    });

    // --- per-frame buffer binding (PLAN-perf M21) ---------------------------
    //
    // `thinInstanceSetBuffer` disposes and re-creates the GPU buffer on every
    // call. The pre-M21 flush called it three times per pool per frame, which
    // measured 54 % of the per-member `entity` floor at the XL-battle. The
    // steady state must bind once and then upload in place — but a pool that
    // GREW has brand-new typed arrays and MUST re-bind, or it would render
    // frozen at its old capacity.
    describe('thin-instance buffer binding', () => {
        type SetBufferFn = (...a: unknown[]) => unknown;
        let restoreRebindCounter: (() => void) | null = null;
        let restoreBboxCounter: (() => void) | null = null;

        /** Count `thinInstanceSetBuffer` calls across all meshes. Babylon
         *  assigns it directly onto `Mesh.prototype`, so the patch must be
         *  restored by re-assigning the original — deleting the key removes
         *  Babylon's own method. */
        function countRebinds(): () => number {
            let n = 0;
            const proto = Mesh.prototype as unknown as { thinInstanceSetBuffer: SetBufferFn };
            const orig = proto.thinInstanceSetBuffer;
            proto.thinInstanceSetBuffer = function (this: Mesh, ...a: unknown[]) {
                n++;
                return orig.apply(this, a);
            };
            restoreRebindCounter = () => { proto.thinInstanceSetBuffer = orig; };
            return () => n;
        }

        afterEach(() => {
            restoreRebindCounter?.();
            restoreRebindCounter = null;
            restoreBboxCounter?.();
            restoreBboxCounter = null;
            setLegacyBufferRebind(false);
            setBboxRefreshEvery(15);
        });

        it('does not re-bind buffers on a steady-state flush', () => {
            const { backend } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 5, 0, 5, 0, 0);
            backend.flush();               // first flush binds

            const read = countRebinds();
            for (let f = 0; f < 10; f++) {
                backend.updateMember(h, 5 + f, 0, 5, 0, 0);
                backend.flush();
            }
            expect(read()).toBe(0);
        });

        it('still publishes moved members after the binding flush', () => {
            const { backend, scene } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 5, 0, 5, 0, 0);
            backend.flush();
            backend.updateMember(h, 111, 0, 222, 0, 0);
            backend.flush();
            const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
            // The read-back cache must not still hold the first pose.
            const m = mesh.thinInstanceGetWorldMatrices()[0].toArray();
            expect(m[12]).toBeCloseTo(111, 3);
            expect(m[14]).toBeCloseTo(222, 3);
        });

        it('re-binds after a pool grows, so the new arrays reach the GPU', () => {
            const { backend, scene } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const handles: number[] = [];
            // Default pool capacity is 64 — cross it so growPool() runs.
            for (let i = 0; i < 65; i++) {
                const h = backend.createMember(1, i, { defId: 7, variant: 0 });
                backend.updateMember(h, i, 0, i * 2, 0, 0);
                handles.push(h);
            }
            backend.flush();
            const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
            expect(mesh.thinInstanceCount).toBe(65);
            // The member past the old capacity must be at its real pose, which
            // is only true if the grown arrays were re-bound.
            const m = mesh.thinInstanceGetWorldMatrices()[64].toArray();
            expect(m[12]).toBeCloseTo(64, 3);
            expect(m[14]).toBeCloseTo(128, 3);
        });

        /** Count `thinInstanceRefreshBoundingInfo` calls across all meshes. */
        function countBboxRefresh(): () => number {
            let n = 0;
            const proto = Mesh.prototype as unknown as { thinInstanceRefreshBoundingInfo: SetBufferFn };
            const orig = proto.thinInstanceRefreshBoundingInfo;
            proto.thinInstanceRefreshBoundingInfo = function (this: Mesh, ...a: unknown[]) {
                n++;
                return orig.apply(this, a);
            };
            restoreBboxCounter = () => { proto.thinInstanceRefreshBoundingInfo = orig; };
            return () => n;
        }

        it('refreshes bounding info on a cadence, not every flush', () => {
            setBboxRefreshEvery(5);        // before the binding flush arms it
            const { backend } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 5, 0, 5, 0, 0);
            backend.flush();               // binds + refreshes, countdown := 5

            const read = countBboxRefresh();
            for (let f = 0; f < 20; f++) {
                backend.updateMember(h, 5 + f, 0, 5, 0, 0);
                backend.flush();
            }
            // Period 5 over 20 flushes — 3 refreshes, not 20.
            expect(read()).toBe(3);
        });

        it('refreshes immediately when a pool grows, never on a stale box', () => {
            const { backend } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const first = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(first, 0, 0, 0, 0, 0);
            backend.flush();

            setBboxRefreshEvery(1000);     // would otherwise never refresh again
            const read = countBboxRefresh();
            // Cross the default capacity of 64 so growPool() runs.
            for (let i = 1; i < 65; i++) {
                const h = backend.createMember(1, i, { defId: 7, variant: 0 });
                backend.updateMember(h, i * 10, 0, 0, 0, 0);
            }
            backend.flush();
            expect(read()).toBe(1);
        });

        it('the legacy arm restores the per-frame re-bind, for the A/B', () => {
            const { backend } = makeBackend(new Set([7]));
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 5, 0, 5, 0, 0);
            backend.flush();

            setLegacyBufferRebind(true);
            const read = countRebinds();
            backend.updateMember(h, 6, 0, 6, 0, 0);
            backend.flush();
            setLegacyBufferRebind(false);
            // matrix + impostorCell + ditherFade on a sprite pool.
            expect(read()).toBe(3);
        });
    });
});

// --- instance-pool compaction (PLAN-perf M24) -------------------------------
//
// `freeSlot()` returns an index to the free list; before M24 nothing ever
// lowered `pool.highWater`, so a pool that had churned kept uploading and
// drawing its dead slots forever. Measured live at the XL-battle with the M23
// `icon` tier engaged: 4 550 dead slots against 10 508 live ones, one sprite
// pool at 1 074 live and 4 896 drawn.
//
// Every fixture here is deliberately NON-UNIFORM — mixed squad sizes and an
// INTERLEAVED release pattern. That is M23's lesson applied: a fixture whose
// inputs are all one size cannot exercise a path whose trigger is
// non-uniformity, and the cheap "lower highWater past the contiguous free
// suffix" implementation passes every free-the-tail test while recovering
// nothing in the case that actually occurs in play.
describe('SquadRenderBackend instance-pool compaction (M24)', () => {
    afterEach(() => {
        setPoolCompaction(true);
        setPoolCompactionGate(0.10, 32);   // the shipped default
    });

    interface Live { h: number; x: number; z: number; }

    /** Fill one sprite pool from squads of DIFFERENT sizes, each member at its
     *  own (x, z) so a slot that moves to the wrong place is visible. */
    function spawnBand(
        backend: SquadRenderBackend, sizes: number[], defId = 7,
    ): Live[] {
        const live: Live[] = [];
        let squadId = 1;
        let n = 0;
        for (const size of sizes) {
            backend.setSquadTeam(squadId, 0);
            for (let i = 0; i < size; i++) {
                const h = backend.createMember(squadId, i, { defId, variant: 0 });
                const x = 10 + n * 3;
                const z = 20 + (n % 7) * 5;
                backend.updateMember(h, x, 0, z, 0, 0);
                live.push({ h, x, z });
                n++;
            }
            squadId++;
        }
        return live;
    }

    /** The (x, z) of every slot the pool actually DRAWS this frame, as a set —
     *  order is irrelevant, occupancy is not. Reads back through the mesh, so
     *  it sees exactly what was uploaded. */
    function drawnPositions(scene: Scene, prefix: string): Set<string> {
        const mesh = findMesh(scene, prefix)!;
        const out = new Set<string>();
        const mats = mesh.thinInstanceGetWorldMatrices();
        for (let i = 0; i < mesh.thinInstanceCount; i++) {
            const m = mats[i].toArray();
            out.add(`${Math.round(m[12])},${Math.round(m[14])}`);
        }
        return out;
    }

    it('drops the drawn count to the live count after interleaved releases', () => {
        const { backend, scene } = makeBackend(new Set([7]));
        const live = spawnBand(backend, [17, 9, 31, 4, 22]);   // 83, non-uniform
        backend.flush();
        expect(backend.poolOccupancy().drawn).toBe(83);

        // Interleaved, NOT a tail: every third member, plus a couple of runs.
        const killed = new Set<number>();
        live.forEach((m, i) => {
            if (i % 3 === 0 || (i >= 40 && i < 46)) {
                backend.releaseMember(m.h);
                killed.add(i);
            }
        });
        const survivors = live.filter((_, i) => !killed.has(i));
        backend.flush();

        const occ = backend.poolOccupancy();
        expect(occ.live).toBe(survivors.length);
        expect(occ.drawn).toBe(survivors.length);   // pre-M24 this stayed 83
        expect(occ.dead).toBe(0);

        // And the survivors are all still drawn, each at its own place.
        const drawn = drawnPositions(scene, 'squadSprite_d7_t0');
        expect(drawn.size).toBe(new Set(
            survivors.map((m) => `${m.x},${m.z}`)).size);
        for (const m of survivors) {
            expect(drawn.has(`${m.x},${m.z}`)).toBe(true);
        }
    });

    it('a moved slot still answers to its own handle afterwards', () => {
        const { backend, scene } = makeBackend(new Set([7]));
        const live = spawnBand(backend, [13, 28, 7, 19]);
        backend.flush();

        // Release every other index — forces high-index survivors down into
        // low-index holes.
        const killed = new Set<number>();
        live.forEach((m, i) => {
            if (i % 2 === 0) { backend.releaseMember(m.h); killed.add(i); }
        });
        backend.flush();

        // Now move a survivor that was near the TOP of the old range: if its
        // `MemberSlot.index` was not rewritten, this writes over someone else.
        const mover = live.filter((_, i) => !killed.has(i)).pop()!;
        backend.updateMember(mover.h, 900, 0, 700, 0, 0);
        backend.flush();

        const drawn = drawnPositions(scene, 'squadSprite_d7_t0');
        expect(drawn.has('900,700')).toBe(true);
        expect(drawn.has(`${mover.x},${mover.z}`)).toBe(false);
        // Nobody else lost their slot.
        for (const m of live.filter((_, i) => !killed.has(i))) {
            if (m.h === mover.h) continue;
            expect(drawn.has(`${m.x},${m.z}`)).toBe(true);
        }
    });

    it('reuses the recovered range instead of growing the pool', () => {
        const { backend } = makeBackend(new Set([7]));
        const live = spawnBand(backend, [21, 14, 33]);
        backend.flush();
        const grown = backend.poolOccupancy().capacity;

        live.forEach((m, i) => { if (i % 2 === 0) backend.releaseMember(m.h); });
        backend.flush();
        const after = backend.poolOccupancy();
        expect(after.drawn).toBe(after.live);

        // Refill to the original size: it must fit in the compacted pool.
        backend.setSquadTeam(99, 0);
        for (let i = 0; i < 34; i++) {
            const h = backend.createMember(99, i, { defId: 7, variant: 0 });
            backend.updateMember(h, 500 + i * 2, 0, 500, 0, 0);
        }
        backend.flush();
        const refilled = backend.poolOccupancy();
        expect(refilled.drawn).toBe(refilled.live);
        expect(refilled.capacity).toBe(grown);
    });

    it('leaves the pool alone until the gate trips', () => {
        const { backend } = makeBackend(new Set([7]));
        const live = spawnBand(backend, [40, 30, 30]);
        backend.flush();

        // 8 dead out of 100 — under both halves of the default gate.
        for (let i = 0; i < 8; i++) backend.releaseMember(live[i * 7].h);
        backend.flush();
        expect(backend.poolOccupancy().drawn).toBe(100);
        expect(backend.poolOccupancy().dead).toBe(8);

        // Same pool, gate lowered: now it compacts, same frame.
        setPoolCompactionGate(0.01, 1);
        backend.flush();
        const occ = backend.poolOccupancy();
        expect(occ.drawn).toBe(92);
        expect(occ.dead).toBe(0);
    });

    it('the shipped gate trips at the dead fraction the XL-battle actually reaches', () => {
        // M24 measured the XL-battle's worst pool sitting at 13.5 % dead at the
        // shipped `lodDrawnMemberBudget`. A gate above that leaves the feature
        // inert in the configuration that ships, which is what the first pass
        // did (it was 0.15) — so pin the default against the field number.
        const { backend } = makeBackend(new Set([7]));
        const live = spawnBand(backend, [120, 65, 115]);
        backend.flush();
        expect(backend.poolOccupancy().drawn).toBe(300);

        for (let i = 0; i < 41; i++) backend.releaseMember(live[i * 7].h);  // 13.7 %
        backend.flush();
        expect(backend.poolOccupancy().drawn).toBe(259);
        expect(backend.poolOccupancy().dead).toBe(0);
    });

    it('the legacy arm never lowers the drawn count, for the A/B', () => {
        const { backend } = makeBackend(new Set([7]));
        const live = spawnBand(backend, [25, 11, 40]);
        backend.flush();

        setPoolCompaction(false);
        live.forEach((m, i) => { if (i % 2 === 0) backend.releaseMember(m.h); });
        backend.flush();
        const off = backend.poolOccupancy();
        expect(off.drawn).toBe(76);
        expect(off.dead).toBe(38);

        setPoolCompaction(true);
        backend.flush();
        expect(backend.poolOccupancy().drawn).toBe(38);
    });

    it('moves every piece of a multi-piece body together', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend } = makeBackend(new Set([7]), {
            models, extraPieces: 2, impostorDist: 10,
        });
        // impostorDistance 10 with the camera at (100, 50, 0): members near the
        // camera hold the MODEL tier, so this fills three model pools at once.
        // Held well inside the crossfade band's lower edge, so these members
        // hold model slots only and the pool counts are unambiguous.
        const live: Live[] = [];
        backend.setSquadTeam(1, 0);
        for (let i = 0; i < 100; i++) {
            const h = backend.createMember(1, i, { defId: 7, variant: 0 });
            backend.updateMember(h, 100, 50, i * 0.01, 0, 0);
            live.push({ h, x: 100, z: i * 0.01 });
        }
        backend.flush();
        const before = backend.poolOccupancy();
        expect(before.drawn).toBe(100 * 3);

        live.forEach((m, i) => { if (i % 2 === 0) backend.releaseMember(m.h); });
        backend.flush();
        const after = backend.poolOccupancy();
        expect(after.drawn).toBe(50 * 3);
        expect(after.dead).toBe(0);
        // Every surviving member still holds one slot per piece.
        for (const m of live.filter((_, i) => i % 2 === 1)) {
            expect(backend.getModelFades(m.h)?.length).toBe(3);
        }
    });

    it('keeps wreck handles addressing their own wreck across a compaction', () => {
        const { backend, scene } = makeBackend(new Set([7]));
        const wrecks: { h: number; x: number }[] = [];
        for (let i = 0; i < 80; i++) {
            const x = 200 + i * 4;
            wrecks.push({ h: backend.spawnWreck(x, 0, 300, 0, null), x });
        }
        backend.flush();

        // Interleaved despawns, then compact.
        const gone = new Set<number>();
        wrecks.forEach((w, i) => {
            if (i % 3 !== 1) { backend.despawnWreck(w.h); gone.add(i); }
        });
        backend.flush();
        const survivors = wrecks.filter((_, i) => !gone.has(i));
        const occ = backend.poolOccupancy();
        expect(occ.drawn).toBe(occ.live);

        // Fading a surviving wreck must shrink ITS box, not a neighbour's.
        const target = survivors[survivors.length - 1];
        backend.fadeWreck(target.h, 0.25);
        backend.flush();
        const mesh = findMesh(scene, 'squadWreck')!;
        const mats = mesh.thinInstanceGetWorldMatrices();
        let faded = 0;
        for (let i = 0; i < mesh.thinInstanceCount; i++) {
            const m = mats[i].toArray();
            if (Math.abs(m[0] - 0.25) < 1e-6) {
                faded++;
                expect(Math.round(m[12])).toBe(target.x);
            }
        }
        expect(faded).toBe(1);
    });
});
