/**
 * WorkerSelection — DOM-free selection / pick / order core for the
 * game-processor worker (PLAN-game-worker.md GW4-c5b-2).
 *
 * Ports the *selection + pick + order* core of `input-manager.ts` (which ran on
 * the main thread pre-GW4 and is DOM-coupled: canvas listeners,
 * `getBoundingClientRect`, a DOM drag-overlay div, `window` keyboard handlers).
 * Here the worker owns the Babylon scene + per-view camera + WebTransport
 * connection, and the main-thread `CameraInput` forwards canvas-relative
 * CSS-pixel pointer events. Left-button gestures (single-click select, drag-box
 * select, shift-additive) and right-click orders (move / attack / guard,
 * team-aware) are handled locally and sent over the worker's own connection —
 * no main hop. The drag-box rectangle is a DOM concern, so it is posted back to
 * main (`onDragBox`) which draws the overlay div.
 *
 * Coordinates arrive as canvas-relative CSS px, origin top-left (the
 * `game-worker-protocol.ts` convention). `scene.pick` and `Vector3.Project`
 * work in backing-store pixels (= CSS × dpr), so screen coords are scaled by
 * `dpr` before picking / projecting.
 *
 * NOT ported (deliberately, per the c5b-2 scope — "the selection/pick/order
 * core, NOT the full build-placement / pending-command / animated-cursor
 * richness"): build placement + ghosts, build-drag rows, waypoint drag,
 * area-attack drag, modal hotkey commands, animated cursors, widget
 * default-command overrides. Those land in c5b-3 / a richer port. Keyboard
 * order hotkeys also stay out for now (the camera owns key input from c5b-1;
 * routing order hotkeys through here is follow-up work).
 */

import {
    Scene,
    FreeCamera,
    Vector3,
    Matrix,
    Viewport,
} from '@babylonjs/core';
import type { EntityRenderer } from './entity-renderer.js';
import type { Connection } from './connection.js';
import { CommandBuffer, CMD, OPT } from './command-buffer.js';

/// Single-click select tolerance, in CSS pixels. Comparing the click pixel to
/// each unit's projected centre handles tall structures uniformly (a ground
/// ray would land far behind a factory footprint). Mirrors input-manager.ts.
const SELECT_PIXEL_RADIUS = 32;

/// How close (world elmos) a right-click has to be to a unit's XZ to target it.
const SELECT_RADIUS = 32;

/// Pixel threshold (CSS px) separating a single-click from a drag-box.
const DRAG_THRESHOLD_PX = 6;

/** Canvas-relative CSS-pixel rectangle for the main-thread drag overlay. */
export interface DragBox { x0: number; y0: number; x1: number; y1: number; }

export interface WorkerSelectionOpts {
    /** Resolve the FreeCamera for a viewId (per-view picking; c5b ships view 0). */
    getCamera: (viewId: number) => FreeCamera | null;
    /** Initial device-pixel-ratio (kept in sync via `setDpr` on resize). */
    dpr: number;
    /** Show/update (box) or hide (null) the main-thread drag-select overlay. */
    onDragBox: (box: DragBox | null) => void;
    /** Notified whenever the selection set changes (feeds the c5c sceneState). */
    onSelectionChange?: (ids: readonly number[]) => void;
}

export class WorkerSelection {
    private readonly scene: Scene;
    private readonly entityRenderer: EntityRenderer;
    private readonly connection: Connection;
    private readonly commandBuffer: CommandBuffer;
    private readonly getCamera: (viewId: number) => FreeCamera | null;
    private readonly onDragBox: (box: DragBox | null) => void;
    private readonly onSelectionChange?: (ids: readonly number[]) => void;
    private dpr: number;

    private selectedIds: number[] = [];

    // Left-drag selection state (CSS px).
    private dragActive = false;
    private dragViewId = 0;
    private dragStartX = 0;
    private dragStartY = 0;
    private dragCurX = 0;
    private dragCurY = 0;
    private dragShift = false;
    /// True once the drag crossed DRAG_THRESHOLD_PX (overlay shown, treated as
    /// a box-select on release rather than a single click).
    private dragMoved = false;

    /// Latest hovered entity under the cursor (-1 = none). Tracked for the c5c
    /// sceneState feed + c6 widget DefaultCommand dispatch; no highlight yet.
    private hoveredId = -1;

    constructor(
        scene: Scene,
        entityRenderer: EntityRenderer,
        connection: Connection,
        opts: WorkerSelectionOpts,
    ) {
        this.scene = scene;
        this.entityRenderer = entityRenderer;
        this.connection = connection;
        this.commandBuffer = new CommandBuffer(connection);
        this.getCamera = opts.getCamera;
        this.onDragBox = opts.onDragBox;
        this.onSelectionChange = opts.onSelectionChange;
        this.dpr = opts.dpr > 0 ? opts.dpr : 1;
    }

    /** Keep the device-pixel-ratio current (called from gpResize). */
    setDpr(dpr: number): void {
        if (dpr > 0) this.dpr = dpr;
    }

    get selection(): readonly number[] { return this.selectedIds; }
    get hovered(): number { return this.hoveredId; }

    // ---- Pointer routing (left button only — camera owns middle/right drag) ----

    /** Left-button press: begin a select / drag-box gesture. */
    pointerDown(x: number, y: number, button: number, mods: number, viewId = 0): void {
        if (button !== 0) return;
        this.dragActive = true;
        this.dragMoved = false;
        this.dragViewId = viewId;
        this.dragStartX = this.dragCurX = x;
        this.dragStartY = this.dragCurY = y;
        this.dragShift = (mods & 1) !== 0;
    }

    /** Pointer move: grow the drag rectangle (if dragging) + track hover. */
    pointerMove(x: number, y: number, _buttons: number, _mods: number, viewId = 0): void {
        if (this.dragActive) {
            this.dragCurX = x;
            this.dragCurY = y;
            const dx = x - this.dragStartX;
            const dy = y - this.dragStartY;
            if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
                this.dragMoved = true;
                this.onDragBox({
                    x0: Math.min(this.dragStartX, x),
                    y0: Math.min(this.dragStartY, y),
                    x1: Math.max(this.dragStartX, x),
                    y1: Math.max(this.dragStartY, y),
                });
            }
            return;
        }
        this.updateHover(x, y, viewId);
    }

    /** Left-button release: resolve the gesture (single-click or box). */
    pointerUp(x: number, y: number, button: number, _mods: number, viewId = 0): void {
        if (button !== 0 || !this.dragActive) return;
        this.dragActive = false;
        this.onDragBox(null);
        this.dragCurX = x;
        this.dragCurY = y;
        if (this.dragMoved) this.handleBoxSelect(viewId);
        else this.handleSingleClick(x, y, viewId);
    }

    /** Focus loss — cancel an in-flight drag so the overlay doesn't stick. */
    blur(): void {
        if (this.dragActive) { this.dragActive = false; this.onDragBox(null); }
    }

    /**
     * Backs `Spring.GetSelectionBox`. Returns the active drag-select
     * rectangle as `[left, top, right, bottom]` in Spring screen coords
     * (device px, Y-up bottom-left origin — the same convention the worker
     * uses for mouse callins + gl.* drawing), or `null` when no box is
     * being drawn. Recoil only reports a box once the drag has actually
     * grown past the click threshold (`dragMoved`), matching
     * `CMouseHandler::GetSelectionBoxVertices`.
     */
    getSelectionBoxScreen(): [number, number, number, number] | null {
        if (!this.dragActive || !this.dragMoved) return null;
        const h = this.scene.getEngine().getRenderHeight();
        const left  = Math.min(this.dragStartX, this.dragCurX) * this.dpr;
        const right = Math.max(this.dragStartX, this.dragCurX) * this.dpr;
        // CSS pointer coords are Y-down top-left; flip to Y-up bottom-left.
        const top    = h - Math.min(this.dragStartY, this.dragCurY) * this.dpr;
        const bottom = h - Math.max(this.dragStartY, this.dragCurY) * this.dpr;
        return [left, top, right, bottom];
    }

    // ---- Selection ----

    private setSelection(ids: number[]): void {
        this.selectedIds = ids;
        this.entityRenderer.setSelection(ids);
        this.onSelectionChange?.(ids);
    }

    /** Programmatic selection (widget `Spring.SelectUnit*`, scenarios). */
    setSelectionExternal(ids: readonly number[]): void {
        const seen = new Set<number>();
        const next: number[] = [];
        for (const id of ids) {
            if (id > 0 && !seen.has(id)) { seen.add(id); next.push(id); }
        }
        this.setSelection(next);
    }

    private handleSingleClick(cssX: number, cssY: number, viewId: number): void {
        const camera = this.getCamera(viewId);
        if (!camera) return;
        // Project each entity to screen space, pick the closest to the click
        // pixel. World-space proximity fails for tall units (the click ray
        // exits the back of the model onto terrain well behind the footprint).
        const cx = cssX * this.dpr;
        const cy = cssY * this.dpr;
        const { viewport, worldMat } = this.projectionContext(camera);
        const identity = Matrix.Identity();
        const tol = SELECT_PIXEL_RADIUS * this.dpr;

        let nearestId = -1;
        let nearestDistSq = tol * tol;
        for (const [id] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const p = Vector3.Project(
                new Vector3(pos.x, pos.y, pos.z), identity, worldMat, viewport);
            if (p.z < 0 || p.z > 1) continue; // behind camera / beyond far plane
            const dx = p.x - cx;
            const dy = p.y - cy;
            const distSq = dx * dx + dy * dy;
            if (distSq < nearestDistSq) { nearestDistSq = distSq; nearestId = id; }
        }

        if (nearestId >= 0) {
            const next = this.dragShift ? this.selectedIds.slice() : [];
            if (!next.includes(nearestId)) next.push(nearestId);
            this.setSelection(next);
        } else if (!this.dragShift) {
            this.setSelection([]);
        }
    }

    private handleBoxSelect(viewId: number): void {
        const camera = this.getCamera(viewId);
        if (!camera) return;
        const x0 = Math.min(this.dragStartX, this.dragCurX) * this.dpr;
        const y0 = Math.min(this.dragStartY, this.dragCurY) * this.dpr;
        const x1 = Math.max(this.dragStartX, this.dragCurX) * this.dpr;
        const y1 = Math.max(this.dragStartY, this.dragCurY) * this.dpr;
        const { viewport, worldMat } = this.projectionContext(camera);
        const identity = Matrix.Identity();

        const hits: number[] = [];
        for (const [id] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const p = Vector3.Project(
                new Vector3(pos.x, pos.y, pos.z), identity, worldMat, viewport);
            if (p.z < 0 || p.z > 1) continue;
            if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) hits.push(id);
        }

        const next = this.dragShift ? this.selectedIds.slice() : [];
        for (const id of hits) if (!next.includes(id)) next.push(id);
        this.setSelection(next);
    }

    // ---- Right-click orders ----

    /** Issue a right-click order at a screen pixel (move / attack / guard,
     *  team-aware). Wired to the camera's `onRightClickCommit` (right-click
     *  without an orbit-drag). Sends over the worker's own connection. */
    issueOrderAtScreen(cssX: number, cssY: number, shift: boolean, viewId = 0): void {
        if (this.selectedIds.length === 0) return;
        const camera = this.getCamera(viewId);
        if (!camera) return;
        const groundPos = this.pickGroundAt(cssX, cssY, camera);
        if (!groundPos) return;

        const opts = shift ? OPT.SHIFT : 0;
        const nearest = this.pickNearestEntityAt(groundPos);
        if (nearest.id >= 0) {
            const myTeam = this.connection.myTeam;
            const isFriendly = myTeam >= 0 && nearest.team === myTeam;
            const cmd = isFriendly ? CMD.GUARD : CMD.ATTACK;
            this.commandBuffer.issueImmediate(cmd, this.selectedIds.slice(), [nearest.id], opts);
        } else {
            this.commandBuffer.issueImmediate(
                CMD.MOVE, this.selectedIds.slice(),
                [groundPos.x, groundPos.y, groundPos.z], opts);
        }
    }

    private pickNearestEntityAt(groundPos: Vector3): { id: number; team: number } {
        let id = -1;
        let team = -1;
        let bestSq = SELECT_RADIUS * SELECT_RADIUS;
        for (const [eid, meta] of this.entityRenderer.getEntities()) {
            if (this.selectedIds.includes(eid)) continue;
            const pos = this.entityRenderer.getEntityPosition(eid);
            if (!pos) continue;
            const dx = pos.x - groundPos.x;
            const dz = pos.z - groundPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < bestSq) { bestSq = distSq; id = eid; team = meta.team; }
        }
        return { id, team };
    }

    // ---- Hover ----

    private updateHover(cssX: number, cssY: number, viewId: number): void {
        const camera = this.getCamera(viewId);
        if (!camera) return;
        const groundPos = this.pickGroundAt(cssX, cssY, camera);
        if (!groundPos) {
            if (this.hoveredId !== -1) this.hoveredId = -1;
            return;
        }
        let id = -1;
        let bestSq = SELECT_RADIUS * SELECT_RADIUS;
        for (const [eid] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(eid);
            if (!pos) continue;
            const dx = pos.x - groundPos.x;
            const dz = pos.z - groundPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < bestSq) { bestSq = distSq; id = eid; }
        }
        this.hoveredId = id;
    }

    // ---- Picking helpers ----

    /** Ray-pick the visible terrain mesh under a canvas-relative CSS-px point.
     *  `scene.pick` works in backing-store px (= CSS × dpr), so scale up. */
    private pickGroundAt(cssX: number, cssY: number, camera: FreeCamera): Vector3 | null {
        const pick = this.scene.pick(
            cssX * this.dpr, cssY * this.dpr,
            (m) => m.name === 'terrain', false, camera);
        return (pick?.hit && pick.pickedPoint) ? pick.pickedPoint : null;
    }

    /** Viewport (backing px) + world-view-projection matrix for projection. */
    private projectionContext(camera: FreeCamera): { viewport: Viewport; worldMat: Matrix } {
        const engine = this.scene.getEngine();
        const viewport = camera.viewport.toGlobal(
            engine.getRenderWidth(), engine.getRenderHeight());
        const worldMat = this.scene.getTransformMatrix();
        return { viewport, worldMat };
    }

    dispose(): void {
        this.commandBuffer.dispose();
        this.onDragBox(null);
    }
}
