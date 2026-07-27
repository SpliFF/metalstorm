/**
 * WorkerCommandModes — DOM-free modal-command / area-drag / waypoint-drag core
 * for the game-processor worker (PLAN-playable.md G3b).
 *
 * Ports the remaining "dark" input features of `input-manager.ts` that the
 * selection port (worker-selection.ts) and build-placement port
 * (worker-build-placement.ts) deliberately left out:
 *
 *   1. **Modal pending-command state machine** — a command armed via
 *      `Spring.SetActiveCommand` (order menu) or an order hotkey enters a
 *      "pending" mode; the cursor reflects it; the next world click resolves it
 *      (ground point / unit / either). Shift keeps it armed for chained
 *      waypoints. (input-manager `armPendingCommand`/`resolvePendingCommandAt`)
 *   2. **Area-attack radius drag** — with AREA_ATTACK armed, left-drag paints a
 *      ground ring and commits `[x,y,z,radius]`. (input-manager `*AreaAttackDrag`)
 *   3. **Waypoint drag + per-waypoint revoke** — shift-drag a queued waypoint
 *      marker to reposition its order (atomic INSERT+REMOVE); ctrl-click a
 *      marker to revoke it. (input-manager `tryStartWaypointDrag`/`tryRevoke*`)
 *   4. **Order hotkeys** — the m/a/f/p/g/r/e/c/x/d/l/u modal arms + s/w/h/q/i
 *      instant orders. (input-manager `setupKeyboardHandler`)
 *
 * The animated-cursor OVERLAY stays on main (DOM). This module only computes the
 * canonical Spring cursor *name* + a CSS fallback for the armed command and
 * posts it out via `opts.onCursorMode`; game-processor forwards it to main
 * (`gp:cursorMode`), which drives the real `AnimatedCursor` + `canvas.style.cursor`.
 *
 * FIDELITY notes (called out per CLAUDE.md):
 *   - **Order hotkeys are a convenience layer, not Spring's keybinding system.**
 *     Recoil binds order keys through the game's own `uikeys`/keybinding widgets,
 *     which call `Spring.SetActiveCommand`. This hardcoded m/a/f/… map (inherited
 *     from input-manager.ts) *supplements* the faithful SetActiveCommand path so
 *     the modal machine is drivable without a working order menu; where a game
 *     binds the same physical key to a different command via its own widget, both
 *     fire (idempotent for the common arm-the-same-command case). See
 *     `handleOrderKey`.
 *   - **RMB cancels the armed command** (Recoil `CGuiHandler`: RMB clears the
 *     active command; LMB issues it). input-manager.ts instead *issued* on RMB —
 *     corrected here to the faithful behaviour. See `tryHandleRightClick`.
 *   - **Area attack via ATTACK + drag** (Recoil `CGuiHandler`): with the Attack
 *     command armed ('f' / the Attack button), a *click* issues a point attack
 *     (unit under cursor, else force-fire ground) and a *drag* issues an
 *     AREA_ATTACK with the ring radius. input-manager.ts instead keyed its area
 *     drag on a separate `pendingCmd === AREA_ATTACK` that no ZK/BAR UI ever set,
 *     leaving the feature dead — this restores it faithfully. The explicit
 *     AREA_ATTACK command (if a game ever arms it) still forces area on a click.
 *     FIGHT/reclaim/repair/etc. area rings are *not* ported (single-click modal
 *     targets, as in the source) — a later pass if a game needs them.
 *
 * Coordinates arrive as canvas-relative CSS px (top-left origin); `scene.pick`
 * works in backing-store px (= CSS × dpr), so they are scaled by dpr before
 * picking — the same convention as worker-selection / worker-build-placement.
 */

import {
    Scene,
    FreeCamera,
    Vector3,
    Mesh,
    MeshBuilder,
    StandardMaterial,
    Color3,
} from '@babylonjs/core';
import type { EntityRenderer } from './entity-renderer.js';
import type { Connection, UnitCommandQueueInfo } from './connection.js';
import { CommandBuffer, CMD, OPT, type CommandNotifier } from './command-buffer.js';
import { SELECT_RADIUS, DRAG_THRESHOLD_PX } from './selection-core.js';
import { isTerrainMesh } from './terrain.js';

/// Spring `CMDTYPE_*` (rts/Sim/Units/CommandAI/Command.h) → modal target class.
/// Only world-target types reach `activateCommandFromMenu` (instant + ICON_MODE
/// commands are issued directly in the widget worker's SetActiveCommand shim).
const CMDTYPE_ICON_MAP = 10; // ground point
const CMDTYPE_ICON_AREA = 11; // ground + radius
const CMDTYPE_ICON_UNIT = 12; // unit
const CMDTYPE_ICON_UNIT_OR_MAP = 13; // unit or ground
const CMDTYPE_ICON_FRONT = 14; // ground (front formation)
const CMDTYPE_ICON_UNIT_OR_AREA = 16; // unit or ground+radius
const CMDTYPE_ICON_UNIT_FEATURE_OR_AREA = 19; // unit/feature or ground+radius
const CMDTYPE_ICON_UNIT_OR_RECTANGLE = 22; // unit or ground rectangle

/// AREA_ATTACK radius clamps (elmos): floor keeps a click-without-drag a valid
/// mini-area; ceiling keeps the ring mesh cheap.
const AREA_ATTACK_MIN_RADIUS = 16;
const AREA_ATTACK_MAX_RADIUS = 4096;

export type PendingTarget = 'ground' | 'unit' | 'either';

/** Cursor-mode request posted to main (drives AnimatedCursor + canvas CSS).
 *  `name` = canonical Spring cursor name (null → native arrow); `css` = the
 *  CSS-cursor fallback shown before/without the animated overlay. */
export interface CursorModeReq { name: string | null; css: string; }

export interface WorkerCommandModesOpts {
    /** Resolve the FreeCamera for a viewId (per-view picking; G3b ships view 0). */
    getCamera: (viewId: number) => FreeCamera | null;
    /** Current device-pixel-ratio (scene.pick works in backing-store px). */
    getDpr: () => number;
    /** The current selection set (owned by WorkerSelection). */
    getSelection: () => readonly number[];
    /** Latest per-unit command-queue snapshot (~1 Hz) — waypoint drag reads the
     *  dragged order's full params/options from it to build a faithful INSERT. */
    getLastCommandQueues: () => readonly UnitCommandQueueInfo[];
    /** Emit a cursor-mode change (game-processor posts it to main). */
    onCursorMode: (req: CursorModeReq) => void;
}

export class WorkerCommandModes {
    private readonly scene: Scene;
    private readonly entityRenderer: EntityRenderer;
    private readonly connection: Connection;
    private readonly commandBuffer: CommandBuffer;
    private readonly opts: WorkerCommandModesOpts;

    /// Armed modal command (null = none) + how its click resolves.
    private pendingCmd: number | null = null;
    private pendingCmdTarget: PendingTarget = 'either';
    /// Fire-state cycle index for the `q` hotkey (0 hold / 1 return / 2 free).
    private fireStateCycle = 2;

    /// Left-press position (CSS px) tracked on every non-consumed left-down so
    /// pointerUp can tell a modal-resolve click from a box-select drag.
    private pressX = 0;
    private pressY = 0;

    /// Active attack/area-attack radius drag (null = none). Started when ATTACK
    /// or AREA_ATTACK is armed and the mouse goes down. On release, a real drag
    /// commits an AREA_ATTACK (ring radius); a click commits a point ATTACK
    /// (unit under cursor, else ground). `isAreaOnly` forces area even on a click
    /// (the explicit AREA_ATTACK command). `downX/downY` = press coords for the
    /// click-vs-drag test.
    private areaAttackDrag: {
        centerX: number; centerY: number; centerZ: number;
        radius: number; shift: boolean; downX: number; downY: number;
        isAreaOnly: boolean; previewRing: Mesh | null;
        /// One material per drag, shared by every rebuilt preview torus.
        /// (Rebuilding a material per pointermove stranded ~60 materials/sec —
        /// Mesh.dispose() defaults to disposeMaterialAndTextures=false.)
        ringMat: StandardMaterial | null;
    } | null = null;

    /// Active waypoint reposition drag (null = none).
    private waypointDrag: {
        unitId: number; tag: number; cmdId: number;
        originalParams: number[]; originalOptions: number;
        startX: number; startY: number;
        ghostLine: Mesh | null; markerMesh: Mesh | null;
    } | null = null;

    constructor(
        scene: Scene,
        entityRenderer: EntityRenderer,
        connection: Connection,
        opts: WorkerCommandModesOpts,
    ) {
        this.scene = scene;
        this.entityRenderer = entityRenderer;
        this.connection = connection;
        this.commandBuffer = new CommandBuffer(connection);
        this.opts = opts;
    }

    /** Install (or clear) the CommandNotify gate on this owner's
     *  CommandBuffer (see command-buffer.ts). Wired from gpInit. */
    setCommandNotifier(fn: CommandNotifier | null): void {
        this.commandBuffer.setNotifier(fn);
    }

    /** True while an area/waypoint drag is in flight (pointerMove routes here,
     *  not to the selection hover/drag-box). */
    get isDragging(): boolean {
        return this.areaAttackDrag !== null || this.waypointDrag !== null;
    }

    /** True while a modal command is armed OR an area/waypoint drag is live.
     *  Mirrored to main via sceneState so ESC swallows to cancel this first. */
    isArmed(): boolean {
        return this.pendingCmd !== null || this.isDragging;
    }

    // ---- Modal arm / cancel ----

    armPendingCommand(cmd: number, target: PendingTarget): void {
        this.pendingCmd = cmd;
        this.pendingCmdTarget = target;
        this.updateCursorMode();
    }

    hasPendingCommand(): boolean { return this.pendingCmd !== null; }

    /** Clear any armed modal command (RMB / ESC). Safe when nothing is armed. */
    cancelPendingCommand(): void {
        if (this.pendingCmd === null) return;
        this.pendingCmd = null;
        this.updateCursorMode();
    }

    /** Cancel everything — armed modal + any in-flight area/waypoint drag.
     *  Called on ESC (via main's gp:cancelCommandMode) and teardown. */
    cancelAll(): void {
        if (this.areaAttackDrag) {
            this.areaAttackDrag.previewRing?.dispose();
            this.areaAttackDrag.ringMat?.dispose();
            this.areaAttackDrag = null;
        }
        if (this.waypointDrag) {
            this.waypointDrag.ghostLine?.dispose();
            if (this.waypointDrag.markerMesh) this.waypointDrag.markerMesh.isVisible = true;
            this.waypointDrag = null;
        }
        this.cancelPendingCommand();
    }

    /**
     * Arm a world-target command chosen in the order menu (Spring.SetActiveCommand
     * → host). Maps the Spring CMDTYPE_* to a modal target class; the next world
     * click resolves it. Instant / mode-cycle commands never reach here — the
     * widget-worker SetActiveCommand shim issues those directly.
     */
    activateCommandFromMenu(cmdId: number, cmdType: number): void {
        let target: PendingTarget;
        switch (cmdType) {
            case CMDTYPE_ICON_MAP:
            case CMDTYPE_ICON_AREA:
            case CMDTYPE_ICON_FRONT:
                target = 'ground';
                break;
            case CMDTYPE_ICON_UNIT:
            case CMDTYPE_ICON_UNIT_OR_RECTANGLE:
                target = 'unit';
                break;
            case CMDTYPE_ICON_UNIT_OR_MAP:
            case CMDTYPE_ICON_UNIT_OR_AREA:
            case CMDTYPE_ICON_UNIT_FEATURE_OR_AREA:
            default:
                // Unknown / custom ZK types → "either" (prefer a unit, else ground).
                target = 'either';
                break;
        }
        this.armPendingCommand(cmdId, target);
    }

    // ---- Pointer routing (called by the worker dispatcher AFTER build
    //      placement, BEFORE selection) ----

    /** Left-button press. Returns true if consumed (waypoint revoke / waypoint
     *  drag start / area-attack drag start) — the caller must then NOT run
     *  selection. A plain armed modal does NOT consume here (selection may still
     *  drag-box); the modal resolves on the release click in `pointerUp`. */
    pointerDown(x: number, y: number, button: number, mods: number, viewId = 0): boolean {
        if (button !== 0) return false;
        this.pressX = x;
        this.pressY = y;
        const shift = (mods & 1) !== 0;
        const ctrl = (mods & 2) !== 0;
        const alt = (mods & 4) !== 0;

        // Ctrl+click a waypoint marker → revoke that queued order. Must precede
        // any selection / build fall-through.
        if (ctrl && !shift && !alt && this.tryRevokeWaypointAt(x, y, viewId)) return true;

        // Shift+down over a waypoint marker → begin a reposition drag.
        if (shift && !ctrl && !alt && this.tryStartWaypointDrag(x, y, viewId)) return true;

        // Attack modal (ATTACK or explicit AREA_ATTACK): capture the centre; a
        // drag sets an area radius, a click resolves a point attack. This is
        // Recoil's CGuiHandler behaviour (ATTACK + drag → area attack) — MORE
        // faithful than input-manager.ts, which armed a separate AREA_ATTACK
        // pendingCmd that no ZK/BAR UI ever set, leaving its area drag dead.
        // Consume the press regardless of pick success (an armed command
        // captures the mouse — no drag-box select underneath).
        if (this.pendingCmd === CMD.ATTACK || this.pendingCmd === CMD.AREA_ATTACK) {
            const groundPos = this.pickGroundAt(x, y, viewId);
            if (groundPos && this.opts.getSelection().length > 0) {
                this.startAreaAttackDrag(groundPos, shift, x, y, this.pendingCmd === CMD.AREA_ATTACK);
            }
            return true;
        }
        return false;
    }

    /** Pointer move — only meaningful while an area/waypoint drag is live. */
    pointerMove(x: number, y: number, _buttons: number, _mods: number, viewId = 0): void {
        if (this.waypointDrag) { this.updateWaypointDrag(x, y, viewId); return; }
        if (this.areaAttackDrag) { this.updateAreaAttackDrag(x, y, viewId); return; }
    }

    /** Left-button release. Returns true if consumed: a live area/waypoint drag
     *  commits, or (when a modal is armed) a click resolves the modal. A drag
     *  with a modal armed returns false so selection box-selects (the modal
     *  stays armed — faithful to input-manager). */
    pointerUp(x: number, y: number, button: number, mods: number, viewId = 0): boolean {
        if (button !== 0) return false;
        if (this.waypointDrag) { this.commitWaypointDrag(x, y, viewId); return true; }
        if (this.areaAttackDrag) { this.commitAreaAttackDrag(x, y); return true; }
        if (this.pendingCmd !== null) {
            const moved = Math.hypot(x - this.pressX, y - this.pressY) >= DRAG_THRESHOLD_PX;
            if (!moved) {
                const groundPos = this.pickGroundAt(x, y, viewId);
                if (groundPos) this.resolvePendingCommandAt(groundPos, (mods & 1) !== 0);
                // A click that missed terrain keeps the command armed but is
                // still consumed (no select/deselect underneath).
                return true;
            }
            // Dragged with a modal armed → let selection box-select; keep armed.
            return false;
        }
        return false;
    }

    /** Right-click while a command is armed → cancel it (Recoil: RMB clears the
     *  active command). Returns true if it consumed the click (so the caller
     *  skips the default move/attack/guard order). */
    tryHandleRightClick(): boolean {
        if (this.pendingCmd === null && !this.isDragging) return false;
        this.cancelAll();
        return true;
    }

    // ---- Modal resolution ----

    /** Resolve an armed modal command at a world point. Shift keeps it armed so
     *  successive clicks chain (multi-point patrol / queued moves). */
    private resolvePendingCommandAt(groundPos: Vector3, shift: boolean): void {
        if (this.pendingCmd === null) return;
        const cmd = this.pendingCmd;
        const opts = shift ? OPT.SHIFT : 0;
        const nearest = this.pickNearestEntityAt(groundPos);
        const sel = this.opts.getSelection().slice();
        if (!shift) { this.pendingCmd = null; this.updateCursorMode(); }
        if (sel.length === 0) return;

        if (this.pendingCmdTarget === 'unit') {
            if (nearest.id >= 0) this.commandBuffer.issueImmediate(cmd, sel, [nearest.id], opts);
            return;
        }
        if (this.pendingCmdTarget === 'either' && nearest.id >= 0) {
            this.commandBuffer.issueImmediate(cmd, sel, [nearest.id], opts);
            return;
        }
        this.commandBuffer.issueImmediate(cmd, sel, [groundPos.x, groundPos.y, groundPos.z], opts);
    }

    // ---- Area-attack drag ----

    private startAreaAttackDrag(
        groundPos: Vector3, shift: boolean, downX: number, downY: number, isAreaOnly: boolean,
    ): void {
        this.areaAttackDrag = {
            centerX: groundPos.x, centerY: groundPos.y, centerZ: groundPos.z,
            radius: AREA_ATTACK_MIN_RADIUS, shift, downX, downY, isAreaOnly,
            previewRing: null, ringMat: null,
        };
        this.renderAreaAttackRing();
    }

    private updateAreaAttackDrag(x: number, y: number, viewId: number): void {
        const drag = this.areaAttackDrag;
        if (!drag) return;
        const groundPos = this.pickGroundAt(x, y, viewId);
        if (!groundPos) return;
        const r = Math.hypot(groundPos.x - drag.centerX, groundPos.z - drag.centerZ);
        drag.radius = Math.min(AREA_ATTACK_MAX_RADIUS, Math.max(AREA_ATTACK_MIN_RADIUS, r));
        this.renderAreaAttackRing();
    }

    private commitAreaAttackDrag(x: number, y: number): void {
        const drag = this.areaAttackDrag;
        if (!drag) return;
        drag.previewRing?.dispose();
        drag.ringMat?.dispose();
        this.areaAttackDrag = null;

        const sel = this.opts.getSelection().slice();
        const opts = drag.shift ? OPT.SHIFT : 0;
        const moved = Math.hypot(x - drag.downX, y - drag.downY) >= DRAG_THRESHOLD_PX;
        if (sel.length > 0) {
            if (drag.isAreaOnly || moved) {
                // Area attack: centre + drag radius.
                this.commandBuffer.issueImmediate(CMD.AREA_ATTACK, sel,
                    [drag.centerX, drag.centerY, drag.centerZ, drag.radius], opts);
            } else {
                // Point attack (click, no drag): prefer a unit under the cursor,
                // else force-fire the ground point.
                const center = new Vector3(drag.centerX, drag.centerY, drag.centerZ);
                const nearest = this.pickNearestEntityAt(center);
                if (nearest.id >= 0) {
                    this.commandBuffer.issueImmediate(CMD.ATTACK, sel, [nearest.id], opts);
                } else {
                    this.commandBuffer.issueImmediate(CMD.ATTACK, sel,
                        [drag.centerX, drag.centerY, drag.centerZ], opts);
                }
            }
        }
        // Shift keeps the command armed for a chain; otherwise disarm.
        if (!drag.shift) { this.pendingCmd = null; this.updateCursorMode(); }
    }

    private renderAreaAttackRing(): void {
        const drag = this.areaAttackDrag;
        if (!drag) return;
        // The torus geometry is rebuilt per move (diameter/thickness/tess are
        // baked into it), but the material is created ONCE per drag and shared
        // across rebuilds — a per-move StandardMaterial was never disposed
        // (previewRing.dispose() keeps materials by default) and leaked ~60
        // materials/sec during a drag.
        drag.previewRing?.dispose();
        const tess = Math.max(24, Math.min(96, Math.floor(drag.radius / 24)));
        const thickness = Math.max(2, drag.radius * 0.012);
        const ring = MeshBuilder.CreateTorus('area-attack-ring',
            { diameter: drag.radius * 2, thickness, tessellation: tess }, this.scene);
        ring.scaling.y = 0.15;
        ring.position.set(drag.centerX, drag.centerY + 2, drag.centerZ);
        if (!drag.ringMat) {
            const mat = new StandardMaterial('area-attack-ring-mat', this.scene);
            mat.diffuseColor = new Color3(0, 0, 0);
            mat.emissiveColor = new Color3(1.0, 0.25, 0.25);
            mat.specularColor = new Color3(0, 0, 0);
            mat.disableLighting = true;
            mat.alpha = 0.7;
            drag.ringMat = mat;
        }
        ring.material = drag.ringMat;
        ring.isPickable = false;
        ring.renderingGroupId = 3; // depth-always, like the path/waypoint overlays
        drag.previewRing = ring;
    }

    // ---- Waypoint drag / revoke ----

    /** Ctrl+click a waypoint marker → REMOVE that order by tag. Returns true if
     *  a marker was hit and the revoke was sent. */
    private tryRevokeWaypointAt(cssX: number, cssY: number, viewId: number): boolean {
        const meta = this.pickWaypointMarker(cssX, cssY, viewId)?.meta;
        if (!meta || !meta.tag) return false;
        this.commandBuffer.issueImmediate(CMD.REMOVE, [meta.unitId], [meta.tag], 0);
        return true;
    }

    /** Shift+down over a waypoint marker → capture a reposition drag. Bails if
     *  the cached queue snapshot doesn't yet hold the order (can't build a
     *  faithful INSERT without its full params/options). */
    private tryStartWaypointDrag(cssX: number, cssY: number, viewId: number): boolean {
        const hit = this.pickWaypointMarker(cssX, cssY, viewId);
        if (!hit || !hit.meta.tag) return false;
        const queue = this.opts.getLastCommandQueues().find((q) => q.unitId === hit.meta.unitId);
        const order = queue?.orders.find((o) => o.tag === hit.meta.tag);
        if (!order) return false;

        hit.mesh.isVisible = false; // hide the original while dragging
        this.waypointDrag = {
            unitId: hit.meta.unitId, tag: hit.meta.tag, cmdId: hit.meta.cmdId,
            originalParams: order.params.slice(), originalOptions: order.options ?? 0,
            startX: cssX, startY: cssY, ghostLine: null, markerMesh: hit.mesh,
        };
        return true;
    }

    private updateWaypointDrag(x: number, y: number, viewId: number): void {
        const drag = this.waypointDrag;
        if (!drag) return;
        const groundPos = this.pickGroundAt(x, y, viewId);
        if (!groundPos) return;
        const oP = drag.originalParams;
        if (oP.length < 3) return;
        drag.ghostLine?.dispose();
        const line = MeshBuilder.CreateLines('waypoint-drag-ghost', {
            points: [new Vector3(oP[0], oP[1] + 6, oP[2]),
                     new Vector3(groundPos.x, groundPos.y + 6, groundPos.z)],
            updatable: false,
        }, this.scene);
        line.color = new Color3(1, 1, 1);
        line.alpha = 0.85;
        line.isPickable = false;
        line.renderingGroupId = 3;
        drag.ghostLine = line;
    }

    /** Commit the waypoint reposition — atomic INSERT (new pos, tag-anchored)
     *  + REMOVE (drop the original tag), batched so the unit never sees an
     *  intermediate double-queued state. */
    private commitWaypointDrag(x: number, y: number, viewId: number): void {
        const drag = this.waypointDrag;
        if (!drag) return;
        drag.ghostLine?.dispose();
        if (drag.markerMesh) drag.markerMesh.isVisible = true;
        this.waypointDrag = null;

        const groundPos = this.pickGroundAt(x, y, viewId);
        if (!groundPos) return;
        // No-op on a click (barely moved) — don't churn a redundant batch.
        if (Math.hypot(x - drag.startX, y - drag.startY) < DRAG_THRESHOLD_PX) return;

        const newParams = drag.originalParams.slice();
        newParams[0] = groundPos.x;
        newParams[1] = groundPos.y;
        newParams[2] = groundPos.z;
        // INSERT layout (CommandAI::ExecuteInsert): [tag, newCmdId, newOpts, ...newParams].
        // options MUST be 0: tag-anchored insert is the *no-ALT* path. With
        // OPT.ALT set, ExecuteInsert instead treats param0 as a queue POSITION
        // (clamped to queue length) — and since tags outgrow the queue length,
        // the drag silently moved the waypoint to the end of the queue.
        const insertParams = [drag.tag, drag.cmdId, drag.originalOptions, ...newParams];
        this.connection.sendPlayerCommandBatch([
            { commandId: CMD.INSERT, unitIds: [drag.unitId], params: insertParams, options: 0 },
            { commandId: CMD.REMOVE, unitIds: [drag.unitId], params: [drag.tag], options: 0 },
        ]);
    }

    /** Pick the topmost waypoint-marker mesh under a CSS-px point (depth-always,
     *  so markers behind hills still pick). */
    private pickWaypointMarker(cssX: number, cssY: number, viewId: number):
        { mesh: Mesh; meta: { unitId: number; tag: number; cmdId: number } } | null {
        const camera = this.opts.getCamera(viewId);
        if (!camera) return null;
        const dpr = this.opts.getDpr();
        const pick = this.scene.pick(cssX * dpr, cssY * dpr,
            (m) => m.isPickable && m.name.startsWith('waypoint-marker-'), false, camera);
        if (!pick?.hit || !pick.pickedMesh) return null;
        const meta = (pick.pickedMesh.metadata as
            { waypoint?: { unitId: number; tag: number; cmdId: number } } | null)?.waypoint;
        if (!meta) return null;
        return { mesh: pick.pickedMesh as Mesh, meta };
    }

    // ---- Keyboard order hotkeys ----

    /**
     * Handle an order hotkey. `code` is a `KeyboardEvent.code` (physical key,
     * e.g. "KeyM"); `mods` bits: shift=1 ctrl=2 alt=4 meta=8. Returns true if
     * the key was consumed. Instant orders + modal arms only (sim-speed / pause
     * / tracking are a camera/HUD concern, not ported here). Modal arms + most
     * instant orders require a live selection.
     *
     * FIDELITY-STANDIN: this hardcoded keymap supplements the faithful
     * SetActiveCommand path (see the file header). Order hotkeys stay clear of
     * the camera's arrow-key movement (no WASD binding), so there is no conflict.
     */
    handleOrderKey(code: string, mods: number): boolean {
        // ESC is owned by main (quit dialog / cancel); never consume it here.
        if (code === 'Escape') return false;
        // Don't fire order hotkeys with a modifier held (Ctrl-A select-all, etc.);
        // Shift is queue-mode and handled per-command below.
        if ((mods & (2 | 4 | 8)) !== 0) return false;
        const sel = this.opts.getSelection();
        if (sel.length === 0) return false;
        const ids = sel.slice();
        const queue = (mods & 1) ? OPT.SHIFT : 0;

        switch (code) {
            // ---- Instant orders ----
            case 'KeyS': this.commandBuffer.issueImmediate(CMD.STOP, ids, []); return true;
            case 'KeyW': this.commandBuffer.issueImmediate(CMD.WAIT, ids, [], queue); return true;
            case 'KeyH': this.commandBuffer.issueImmediate(CMD.MOVE_STATE, ids, [0]); return true;
            case 'KeyQ': this.cycleFireState(ids); return true;
            case 'KeyI': this.commandBuffer.issueImmediate(CMD.IDLEMODE, ids, [-1]); return true;
            // ---- Modal target-then-click commands ----
            case 'KeyM': this.armPendingCommand(CMD.MOVE, 'ground'); return true;
            case 'KeyA': this.armPendingCommand(CMD.FIGHT, 'ground'); return true;
            case 'KeyF': this.armPendingCommand(CMD.ATTACK, 'either'); return true;
            case 'KeyP': this.armPendingCommand(CMD.PATROL, 'ground'); return true;
            case 'KeyG': this.armPendingCommand(CMD.GUARD, 'unit'); return true;
            case 'KeyR': this.armPendingCommand(CMD.REPAIR, 'unit'); return true;
            case 'KeyE': this.armPendingCommand(CMD.RECLAIM, 'either'); return true;
            case 'KeyC': this.armPendingCommand(CMD.CAPTURE, 'unit'); return true;
            case 'KeyX': this.armPendingCommand(CMD.RESURRECT, 'either'); return true;
            case 'KeyD': this.armPendingCommand(CMD.MANUALFIRE, 'either'); return true;
            case 'KeyL': this.armPendingCommand(CMD.LOAD_UNITS, 'unit'); return true;
            case 'KeyU': this.armPendingCommand(CMD.UNLOAD_UNITS, 'ground'); return true;
        }
        return false;
    }

    private cycleFireState(ids: number[]): void {
        this.fireStateCycle = (this.fireStateCycle + 1) % 3;
        this.commandBuffer.issueImmediate(CMD.FIRE_STATE, ids, [this.fireStateCycle]);
    }

    // ---- Cursor ----

    /** Map the armed command → canonical Spring cursor name + CSS fallback, and
     *  emit it. `null` name resets to the native arrow. */
    private updateCursorMode(): void {
        this.opts.onCursorMode(cursorForCommand(this.pendingCmd));
    }

    // ---- Picking helpers (mirror worker-selection) ----

    private pickGroundAt(cssX: number, cssY: number, viewId: number): Vector3 | null {
        const camera = this.opts.getCamera(viewId);
        if (!camera) return null;
        const dpr = this.opts.getDpr();
        const pick = this.scene.pick(cssX * dpr, cssY * dpr,
            isTerrainMesh, false, camera);
        return (pick?.hit && pick.pickedPoint) ? pick.pickedPoint : null;
    }

    /** Nearest non-selected entity to a ground point (world-space, SELECT_RADIUS).
     *  Selected units are excluded — you target other units, not yourself. */
    private pickNearestEntityAt(groundPos: Vector3): { id: number; team: number } {
        const selected = this.opts.getSelection();
        let id = -1, team = -1;
        let bestSq = SELECT_RADIUS * SELECT_RADIUS;
        for (const [eid, meta] of this.entityRenderer.getEntities()) {
            if (selected.includes(eid)) continue;
            const pos = this.entityRenderer.getEntityPosition(eid);
            if (!pos) continue;
            const dx = pos.x - groundPos.x;
            const dz = pos.z - groundPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < bestSq) { bestSq = distSq; id = eid; team = meta.team; }
        }
        return { id, team };
    }

    dispose(): void {
        this.cancelAll();
        this.commandBuffer.dispose();
    }
}

/** Pure map: armed command id → cursor name + CSS fallback. Exported for tests
 *  and reused by `updateCursorMode`. Mirrors input-manager's `updateCursorMode`
 *  switch (the same names ZK/BAR widgets pass to AssignMouseCursor). */
export function cursorForCommand(cmd: number | null): CursorModeReq {
    switch (cmd) {
        case CMD.ATTACK:       return { name: 'Attack',       css: 'crosshair' };
        case CMD.AREA_ATTACK:  return { name: 'Area attack',  css: 'crosshair' };
        case CMD.FIGHT:        return { name: 'Fight',        css: 'crosshair' };
        case CMD.MANUALFIRE:   return { name: 'ManualFire',   css: 'crosshair' };
        case CMD.PATROL:       return { name: 'Patrol',       css: 'cell' };
        case CMD.MOVE:         return { name: 'Move',         css: 'move' };
        case CMD.UNLOAD_UNITS: return { name: 'Unload units', css: 'move' };
        case CMD.LOAD_UNITS:   return { name: 'Load units',   css: 'pointer' };
        case CMD.GUARD:        return { name: 'Guard',        css: 'pointer' };
        case CMD.REPAIR:       return { name: 'Repair',       css: 'pointer' };
        case CMD.RECLAIM:      return { name: 'Reclaim',      css: 'pointer' };
        case CMD.CAPTURE:      return { name: 'Capture',      css: 'pointer' };
        case CMD.RESURRECT:    return { name: 'Resurrect',    css: 'pointer' };
        case CMD.SELFD:        return { name: 'SelfD',        css: 'crosshair' };
        case CMD.WAIT:         return { name: 'Wait',         css: 'progress' };
        default:               return { name: null,           css: '' };
    }
}
