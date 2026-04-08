/**
 * InputManager — handles mouse/keyboard input for the game.
 *
 * Left click: select entity nearest to click position
 * Right click: issue move command (ground) or attack command (enemy entity)
 * Keyboard: S=stop, A=attack-move mode, P=patrol mode
 *
 * Uses ray casting from camera through click position to find the
 * ground intersection point, then distance-checks against known
 * entity positions for selection.
 */

import { Scene, FreeCamera, Vector3, PointerEventTypes, type PointerInfo } from '@babylonjs/core';
import { EntityRenderer, type EntityMeta } from './entity-renderer.js';
import { CommandBuffer, CMD } from './command-buffer.js';
import type { Connection } from './connection.js';

const SELECT_RADIUS = 32; // world units — how close a click must be to select

export class InputManager {
    private scene: Scene;
    private camera: FreeCamera;
    private entityRenderer: EntityRenderer;
    private commandBuffer: CommandBuffer;
    private selectedIds: number[] = [];
    private onSelectionChange?: (ids: number[]) => void;

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

        this.setupPointerHandler();
        this.setupKeyboardHandler();
    }

    get selection(): readonly number[] {
        return this.selectedIds;
    }

    private setupPointerHandler(): void {
        this.scene.onPointerObservable.add((pointerInfo: PointerInfo) => {
            if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) return;
            const evt = pointerInfo.event as PointerEvent;

            if (evt.button === 0) {
                // Left click — select
                this.handleLeftClick(evt);
            } else if (evt.button === 2) {
                // Right click — command
                this.handleRightClick(evt);
            }
        });

        // Suppress context menu on canvas
        const canvas = this.scene.getEngine().getRenderingCanvas();
        canvas?.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    private setupKeyboardHandler(): void {
        window.addEventListener('keydown', (e) => {
            if (this.selectedIds.length === 0) return;

            switch (e.key.toLowerCase()) {
                case 's':
                    this.commandBuffer.issueImmediate(CMD.STOP, this.selectedIds, []);
                    break;
                case 'h':
                    // Hold position
                    this.commandBuffer.issueImmediate(CMD.MOVE_STATE, this.selectedIds, [0]);
                    break;
            }
        });
    }

    private handleLeftClick(evt: PointerEvent): void {
        const groundPos = this.pickGround(evt);
        if (!groundPos) return;

        // Find nearest entity to click position
        let nearestId = -1;
        let nearestDist = SELECT_RADIUS * SELECT_RADIUS;

        for (const [id, _meta] of this.entityRenderer.getEntities()) {
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
            // Select this entity (shift-click to add)
            if (evt.shiftKey) {
                if (!this.selectedIds.includes(nearestId)) {
                    this.selectedIds.push(nearestId);
                }
            } else {
                this.selectedIds = [nearestId];
            }
        } else {
            // Clicked empty ground — deselect
            if (!evt.shiftKey) {
                this.selectedIds = [];
            }
        }

        this.onSelectionChange?.(this.selectedIds);
    }

    private handleRightClick(evt: PointerEvent): void {
        if (this.selectedIds.length === 0) return;

        const groundPos = this.pickGround(evt);
        if (!groundPos) return;

        // Check if right-click is near an enemy entity
        let targetId = -1;
        let targetDist = SELECT_RADIUS * SELECT_RADIUS;

        for (const [id, meta] of this.entityRenderer.getEntities()) {
            // Skip own units (team 0 assumed for now)
            // TODO: use actual player team
            if (meta.team === 0) continue;

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
            // Attack command on enemy
            this.commandBuffer.issueImmediate(
                CMD.ATTACK, this.selectedIds, [targetId],
                evt.shiftKey ? 32 : 0);
        } else {
            // Move command to ground position
            this.commandBuffer.issueImmediate(
                CMD.MOVE, this.selectedIds, [groundPos.x, groundPos.y, groundPos.z],
                evt.shiftKey ? 32 : 0);
        }
    }

    /** Ray cast from camera through screen position to the y=0 ground plane. */
    private pickGround(evt: PointerEvent): Vector3 | null {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return null;

        // Create a ray from camera through the click position
        const ray = this.scene.createPickingRay(
            evt.offsetX, evt.offsetY, null, this.camera);

        // Intersect with ground plane (y = 0)
        if (ray.direction.y === 0) return null;
        const t = -ray.origin.y / ray.direction.y;
        if (t < 0) return null;

        return new Vector3(
            ray.origin.x + ray.direction.x * t,
            0,
            ray.origin.z + ray.direction.z * t,
        );
    }

    dispose(): void {
        this.commandBuffer.dispose();
    }
}
