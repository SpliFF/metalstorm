/**
 * InputManager — mouse + keyboard input for selection and commands.
 *
 *   Left click          - select nearest unit to the click point
 *   Left drag (>6 px)   - box-select every unit whose screen-space
 *                         projection falls inside the rectangle
 *   Shift + left click  - add to selection instead of replacing
 *   Right click ground  - move order
 *   Right click unit    - attack order (any team; ownership is a
 *                         future TODO)
 *   S                   - stop
 *   H                   - hold position
 *
 * Picking ray-casts against the terrain mesh (`scene.pick(...,
 * predicate)`) rather than the Y=0 plane so the ground position
 * matches the visible surface on maps where min_height > 0 (e.g.
 * wanderlust). Unit proximity matches on XZ — that's fine for flat
 * spawn spreads and a lot cheaper than per-unit mesh intersection.
 */

import {
    Scene,
    FreeCamera,
    Vector3,
    Matrix,
    Mesh,
    MeshBuilder,
    StandardMaterial,
    Color3,
    PointerEventTypes,
    type PointerInfo,
} from '@babylonjs/core';
import { EntityRenderer } from './entity-renderer.js';
import { CommandBuffer, CMD } from './command-buffer.js';
import type { Connection } from './connection.js';
import type { DefCache } from './def-cache.js';

/// How close (in world elmos) a click has to be to a unit's XZ to
/// count as selecting that unit. Accounts for pickWithRay landing
/// slightly off the unit base on a tilted view.
const SELECT_RADIUS = 32;

/// Pixel threshold for single-click vs drag. Below this, mousedown +
/// mouseup is treated as a click; above, it's a drag-box select.
const DRAG_THRESHOLD_PX = 6;

export class InputManager {
    private scene: Scene;
    private camera: FreeCamera;
    private entityRenderer: EntityRenderer;
    private commandBuffer: CommandBuffer;
    private selectedIds: number[] = [];
    private onSelectionChange?: (ids: number[]) => void;
    /// When set, returning true suppresses ground selection / orders for the
    /// current pointer event. Wired up to LuaWidgetManager.isCursorOverUI()
    /// so a click on a chili button doesn't also trigger a deselect-all.
    private isOverUI: () => boolean = () => false;
    /// Optional def lookup so build placement can size the ghost from the
    /// chosen def's footprint. Wired in via setDefCache after construction
    /// to keep the existing main.ts call site unchanged.
    private defCache: DefCache | null = null;

    // Drag-select state
    private dragActive = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private dragCurX = 0;
    private dragCurY = 0;
    private dragShift = false;
    private dragOverlay: HTMLDivElement | null = null;

    // Build placement state — non-null while the player has clicked a build
    // button and is choosing a ground location. Cancelled by ESC, right-click,
    // selection change, or a successful left-click placement (unless shift is
    // held, in which case placement mode persists for queue building).
    private buildPlacement: {
        defId: number;
        ghost: Mesh;
        footprintX: number;
        footprintZ: number;
    } | null = null;
    private moveListener: ((evt: MouseEvent) => void) | null = null;

    constructor(
        scene: Scene,
        camera: FreeCamera,
        entityRenderer: EntityRenderer,
        connection: Connection,
        onSelectionChange?: (ids: number[]) => void,
    ) {
        this.scene = scene;
        this.camera = camera;
        this.entityRenderer = entityRenderer;
        this.commandBuffer = new CommandBuffer(connection);
        this.onSelectionChange = onSelectionChange;

        this.createDragOverlay();
        this.setupPointerHandler();
        this.setupKeyboardHandler();
    }

    /** Wire the def cache after construction so build placement can size the ghost. */
    setDefCache(cache: DefCache): void {
        this.defCache = cache;
    }

    setUIHitTest(probe: () => boolean): void {
        this.isOverUI = probe;
    }

    get selection(): readonly number[] {
        return this.selectedIds;
    }

    // ---- Selection state ----

    private setSelection(ids: number[]): void {
        this.selectedIds = ids;
        this.entityRenderer.setSelection(ids);
        this.onSelectionChange?.(ids);
        // A new selection invalidates any in-progress build placement —
        // the chosen def may not be buildable by the new selection.
        this.cancelBuildPlacement();
    }

    // ---- Build placement ----

    /**
     * Enter ghost-placement mode for a build command. Called by the BuildMenu
     * after the player clicks a build button. The next left-click on the
     * ground issues the build order (cmdId = -defId, params = [x,y,z,facing]).
     * Right-click or ESC cancels.
     */
    startBuildPlacement(defId: number): void {
        // Replace any existing placement (rapid button switch).
        this.cancelBuildPlacement();

        const def = this.defCache?.getUnitDef(defId);
        // Spring footprints are in heightmap squares (8 elmos each). Default
        // to 2x2 if the def hasn't streamed yet — the ghost is just a hint,
        // not a constraint, so a guess is fine.
        // Spring's xsize/zsize are already in elmos (footprint * 2 each).
        const fpX = (def?.xsize ?? 4) * 8;
        const fpZ = (def?.zsize ?? 4) * 8;
        const sizeY = 24;

        const ghost = MeshBuilder.CreateBox('build-ghost', {
            width: fpX, depth: fpZ, height: sizeY,
        }, this.scene);
        const mat = new StandardMaterial('build-ghost-mat', this.scene);
        mat.diffuseColor = new Color3(0.4, 1.0, 0.5);
        mat.emissiveColor = new Color3(0.15, 0.4, 0.2);
        mat.alpha = 0.45;
        mat.backFaceCulling = false;
        ghost.material = mat;
        ghost.isPickable = false;
        ghost.renderingGroupId = 2;
        // Park off-screen until the first mouse move places it.
        ghost.position.set(-1e6, 0, 0);

        this.buildPlacement = { defId, ghost, footprintX: fpX, footprintZ: fpZ };

        // Track the cursor so the ghost follows it.
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (canvas) {
            this.moveListener = (evt: MouseEvent) => this.updateBuildGhost(evt.clientX, evt.clientY);
            canvas.addEventListener('mousemove', this.moveListener);
        }
    }

    cancelBuildPlacement(): void {
        if (this.moveListener) {
            const canvas = this.scene.getEngine().getRenderingCanvas();
            canvas?.removeEventListener('mousemove', this.moveListener);
            this.moveListener = null;
        }
        if (this.buildPlacement) {
            this.buildPlacement.ghost.dispose();
            this.buildPlacement = null;
        }
    }

    get isPlacingBuild(): boolean { return this.buildPlacement !== null; }

    private updateBuildGhost(clientX: number, clientY: number): void {
        if (!this.buildPlacement) return;
        const groundPos = this.pickGroundAt(clientX, clientY);
        if (!groundPos) return;
        // Snap to the 16-elmo grid Spring uses internally for builds.
        const gx = Math.round(groundPos.x / 16) * 16;
        const gz = Math.round(groundPos.z / 16) * 16;
        this.buildPlacement.ghost.position.set(gx, groundPos.y + 0.5, gz);
    }

    private issueBuildAt(groundPos: Vector3, queue: boolean): void {
        if (!this.buildPlacement) return;
        const defId = this.buildPlacement.defId;
        // Spring quantises build positions to its 16-elmo grid; the server
        // would re-snap regardless but matching client-side keeps the ghost
        // visually consistent with the placed unit.
        const x = Math.round(groundPos.x / 16) * 16;
        const z = Math.round(groundPos.z / 16) * 16;
        const y = groundPos.y;
        // Default facing south (0). A future enhancement: hold-and-drag to set
        // facing from the drag direction (Spring's standard build placement).
        const facing = 0;
        // Negative cmdId = build command, -cmdId is the unit-def id.
        // Shift in options bitfield = queue order behind existing commands.
        const SHIFT_OPT = 32;
        this.commandBuffer.issueImmediate(
            -defId, this.selectedIds.slice(),
            [x, y, z, facing],
            queue ? SHIFT_OPT : 0);

        // Stay in placement mode while shift is held (chain-build sites);
        // otherwise drop out so the next left-click selects normally.
        if (!queue) this.cancelBuildPlacement();
    }

    // ---- Drag overlay ----

    private createDragOverlay(): void {
        const div = document.createElement('div');
        div.id = 'drag-select-overlay';
        div.style.position = 'fixed';
        div.style.border = '1px solid rgba(255, 220, 60, 0.9)';
        div.style.background = 'rgba(255, 220, 60, 0.12)';
        div.style.pointerEvents = 'none';
        div.style.display = 'none';
        div.style.zIndex = '50';
        document.body.appendChild(div);
        this.dragOverlay = div;
    }

    private showDragOverlay(): void {
        if (!this.dragOverlay) return;
        const x0 = Math.min(this.dragStartX, this.dragCurX);
        const y0 = Math.min(this.dragStartY, this.dragCurY);
        const w = Math.abs(this.dragCurX - this.dragStartX);
        const h = Math.abs(this.dragCurY - this.dragStartY);
        this.dragOverlay.style.display = 'block';
        this.dragOverlay.style.left = `${x0}px`;
        this.dragOverlay.style.top = `${y0}px`;
        this.dragOverlay.style.width = `${w}px`;
        this.dragOverlay.style.height = `${h}px`;
    }

    private hideDragOverlay(): void {
        if (this.dragOverlay) this.dragOverlay.style.display = 'none';
    }

    // ---- Pointer ----

    private setupPointerHandler(): void {
        this.scene.onPointerObservable.add((pointerInfo: PointerInfo) => {
            const evt = pointerInfo.event as PointerEvent;
            switch (pointerInfo.type) {
                case PointerEventTypes.POINTERDOWN:
                    if (evt.button === 0) this.onLeftDown(evt);
                    else if (evt.button === 2) this.onRightClick(evt);
                    break;
                case PointerEventTypes.POINTERMOVE:
                    if (this.dragActive) this.onDragMove(evt);
                    break;
                case PointerEventTypes.POINTERUP:
                    if (evt.button === 0 && this.dragActive) this.onLeftUp(evt);
                    break;
            }
        });

        // Suppress the browser context menu on the canvas so right-
        // click can be used as an order.
        const canvas = this.scene.getEngine().getRenderingCanvas();
        canvas?.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    private onLeftDown(evt: PointerEvent): void {
        // Ignore clicks that started over a UI element.
        if ((evt.target as HTMLElement)?.id?.includes('hud')) return;
        // Ignore clicks landing on a chili control. The flag is updated
        // one mousemove behind the cursor — a click without a prior hover
        // (e.g. tab-induced focus + Enter to fake a click) won't be caught,
        // but that's an edge case worth deferring.
        if (this.isOverUI()) return;
        // Build placement: a left-click during placement issues the build
        // order at the ground point, not a unit selection.
        if (this.buildPlacement) {
            const groundPos = this.pickGroundAt(evt.clientX, evt.clientY);
            if (groundPos) this.issueBuildAt(groundPos, evt.shiftKey);
            return;
        }
        this.dragActive = true;
        this.dragStartX = evt.clientX;
        this.dragStartY = evt.clientY;
        this.dragCurX = evt.clientX;
        this.dragCurY = evt.clientY;
        this.dragShift = evt.shiftKey;
    }

    private onDragMove(evt: PointerEvent): void {
        this.dragCurX = evt.clientX;
        this.dragCurY = evt.clientY;
        const dx = this.dragCurX - this.dragStartX;
        const dy = this.dragCurY - this.dragStartY;
        if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
            this.showDragOverlay();
        }
    }

    private onLeftUp(evt: PointerEvent): void {
        this.dragActive = false;
        this.hideDragOverlay();

        const dx = evt.clientX - this.dragStartX;
        const dy = evt.clientY - this.dragStartY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
            // Single click — select nearest unit to the ground point.
            this.handleSingleClick(evt);
        } else {
            // Drag — box-select all units whose screen position is
            // inside the drag rectangle.
            this.handleBoxSelect(evt);
        }
    }

    // ---- Single click ----

    private handleSingleClick(evt: PointerEvent): void {
        const groundPos = this.pickGroundAt(evt.clientX, evt.clientY);
        if (!groundPos) return;

        let nearestId = -1;
        let nearestDist = SELECT_RADIUS * SELECT_RADIUS;
        for (const [id] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const dx = pos.x - groundPos.x;
            const dz = pos.z - groundPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < nearestDist) {
                nearestDist = distSq;
                nearestId = id;
            }
        }

        if (nearestId >= 0) {
            const next = this.dragShift ? this.selectedIds.slice() : [];
            if (!next.includes(nearestId)) next.push(nearestId);
            this.setSelection(next);
        } else if (!this.dragShift) {
            this.setSelection([]);
        }
    }

    // ---- Box select ----

    private handleBoxSelect(_evt: PointerEvent): void {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const x0 = Math.min(this.dragStartX, this.dragCurX) - rect.left;
        const y0 = Math.min(this.dragStartY, this.dragCurY) - rect.top;
        const x1 = Math.max(this.dragStartX, this.dragCurX) - rect.left;
        const y1 = Math.max(this.dragStartY, this.dragCurY) - rect.top;

        const engine = this.scene.getEngine();
        const viewport = this.camera.viewport.toGlobal(
            engine.getRenderWidth(),
            engine.getRenderHeight(),
        );
        const worldMat = this.scene.getTransformMatrix();

        const hits: number[] = [];
        const identity = Matrix.Identity();
        for (const [id] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const projected = Vector3.Project(
                new Vector3(pos.x, pos.y, pos.z),
                identity,
                worldMat,
                viewport,
            );
            // z is normalised device depth; clip anything behind the camera
            if (projected.z < 0 || projected.z > 1) continue;
            if (projected.x >= x0 && projected.x <= x1 &&
                projected.y >= y0 && projected.y <= y1) {
                hits.push(id);
            }
        }

        const next = this.dragShift ? this.selectedIds.slice() : [];
        for (const id of hits) {
            if (!next.includes(id)) next.push(id);
        }
        this.setSelection(next);
    }

    // ---- Right click orders ----

    private onRightClick(evt: PointerEvent): void {
        // Right-click during build placement just cancels the placement.
        if (this.buildPlacement) {
            this.cancelBuildPlacement();
            return;
        }
        if (this.selectedIds.length === 0) return;
        // Right-click on UI cancels chili interaction (handled by widgetHandler);
        // don't also issue an order to whatever ground happens to be behind it.
        if (this.isOverUI()) return;
        const groundPos = this.pickGroundAt(evt.clientX, evt.clientY);
        if (!groundPos) return;

        // Any unit not in the current selection is a legitimate attack
        // target. We don't have player team info yet, so an attack
        // against a friendly will just get rejected server-side once
        // the TODO at server_main.cpp:580 lands.
        let targetId = -1;
        let targetDist = SELECT_RADIUS * SELECT_RADIUS;
        for (const [id] of this.entityRenderer.getEntities()) {
            if (this.selectedIds.includes(id)) continue;
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const dx = pos.x - groundPos.x;
            const dz = pos.z - groundPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < targetDist) {
                targetDist = distSq;
                targetId = id;
            }
        }

        if (targetId >= 0) {
            this.commandBuffer.issueImmediate(
                CMD.ATTACK, this.selectedIds, [targetId],
                evt.shiftKey ? 32 : 0);
        } else {
            this.commandBuffer.issueImmediate(
                CMD.MOVE, this.selectedIds,
                [groundPos.x, groundPos.y, groundPos.z],
                evt.shiftKey ? 32 : 0);
        }
    }

    // ---- Keyboard ----

    private setupKeyboardHandler(): void {
        window.addEventListener('keydown', (e) => {
            // Ignore if an input element has focus.
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            // ESC cancels build placement (must run regardless of selection).
            // The main.ts ESC handler shows the quit dialog after we early-out.
            if (e.key === 'Escape' && this.buildPlacement) {
                this.cancelBuildPlacement();
                e.stopPropagation();
                return;
            }

            if (this.selectedIds.length === 0) return;

            switch (e.key.toLowerCase()) {
                case 's':
                    this.commandBuffer.issueImmediate(CMD.STOP, this.selectedIds, []);
                    break;
                case 'h':
                    this.commandBuffer.issueImmediate(CMD.MOVE_STATE, this.selectedIds, [0]);
                    break;
            }
        });
    }

    // ---- Terrain pick ----

    /**
     * Ray-cast from the camera through a screen pixel to the visible
     * terrain mesh. Returns the 3D world point of the intersection, or
     * null if the ray misses the terrain entirely (outside the map, at
     * the skybox, etc.).
     *
     * We filter on mesh name so we never accidentally hit a unit or
     * feature mesh during pick — this function is specifically for
     * "where on the ground did the user click".
     */
    private pickGroundAt(clientX: number, clientY: number): Vector3 | null {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const offsetX = clientX - rect.left;
        const offsetY = clientY - rect.top;

        const pick = this.scene.pick(
            offsetX,
            offsetY,
            (m) => m.name === 'terrain',
            false,
            this.camera,
        );
        if (pick?.hit && pick.pickedPoint) {
            return pick.pickedPoint;
        }
        return null;
    }

    dispose(): void {
        this.cancelBuildPlacement();
        this.commandBuffer.dispose();
        if (this.dragOverlay) {
            this.dragOverlay.remove();
            this.dragOverlay = null;
        }
    }
}
