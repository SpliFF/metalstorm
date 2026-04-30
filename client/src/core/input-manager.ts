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
    PointerEventTypes,
    type PointerInfo,
} from '@babylonjs/core';
import { EntityRenderer } from './entity-renderer.js';
import { CommandBuffer, CMD } from './command-buffer.js';
import type { Connection } from './connection.js';

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

    // Drag-select state
    private dragActive = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private dragCurX = 0;
    private dragCurY = 0;
    private dragShift = false;
    private dragOverlay: HTMLDivElement | null = null;

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
        this.commandBuffer.dispose();
        if (this.dragOverlay) {
            this.dragOverlay.remove();
            this.dragOverlay = null;
        }
    }
}
