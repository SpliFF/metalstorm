/**
 * WorkerBuildPlacement — DOM-free build-placement / ghost core for the
 * game-processor worker (PLAN-playable.md G3a).
 *
 * Ports the *build-placement* subsystem of `input-manager.ts` (which ran on the
 * main thread pre-GW4 and is DOM-coupled: canvas `mousemove` listeners,
 * `getBoundingClientRect`, `window` ESC handling). Here the worker owns the
 * Babylon scene + per-view camera + WebTransport connection; the main-thread
 * `CameraInput` forwards canvas-relative CSS-pixel pointer events, and the
 * native `BuildMenu` (DOM, on main) arms placement by posting
 * `gp:startBuildPlacement`.
 *
 * Behaviour (faithful to input-manager.ts §build-placement):
 *   - Pure factory selection → queue the build immediately via a `-defId`
 *     command with no ground click (batch multipliers from shift/ctrl).
 *   - Builder selection → enter ghost-placement mode; a left-click on the
 *     ground emits the build order. Shift keeps placement armed (chain-build).
 *   - Metal extractors (`extractsMetal > 0` or `customParams.ismex == '1'`)
 *     snap the ghost to the nearest metal spot; red when no spot is in range.
 *   - `snapToBuildGrid` is a byte-identical port of Recoil's
 *     `CGameHelper::Pos2BuildPos` — the grid ZK's `mex_spot_finder` keys on.
 *
 * NOT ported here (deferred to G3b, the milestone that ports the rest of
 * input-manager.ts's drag gestures): build-drag rows/rectangles
 * (`computeBuildPositions`), the pending-build promote-to-marker lifecycle
 * (`promoteGhostToPending`/`onCommandQueuesUpdated`), waypoint drag, area-attack
 * drag, and modal hotkey commands.
 *
 * FIDELITY-STANDIN: for non-mex placements this reproduces input-manager.ts's
 * original behaviour, which has NO terrain-slope / yardmap / existing-unit
 * collision test — any successful ground pick is accepted. Recoil's
 * `CGameHelper::TestUnitBuildSquare` (slope / yardmap / unit overlap) is not
 * ported; the server still rejects genuinely-illegal placements, so this only
 * affects the client-side red/green ghost hint. Called out per CLAUDE.md.
 */

import {
    Scene,
    FreeCamera,
    Vector3,
    Mesh,
    TransformNode,
    MeshBuilder,
    StandardMaterial,
    Color3,
} from '@babylonjs/core';
import type { EntityRenderer } from './entity-renderer.js';
import type { Connection } from './connection.js';
import type { DefCache } from './def-cache.js';
import { CommandBuffer, OPT } from './command-buffer.js';
import { nearestMetalSpot, type MetalSpot } from './metal-spots.js';

/// Bit 11 of UnitDef.flags marks a factory (see protocol.fbs). Exported —
/// PLAN-playable.md G4 reuses it in game-processor.ts to find the selected
/// factory for the native factory-queue panel.
export const UNITDEF_FLAG_IS_FACTORY = 1 << 11;

/**
 * Mirror of `CGameHelper::Pos2BuildPos` — snap a world position to Spring's
 * 16-elmo build grid with a parity offset based on bit 1 of the unit's
 * footprint (engine checks `xsize & 2`, NOT `xsize & 1`): xsize ∈ {2, 3, 6,
 * 7, ...} centres on 16k+8, the rest line up on 16k. ZK's
 * `mex_spot_finder.AdjustCoordinates` produces the same grid, so reusing it
 * here keeps the build position aligned with `metalSpotsByPos[x][z]` lookups
 * in `mex_placement.AllowCommand` (otherwise mex builds get silently dropped).
 *
 * Byte-identical to the input-manager.ts port — do NOT "improve" the math.
 */
export function snapToBuildGrid(x: number, z: number, xsize: number, zsize: number): [number, number] {
    const sx = (xsize & 2)
        ? Math.floor(x / 16) * 16 + 8
        : Math.floor((x + 8) / 16) * 16;
    const sz = (zsize & 2)
        ? Math.floor(z / 16) * 16 + 8
        : Math.floor((z + 8) / 16) * 16;
    return [sx, sz];
}

/** Live ghost state posted to main via `gp:sceneState.buildGhost` (a HUD /
 *  cursor-styling readout — the 3D ghost mesh itself stays in-worker). */
export interface BuildGhostState {
    pos: [number, number, number];
    defId: number;
    valid: boolean;
}

export interface WorkerBuildPlacementOpts {
    /** Resolve the FreeCamera for a viewId (per-view picking; G3a ships view 0). */
    getCamera: (viewId: number) => FreeCamera | null;
    /** Current device-pixel-ratio (scene.pick works in backing-store px). */
    getDpr: () => number;
    /** The worker's shared def cache (footprints, costs, mex/factory flags). */
    getDefCache: () => DefCache | null;
    /** The current selection set (owned by WorkerSelection). */
    getSelection: () => readonly number[];
    /** Metal-spot centroids (computed once from the parsed map data). */
    getMetalSpots: () => readonly MetalSpot[];
    /** World elmos per metalmap cell — scales the mex snap search radius. */
    getMetalCellSize: () => number;
}

/// One-time FIDELITY-STANDIN warning latch (see file header).
let warnedNoValidityCheck = false;

export class WorkerBuildPlacement {
    private readonly scene: Scene;
    private readonly entityRenderer: EntityRenderer;
    private readonly commandBuffer: CommandBuffer;
    private readonly opts: WorkerBuildPlacementOpts;

    /// Non-null while a builder placement is armed (factories queue instantly
    /// with no ghost, so they never populate this).
    private placement: {
        defId: number;
        ghost: TransformNode;
        /// True when `ghost` is the procedural box fallback (no model loaded
        /// yet). Box ghosts carry their material directly; mesh ghosts share a
        /// single StandardMaterial across piece clones.
        ghostIsBox: boolean;
        footprintX: number;
        footprintZ: number;
        isMex: boolean;
        mexSnapRadius: number;
        /// Last evaluated metal spot under the cursor (null = none in range).
        snappedSpot: MetalSpot | null;
        defaultEmissive: Color3;
        /// Last grid-snapped ghost world position (null until first move).
        lastPos: Vector3 | null;
        /// Whether the last-evaluated position is a valid placement (mex in
        /// range; always true for non-mex given a successful ground pick).
        valid: boolean;
    } | null = null;

    /// Left-button press captured while armed. Committed on pointerUp; the
    /// shift bit is captured at press time (Spring's build-drag convention).
    private downShift = false;

    constructor(
        scene: Scene,
        entityRenderer: EntityRenderer,
        connection: Connection,
        opts: WorkerBuildPlacementOpts,
    ) {
        this.scene = scene;
        this.entityRenderer = entityRenderer;
        this.commandBuffer = new CommandBuffer(connection);
        this.opts = opts;
    }

    /** True while a builder placement is armed (drives pointer interception +
     *  the sceneState buildGhost readout). */
    get isActive(): boolean {
        return this.placement !== null;
    }

    /** Snapshot for `gp:sceneState.buildGhost`. Null when nothing is armed. */
    getGhostState(): BuildGhostState | null {
        const p = this.placement;
        if (!p) return null;
        const pos = p.lastPos;
        return {
            pos: pos ? [pos.x, pos.y, pos.z] : [0, 0, 0],
            defId: p.defId,
            valid: p.valid,
        };
    }

    // ---- Arm / disarm ----

    /**
     * Handle a build-button pick from the native BuildMenu.
     *   - all factories            → queue the build immediately, no ghost
     *   - any mobile/static builder → enter ghost-placement mode
     * Mixed selections fall through to ghost mode — factories receive the same
     * `-defId` order and ignore the position params (FactoryCAI looks the cmdID
     * up in its buildOptions table).
     *
     * Modifiers forward to the Command options bitmask:
     *   - factories: shift=×5, ctrl=×20, shift+ctrl=×100 batch counts
     *     (FactoryCAI::GetCountMultiplierFromOptions; OTA convention).
     *   - builders: shift queues the build and keeps placement mode open.
     */
    startBuildPlacement(defId: number, mods: { shift?: boolean; ctrl?: boolean } = {}): void {
        const shift = !!mods.shift;
        const ctrl = !!mods.ctrl;

        // Replace any existing placement (rapid button switch).
        this.cancelBuildPlacement();

        const selection = this.opts.getSelection();
        if (selection.length === 0) return;

        // Pure factory selection: queue immediately, skip ground placement.
        if (this.allSelectedAreFactories()) {
            const options = (shift ? OPT.SHIFT : 0) | (ctrl ? OPT.CONTROL : 0);
            this.commandBuffer.issueImmediate(-defId, [...selection], [], options);
            return;
        }

        const defCache = this.opts.getDefCache();
        const def = defCache?.getUnitDef(defId);
        // Spring's xsize/zsize are already in elmos (footprint*2 heightmap
        // squares × 8 elmos). Default 2×2 (=32 elmos) if the def hasn't
        // streamed — the ghost is a hint, not a constraint.
        const fpX = (def?.xsize ?? 4) * 8;
        const fpZ = (def?.zsize ?? 4) * 8;

        // Build the ghost mesh — the unit's real model first so the player sees
        // what they're placing; box fallback if the model isn't loaded or the
        // build throws (placement must work even if the ghost doesn't render).
        const baseEmissive = new Color3(0.15, 0.4, 0.2);
        let ghost: TransformNode;
        let ghostIsBox = false;
        try {
            const meshGhost = this.entityRenderer.createGhostMesh(defId, `build-ghost-${defId}`);
            if (meshGhost) {
                ghost = meshGhost;
            } else {
                ghost = makeBoxGhost(this.scene, fpX, fpZ, baseEmissive);
                ghostIsBox = true;
            }
        } catch (err) {
            console.warn('[build-placement] unit-mesh ghost failed, using box', err);
            ghost = makeBoxGhost(this.scene, fpX, fpZ, baseEmissive);
            ghostIsBox = true;
        }
        // Park off-screen until the first pointer move places it.
        ghost.position.set(-1e6, 0, 0);

        // Metal extractors snap to metal spots. Two markers are detected:
        //   - vanilla Spring: `UnitDef.extractsMetal > 0`
        //   - ZK:             `customParams.ismex == "1"` (ZK does extraction in Lua)
        const isMex = (def?.extractsMetal ?? 0) > 0 || def?.customParams?.ismex === '1';
        const mexSnapRadius = Math.max(96, this.opts.getMetalCellSize() * 4);

        this.placement = {
            defId, ghost, ghostIsBox, footprintX: fpX, footprintZ: fpZ,
            isMex, mexSnapRadius, snappedSpot: null, defaultEmissive: baseEmissive,
            lastPos: null, valid: false,
        };
    }

    cancelBuildPlacement(): void {
        if (this.placement) {
            this.placement.ghost.dispose();
            this.placement = null;
        }
    }

    // ---- Pointer routing (called by the worker dispatcher BEFORE selection) ----

    /** Left-button press while armed → capture the click (suppresses
     *  selection/drag-box). Returns true when consumed. */
    pointerDown(x: number, y: number, button: number, mods: number, viewId = 0): boolean {
        if (!this.placement || button !== 0) return false;
        this.downShift = (mods & 1) !== 0;
        // Position the ghost at the press point so a click-without-move still
        // resolves to the right tile.
        this.updateGhost(x, y, viewId);
        return true;
    }

    /** Pointer move while armed → terrain-follow the ghost. */
    pointerMove(x: number, y: number, _buttons: number, _mods: number, viewId = 0): void {
        if (!this.placement) return;
        this.updateGhost(x, y, viewId);
    }

    /** Left-button release while armed → commit the build order. Returns true
     *  when consumed. Shift (captured at press) queues + keeps placement armed. */
    pointerUp(x: number, y: number, button: number, _mods: number, viewId = 0): boolean {
        if (!this.placement || button !== 0) return false;
        const groundPos = this.pickGroundAt(x, y, viewId);
        if (groundPos) this.issueBuildAt(groundPos, this.downShift);
        return true;
    }

    // ---- Ghost update ----

    private updateGhost(cssX: number, cssY: number, viewId: number): void {
        const p = this.placement;
        if (!p) return;
        const groundPos = this.pickGroundAt(cssX, cssY, viewId);
        if (!groundPos) return;

        const def = this.opts.getDefCache()?.getUnitDef(p.defId);
        const xsize = def?.xsize ?? 4;
        const zsize = def?.zsize ?? 4;

        if (p.isMex) {
            // Mex placement snaps to the nearest metal spot; out of range means
            // the build won't extract anything — tint red + mark invalid.
            const spot = nearestMetalSpot(this.opts.getMetalSpots(), groundPos.x, groundPos.z, p.mexSnapRadius);
            if (spot) {
                const [sx, sz] = snapToBuildGrid(spot.x, spot.z, xsize, zsize);
                p.snappedSpot = { ...spot, x: sx, z: sz };
                p.ghost.position.set(sx, groundPos.y + 0.5, sz);
                p.lastPos = new Vector3(sx, groundPos.y, sz);
                p.valid = true;
                this.tintGhost(p.ghost, p.ghostIsBox, p.defaultEmissive);
            } else {
                p.snappedSpot = null;
                p.ghost.position.set(groundPos.x, groundPos.y + 0.5, groundPos.z);
                p.lastPos = groundPos.clone();
                p.valid = false;
                this.tintGhost(p.ghost, p.ghostIsBox, new Color3(0.5, 0.05, 0.05));
            }
            return;
        }

        // Standard build: snap to Spring's 16-elmo grid using footprint parity.
        // FIDELITY-STANDIN: no slope/yardmap/collision test (see file header) —
        // a successful terrain pick is treated as a valid placement.
        if (!warnedNoValidityCheck) {
            warnedNoValidityCheck = true;
            console.warn('[build-placement] FIDELITY-STANDIN: non-mex placement has no ' +
                'slope/yardmap/collision check (Recoil CGameHelper::TestUnitBuildSquare ' +
                'not ported); client ghost is always green, the server still validates.');
        }
        const [gx, gz] = snapToBuildGrid(groundPos.x, groundPos.z, xsize, zsize);
        p.ghost.position.set(gx, groundPos.y + 0.5, gz);
        p.lastPos = new Vector3(gx, groundPos.y, gz);
        p.valid = true;
    }

    // ---- Commit ----

    private issueBuildAt(groundPos: Vector3, queue: boolean): void {
        const p = this.placement;
        if (!p) return;
        const defId = p.defId;
        // Default facing south (0). Hold-and-drag facing is a G3b enhancement.
        const facing = 0;

        const def = this.opts.getDefCache()?.getUnitDef(defId);
        const xsize = def?.xsize ?? 4;
        const zsize = def?.zsize ?? 4;
        let x: number, y: number, z: number;
        if (p.isMex) {
            // No spot in range (ghost was red) → drop the click, stay armed so
            // the player can adjust. The spot (x,z) was already grid-snapped in
            // updateGhost so it matches ZK's metalSpotsByPos keys.
            if (!p.snappedSpot) return;
            x = p.snappedSpot.x;
            z = p.snappedSpot.z;
            y = groundPos.y;
        } else {
            [x, z] = snapToBuildGrid(groundPos.x, groundPos.z, xsize, zsize);
            y = groundPos.y;
        }

        // Negative cmdId = build command, -cmdId is the unit-def id. Shift in
        // the options bitfield queues the order behind existing commands.
        const builders = [...this.opts.getSelection()];
        if (builders.length === 0) { this.cancelBuildPlacement(); return; }
        this.commandBuffer.issueImmediate(-defId, builders, [x, y, z, facing], queue ? OPT.SHIFT : 0);

        if (!queue) {
            // Single placement — drop out of placement mode.
            this.cancelBuildPlacement();
        } else {
            // Chain-build: dispose the committed ghost and spawn a fresh hover
            // ghost for the next click.
            p.ghost.dispose();
            let fresh: TransformNode;
            let freshIsBox = false;
            try {
                const meshGhost = this.entityRenderer.createGhostMesh(defId, `build-ghost-${defId}`);
                if (meshGhost) {
                    fresh = meshGhost;
                } else {
                    fresh = makeBoxGhost(this.scene, p.footprintX, p.footprintZ, p.defaultEmissive);
                    freshIsBox = true;
                }
            } catch (err) {
                console.warn('[build-placement] queue ghost failed, using box', err);
                fresh = makeBoxGhost(this.scene, p.footprintX, p.footprintZ, p.defaultEmissive);
                freshIsBox = true;
            }
            fresh.position.set(-1e6, 0, 0);
            p.ghost = fresh;
            p.ghostIsBox = freshIsBox;
            p.snappedSpot = null;
            p.lastPos = null;
            p.valid = false;
        }
    }

    // ---- Helpers ----

    /** Re-tint the ghost emissive. Box ghosts carry their material directly;
     *  mesh ghosts share a single StandardMaterial across all piece clones
     *  (created by EntityRenderer.createGhostMesh), so updating the first
     *  child's material repaints the whole ghost. */
    private tintGhost(ghost: TransformNode, isBox: boolean, color: Color3): void {
        if (isBox) {
            const mat = (ghost as Mesh).material as StandardMaterial;
            if (mat) mat.emissiveColor = color;
            return;
        }
        for (const c of ghost.getChildMeshes()) {
            const mat = c.material as StandardMaterial | null;
            if (mat) { mat.emissiveColor = color; break; }
        }
    }

    /** True if every currently-selected unit is a factory (UnitDef bit 11).
     *  False if any selected unit's def/meta hasn't streamed yet — that falls
     *  back to ghost placement (factories ignore the position params anyway). */
    private allSelectedAreFactories(): boolean {
        const selection = this.opts.getSelection();
        const defCache = this.opts.getDefCache();
        if (selection.length === 0 || !defCache) return false;
        for (const id of selection) {
            const meta = this.entityRenderer.getEntityMeta(id);
            if (!meta) return false;
            const def = defCache.getUnitDef(meta.defId);
            if (!def) return false;
            if (!(def.flags & UNITDEF_FLAG_IS_FACTORY)) return false;
        }
        return true;
    }

    /** Ray-pick the visible terrain mesh under a canvas-relative CSS-px point.
     *  `scene.pick` works in backing-store px (= CSS × dpr), so scale up. Same
     *  pattern as WorkerSelection.pickGroundAt. */
    private pickGroundAt(cssX: number, cssY: number, viewId: number): Vector3 | null {
        const camera = this.opts.getCamera(viewId);
        if (!camera) return null;
        const dpr = this.opts.getDpr();
        const pick = this.scene.pick(cssX * dpr, cssY * dpr, (m) => m.name === 'terrain', false, camera);
        return (pick?.hit && pick.pickedPoint) ? pick.pickedPoint : null;
    }

    dispose(): void {
        this.cancelBuildPlacement();
        this.commandBuffer.dispose();
    }
}

/** Translucent green box of the given footprint — the fallback ghost when the
 *  unit's model isn't loaded or createGhostMesh fails. Caller positions +
 *  disposes it. Ported from input-manager.ts. */
function makeBoxGhost(scene: Scene, fpX: number, fpZ: number, emissive: Color3): Mesh {
    const box = MeshBuilder.CreateBox('build-ghost', { width: fpX, depth: fpZ, height: 24 }, scene);
    const mat = new StandardMaterial('build-ghost-mat', scene);
    mat.diffuseColor = new Color3(0.4, 1.0, 0.5);
    mat.emissiveColor = emissive;
    mat.alpha = 0.45;
    mat.backFaceCulling = false;
    box.material = mat;
    box.isPickable = false;
    box.renderingGroupId = 2;
    return box;
}
