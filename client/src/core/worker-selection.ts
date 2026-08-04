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
 * NOT ported here (they live in the sibling modules): build placement +
 * ghosts and build-drag rows (worker-build-placement.ts, G3a), waypoint
 * drag, area-attack drag, modal hotkey commands and order hotkeys
 * (worker-command-modes.ts, G3b), animated cursors (main-thread overlay,
 * driven via gp:cursorMode). Widget default-command overrides ARE handled
 * here: `updateHover` → onHoverTarget → widget:DefaultCommand (gpInit
 * wiring) → `setDefaultCommandOverride` → `issueOrderAtScreen`.
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
import { CommandBuffer, CMD, OPT, type CommandNotifier } from './command-buffer.js';
import { SELECT_PIXEL_RADIUS, SELECT_RADIUS, DRAG_THRESHOLD_PX } from './selection-core.js';
import { SoundCategory } from './sound-events.js';
import { isTerrainMesh } from './terrain.js';

/** Canvas-relative CSS-pixel rectangle for the main-thread drag overlay. */
export interface DragBox { x0: number; y0: number; x1: number; y1: number; }

/** Hover-target transition for the widget DefaultCommand dispatch. `engineCmd`
 *  is what Spring would issue on right-click absent a widget override
 *  (friendly → GUARD, enemy → ATTACK, none → MOVE) — the client-side
 *  equivalent of CGuiHandler::GetDefaultCommand's engine baseline. Feature
 *  hovering isn't wired yet; targetType is 'unit' or null today. */
export interface HoverTargetInfo {
    targetType: 'unit' | 'feature' | null;
    targetId: number;
    engineCmd: number;
}

/** A widget DefaultCommand override for the hovered target, resolved by
 *  lua-ui-host's dispatchDefaultCommand and pushed back here (gpInit wiring).
 *  Consulted by `issueOrderAtScreen` so widgets like unit_default_commands /
 *  cmd_mex_placement steer the right-click order, not just the cursor. */
export interface DefaultCommandOverride {
    cmdId: number;
    targetType: 'unit' | 'feature' | null;
    targetId: number;
}

/** A unit-UI sound the selection/order code wants played. The worker selection
 *  layer knows *when* (a click selected a unit, an order was issued) but not
 *  *how* (def-cache lookup + AudioContext live on the worker's owner /
 *  main thread); game-processor resolves + plays via `gp:audioSoundEvents`.
 *   - `unit`: a unit-def category sound (select / ok), 3D at the unit.
 *   - `item`: a named SoundItem (e.g. "MultiSelect"), 2D UI sound. */
export type UiSoundReq =
    | { kind: 'unit'; defId: number; category: number;
        x: number; y: number; z: number }
    | { kind: 'item'; name: string };

export interface WorkerSelectionOpts {
    /** Resolve the FreeCamera for a viewId (per-view picking; c5b ships view 0). */
    getCamera: (viewId: number) => FreeCamera | null;
    /** Initial device-pixel-ratio (kept in sync via `setDpr` on resize). */
    dpr: number;
    /** Show/update (box) or hide (null) the main-thread drag-select overlay. */
    onDragBox: (box: DragBox | null) => void;
    /** Notified whenever the selection set changes (feeds the c5c sceneState). */
    onSelectionChange?: (ids: readonly number[]) => void;
    /** Play a unit-UI sound (select / order-ack / multi-select). Fired only
     *  from real player gestures — not programmatic `setSelectionExternal`
     *  (Recoil plays no select sound for widget-driven selection). */
    onUiSound?: (req: UiSoundReq) => void;
    /** Notified when the cursor's hover target changes (a different unit, or
     *  none). gpInit routes this into lua-ui-host's dispatchDefaultCommand
     *  (widget:DefaultCommand) and pushes the resolved override back via
     *  `setDefaultCommandOverride` — Recoil: CGuiHandler::GetDefaultCommand
     *  walks luaUI->DefaultCommand on every hover change. Fires only on
     *  transitions so a stationary cursor doesn't flood the Lua runtime. */
    onHoverTarget?: (info: HoverTargetInfo) => void;
}

export class WorkerSelection {
    private readonly scene: Scene;
    private readonly entityRenderer: EntityRenderer;
    private readonly connection: Connection;
    private readonly commandBuffer: CommandBuffer;
    private readonly getCamera: (viewId: number) => FreeCamera | null;
    private readonly onDragBox: (box: DragBox | null) => void;
    private readonly onSelectionChange?: (ids: readonly number[]) => void;
    private readonly onUiSound?: (req: UiSoundReq) => void;
    private readonly onHoverTarget?: (info: HoverTargetInfo) => void;
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
    /// sceneState feed + the widget DefaultCommand dispatch; no highlight yet.
    private hoveredId = -1;
    /// Engine default command for the hovered target (friendly → GUARD,
    /// enemy → ATTACK, none → MOVE). Paired with hoveredId so onHoverTarget
    /// fires only on real transitions (old input-manager `hoveredEngineCmd`).
    private hoveredEngineCmd: number = CMD.MOVE;
    /// Resolved widget DefaultCommand override for the current hover target,
    /// pushed by gpInit after dispatchDefaultCommand ran. Cleared/replaced on
    /// every hover transition, so a stale override never applies to a fresh
    /// click target (the target-id match in issueOrderAtScreen guards too).
    private defaultCommandOverride: DefaultCommandOverride | null = null;

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
        this.onUiSound = opts.onUiSound;
        this.onHoverTarget = opts.onHoverTarget;
        this.dpr = opts.dpr > 0 ? opts.dpr : 1;
    }

    /** Keep the device-pixel-ratio current (called from gpResize). */
    setDpr(dpr: number): void {
        if (dpr > 0) this.dpr = dpr;
    }

    /** Install (or clear) the CommandNotify gate on this owner's
     *  CommandBuffer (see command-buffer.ts). Wired from gpInit. */
    setCommandNotifier(fn: CommandNotifier | null): void {
        this.commandBuffer.setNotifier(fn);
    }

    /** Store the widget DefaultCommand override resolved for the current
     *  hover target (null = no override / no widget claimed it). Pushed by
     *  gpInit's onHoverTarget wiring after dispatchDefaultCommand ran. */
    setDefaultCommandOverride(info: DefaultCommandOverride | null): void {
        this.defaultCommandOverride = info;
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

    /** Resolve an entity id to its unit defId + world position (for placing a
     *  3D unit-reply sound at the unit). Linear scan over live entities —
     *  only called on a click/order gesture, so the cost is negligible. */
    private entityDefAndPos(id: number):
        { defId: number; x: number; y: number; z: number } | null {
        const pos = this.entityRenderer.getEntityPosition(id);
        if (!pos) return null;
        for (const [eid, meta] of this.entityRenderer.getEntities()) {
            if (eid === id) return { defId: meta.defId, x: pos.x, y: pos.y, z: pos.z };
        }
        return null;
    }

    /** Play a unit's `category` sound (select / order-ack) at its position. */
    private playUnitSound(id: number, category: number): void {
        if (!this.onUiSound) return;
        const dp = this.entityDefAndPos(id);
        if (!dp) return;
        this.onUiSound({ kind: 'unit', defId: dp.defId, category,
            x: dp.x, y: dp.y, z: dp.z });
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
            // Recoil plays the unit's `select` sound on a single-click select.
            this.playUnitSound(nearestId, SoundCategory.Select);
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
        // Recoil's box-select sound switches on how many units the box caught:
        // exactly one → that unit's `select`; two or more → the fixed
        // "MultiSelect" UI sound (`SelectedUnitsHandler::HandleUnitBoxSelection`).
        if (hits.length === 1) {
            this.playUnitSound(hits[0], SoundCategory.Select);
        } else if (hits.length >= 2) {
            this.onUiSound?.({ kind: 'item', name: 'MultiSelect' });
        }
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
        // Widget DefaultCommand override: when the click lands on the same
        // target the hover dispatch resolved (unit id match, or ground with a
        // null-target override), the widget's cmdId replaces the hardcoded
        // engine default — so unit_default_commands / cmd_mex_placement
        // actually steer the right-click order (Recoil:
        // CGuiHandler::GetDefaultCommand → luaUI->DefaultCommand).
        const override = this.defaultCommandOverride;
        const overrideAppliesToUnit = override !== null &&
            override.targetType === 'unit' && nearest.id >= 0 && override.targetId === nearest.id;
        const overrideAppliesToGround = override !== null &&
            override.targetType === null && nearest.id < 0;
        if (nearest.id >= 0) {
            const myTeam = this.connection.myTeam;
            const isFriendly = myTeam >= 0 && nearest.team === myTeam;
            const engineCmd = isFriendly ? CMD.GUARD : CMD.ATTACK;
            const cmd = overrideAppliesToUnit ? override.cmdId : engineCmd;
            this.commandBuffer.issueImmediate(cmd, this.selectedIds.slice(), [nearest.id], opts);
        } else {
            const cmd = overrideAppliesToGround ? override.cmdId : CMD.MOVE;
            this.commandBuffer.issueImmediate(
                cmd, this.selectedIds.slice(),
                [groundPos.x, groundPos.y, groundPos.z], opts);
        }
        // Recoil acks an issued order with the first selected unit's `ok`
        // sound (`SelectedUnitsHandler::GiveCommand` → `sounds.ok`).
        this.playUnitSound(this.selectedIds[0], SoundCategory.OrderAck);
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
            // Cursor off the terrain → no hover target. Emit the null
            // transition so a stale widget override is cleared.
            this.setHoverTarget(-1, -1);
            return;
        }
        let id = -1;
        let team = -1;
        let bestSq = SELECT_RADIUS * SELECT_RADIUS;
        for (const [eid, meta] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(eid);
            if (!pos) continue;
            const dx = pos.x - groundPos.x;
            const dz = pos.z - groundPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < bestSq) { bestSq = distSq; id = eid; team = meta.team; }
        }
        this.setHoverTarget(id, team);
    }

    /** Record the hovered entity and, on a transition (different target or a
     *  different engine default), fire onHoverTarget for the widget
     *  DefaultCommand dispatch. Ports input-manager's updateHoverTarget. */
    private setHoverTarget(id: number, team: number): void {
        const myTeam = this.connection.myTeam;
        const engineCmd: number = id >= 0
            ? (myTeam >= 0 && team === myTeam ? CMD.GUARD : CMD.ATTACK)
            : CMD.MOVE;
        if (id === this.hoveredId && engineCmd === this.hoveredEngineCmd) return;
        this.hoveredId = id;
        this.hoveredEngineCmd = engineCmd;
        this.onHoverTarget?.(id >= 0
            ? { targetType: 'unit', targetId: id, engineCmd }
            : { targetType: null, targetId: 0, engineCmd });
    }

    // ---- Picking helpers ----

    /** Ray-pick the visible terrain mesh under a canvas-relative CSS-px point.
     *  `scene.pick` works in backing-store px (= CSS × dpr), so scale up. */
    private pickGroundAt(cssX: number, cssY: number, camera: FreeCamera): Vector3 | null {
        const pick = this.scene.pick(
            cssX * this.dpr, cssY * this.dpr,
            isTerrainMesh, false, camera);
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
