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
import type { ParsedMapData } from './map-data.js';
import { findMetalSpots, nearestMetalSpot, type MetalSpot } from './metal-spots.js';

/// How close (in world elmos) a click has to be to a unit's XZ to
/// count as selecting that unit. Accounts for pickWithRay landing
/// slightly off the unit base on a tilted view.
const SELECT_RADIUS = 32;

/// Pixel threshold for single-click vs drag. Below this, mousedown +
/// mouseup is treated as a click; above, it's a drag-box select.
const DRAG_THRESHOLD_PX = 6;

/// Spring command-option bits. Match `Command.h`:
///   META_KEY=4, INTERNAL=8, RIGHT_MOUSE=16, SHIFT=32, CTRL=64, ALT=128
const OPT_SHIFT = 1 << 5;
const OPT_CTRL  = 1 << 6;
const OPT_ALT   = 1 << 7;

/// Bit 11 of UnitDef.flags marks a factory (see protocol.fbs).
const UNITDEF_FLAG_IS_FACTORY = 1 << 11;

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
    /// Player's team id, set after auth completes. -1 means unknown — in that
    /// case right-click target classification falls back to "any non-selected
    /// unit is a hostile" (the pre-team-aware behaviour).
    private myTeam = -1;

    /// Cached metal spots (centroids of connected non-zero metalmap cells in
    /// world elmos). Computed once when the map data arrives and used during
    /// extractor placement to snap the build ghost to a real spot.
    private metalSpots: MetalSpot[] = [];
    /// World-space half-distance covered by one metalmap cell. Pulled from
    /// MapData so the spot search radius scales with the map's resolution.
    private metalCellSize = 16;

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
        /// Set when the def has `extractsMetal > 0`. Forces the ghost to
        /// snap to the nearest metal spot and prevents placement when the
        /// cursor isn't within range of one.
        isMex: boolean;
        /// Search radius in elmos used by the mex snap. Falls back to ~96
        /// elmos when the def's extract range is missing or zero — that
        /// covers ZK's standard mex influence circle.
        mexSnapRadius: number;
        /// Last evaluated metal spot under the cursor (null = no spot in
        /// range). Used by issueBuildAt to commit the snapped position.
        snappedSpot: MetalSpot | null;
        /// Default ghost emissive colour for un-tinting after the
        /// red-out used to flag invalid mex placements.
        defaultEmissive: Color3;
    } | null = null;
    private moveListener: ((evt: MouseEvent) => void) | null = null;

    /// Pending "modal" command set by a hotkey (A=fight, P=patrol). When
    /// non-null, the next right-click on terrain issues this command at the
    /// click point instead of the default attack/move classification. Cleared
    /// after the next click or by pressing ESC.
    private pendingCmd: number | null = null;

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

    /** Set the player's team id after auth completes. Used by right-click
     *  target classification to distinguish friendly (Guard) from enemy
     *  (Attack) targets. */
    setMyTeam(team: number): void {
        this.myTeam = team;
    }

    /** Wire map data after MapData arrives. Used to pre-compute metal spot
     *  centroids so the build ghost can snap to them when the player is
     *  placing a metal extractor (`UnitDef.extractsMetal > 0`). */
    setMapData(map: ParsedMapData): void {
        // Spring's metalmap is half the heightmap resolution: each cell
        // covers 2 heightmap squares = 16 elmos.
        const mmW = (map.mapx / 2) | 0;
        const mmH = (map.mapy / 2) | 0;
        this.metalCellSize = (map.squareSize ?? 8) * 2;
        this.metalSpots = findMetalSpots(map.metalmap, mmW, mmH, this.metalCellSize);
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

    /** Programmatic selection update — used by widgets calling
     *  `Spring.SelectUnit*` through the LuaWidgetManager. Goes through
     *  the same pipeline as a click: highlight, minimap, build menu, and
     *  cancel-pending-build all run. Pass an empty array to clear. */
    setSelectionFromWidget(ids: readonly number[]): void {
        // Strip duplicates while preserving order — Spring's selection
        // is order-stable and widgets sometimes pass the same id twice.
        const seen = new Set<number>();
        const next: number[] = [];
        for (const id of ids) {
            if (id > 0 && !seen.has(id)) { seen.add(id); next.push(id); }
        }
        this.setSelection(next);
    }

    // ---- Build placement ----

    /**
     * Handle a build-button pick from the BuildMenu. Behaviour depends on the
     * current selection:
     *   - all factories            → queue the build immediately, no ghost
     *   - any mobile/static builder → enter ghost-placement mode; the next
     *                                left-click on the ground emits the
     *                                build order
     * Mixed selections fall through to ghost mode — factories will receive
     * the same `-defId` order and ignore the position params (FactoryCAI
     * looks the cmdID up in its buildOptions table).
     *
     * The shift modifier is forwarded:
     *   - factories: SHIFT triggers Spring's 5x build-count multiplier
     *     (FactoryCAI::GetCountMultiplierFromOptions).
     *   - builders: SHIFT queues the build behind existing commands and
     *     keeps placement mode open for chain-building.
     */
    startBuildPlacement(defId: number, shift: boolean = false): void {
        // Replace any existing placement (rapid button switch).
        this.cancelBuildPlacement();

        if (this.selectedIds.length === 0) return;

        // Pure factory selection: queue immediately, skip ground placement.
        if (this.allSelectedAreFactories()) {
            this.commandBuffer.issueImmediate(
                -defId, this.selectedIds.slice(),
                [],
                shift ? OPT_SHIFT : 0);
            return;
        }

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
        const baseEmissive = new Color3(0.15, 0.4, 0.2);
        mat.diffuseColor = new Color3(0.4, 1.0, 0.5);
        mat.emissiveColor = baseEmissive;
        mat.alpha = 0.45;
        mat.backFaceCulling = false;
        ghost.material = mat;
        ghost.isPickable = false;
        ghost.renderingGroupId = 2;
        // Park off-screen until the first mouse move places it.
        ghost.position.set(-1e6, 0, 0);

        // Metal extractors snap to metal spots. Two conventions are
        // detected:
        //   - vanilla Spring: `UnitDef.extractsMetal > 0` (engine field)
        //   - ZK:             `customParams.ismex == "1"` (game-defined,
        //                     because ZK does its own extraction in Lua)
        // Either marker enables snap-to-spot placement.
        const isMex = (def?.extractsMetal ?? 0) > 0
            || def?.customParams?.ismex === '1';
        const mexSnapRadius = Math.max(96, this.metalCellSize * 4);

        this.buildPlacement = {
            defId, ghost, footprintX: fpX, footprintZ: fpZ,
            isMex, mexSnapRadius, snappedSpot: null,
            defaultEmissive: baseEmissive,
        };

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

        const bp = this.buildPlacement;
        const mat = bp.ghost.material as StandardMaterial;

        if (bp.isMex) {
            // Mex placement snaps to the nearest metal spot. A spot out of
            // range means the placement won't actually extract anything —
            // tint the ghost red so the player can see the click is bad.
            const spot = nearestMetalSpot(this.metalSpots, groundPos.x, groundPos.z, bp.mexSnapRadius);
            bp.snappedSpot = spot;
            if (spot) {
                bp.ghost.position.set(spot.x, groundPos.y + 0.5, spot.z);
                mat.emissiveColor = bp.defaultEmissive;
            } else {
                // No spot in range — follow cursor, tint red.
                bp.ghost.position.set(groundPos.x, groundPos.y + 0.5, groundPos.z);
                mat.emissiveColor = new Color3(0.5, 0.05, 0.05);
            }
            return;
        }

        // Standard build: snap to Spring's 16-elmo build grid.
        const gx = Math.round(groundPos.x / 16) * 16;
        const gz = Math.round(groundPos.z / 16) * 16;
        bp.ghost.position.set(gx, groundPos.y + 0.5, gz);
    }

    private issueBuildAt(groundPos: Vector3, queue: boolean): void {
        if (!this.buildPlacement) return;
        const bp = this.buildPlacement;
        const defId = bp.defId;
        // Default facing south (0). A future enhancement: hold-and-drag to set
        // facing from the drag direction (Spring's standard build placement).
        const facing = 0;

        let x: number, y: number, z: number;
        if (bp.isMex) {
            // Mex placement requires snapping to a metal spot. If the player
            // clicks while no spot is in range (ghost was red), drop the
            // command — issuing it anyway just builds a useless mex on dead
            // ground. Stay in placement mode so the player can adjust.
            if (!bp.snappedSpot) {
                return;
            }
            x = bp.snappedSpot.x;
            z = bp.snappedSpot.z;
            y = groundPos.y;
        } else {
            // Spring quantises build positions to its 16-elmo grid; the server
            // would re-snap regardless but matching client-side keeps the
            // ghost visually consistent with the placed unit.
            x = Math.round(groundPos.x / 16) * 16;
            z = Math.round(groundPos.z / 16) * 16;
            y = groundPos.y;
        }

        // Negative cmdId = build command, -cmdId is the unit-def id.
        // Shift in options bitfield = queue order behind existing commands.
        this.commandBuffer.issueImmediate(
            -defId, this.selectedIds.slice(),
            [x, y, z, facing],
            queue ? OPT_SHIFT : 0);

        // Stay in placement mode while shift is held (chain-build sites);
        // otherwise drop out so the next left-click selects normally.
        if (!queue) this.cancelBuildPlacement();
    }

    /** True if every currently-selected unit is a factory (UnitDef bit 11).
     *  Returns false if any selected unit's def or meta hasn't streamed yet
     *  — that case falls back to ghost placement, which is the safe default
     *  since factories will ignore the position params. */
    private allSelectedAreFactories(): boolean {
        if (this.selectedIds.length === 0 || !this.defCache) return false;
        for (const id of this.selectedIds) {
            const meta = this.entityRenderer.getEntityMeta(id);
            if (!meta) return false;
            const def = this.defCache.getUnitDef(meta.defId);
            if (!def) return false;
            if (!(def.flags & UNITDEF_FLAG_IS_FACTORY)) return false;
        }
        return true;
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
            // Right-mouse handling lives in RTSCamera (drag → orbit, click
            // without drag → fires onRightClickCommit which the host wires
            // to issueOrderAtScreen). RTSCamera's pointerdown listener
            // runs in the capture phase and stopPropagations the right
            // button, so the observable here never sees button 2.
            switch (pointerInfo.type) {
                case PointerEventTypes.POINTERDOWN:
                    if (evt.button === 0) this.onLeftDown(evt);
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
        // click can be used as an order or rotate-drag without the OS
        // menu appearing on top of the game.
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

    /** Issue a right-click order at the given screen pixel. Called by
     *  RTSCamera's onRightClickCommit when a right-click ended without
     *  crossing the rotate-drag threshold. The shift bit is forwarded
     *  to the command queue so chained orders work the same as before
     *  (when the order was issued directly on mousedown). */
    issueOrderAtScreen(clientX: number, clientY: number, shift: boolean): void {
        // Right-click during build placement just cancels the placement.
        if (this.buildPlacement) {
            this.cancelBuildPlacement();
            return;
        }
        if (this.selectedIds.length === 0) return;
        // Right-click on UI cancels chili interaction (handled by widgetHandler);
        // don't also issue an order to whatever ground happens to be behind it.
        if (this.isOverUI()) return;
        const groundPos = this.pickGroundAt(clientX, clientY);
        if (!groundPos) return;

        // Modal hotkey command (A=fight, P=patrol). The next right-click is
        // consumed by the modal and resolves it: fight/patrol at the ground
        // point, ignoring whatever unit happens to be near the click.
        if (this.pendingCmd !== null) {
            const opts = shift ? OPT_SHIFT : 0;
            this.commandBuffer.issueImmediate(
                this.pendingCmd, this.selectedIds,
                [groundPos.x, groundPos.y, groundPos.z], opts);
            this.pendingCmd = null;
            this.updateCursorMode();
            return;
        }

        // Find the nearest non-selected unit to the click point. We classify
        // it as friendly or hostile from its team, falling back to "hostile"
        // when myTeam is unknown (pre-auth) or the entity meta hasn't streamed.
        let targetId = -1;
        let targetTeam = -1;
        let targetDist = SELECT_RADIUS * SELECT_RADIUS;
        for (const [id, meta] of this.entityRenderer.getEntities()) {
            if (this.selectedIds.includes(id)) continue;
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const dx = pos.x - groundPos.x;
            const dz = pos.z - groundPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < targetDist) {
                targetDist = distSq;
                targetId = id;
                targetTeam = meta.team;
            }
        }

        const opts = shift ? OPT_SHIFT : 0;
        if (targetId >= 0) {
            const isFriendly = this.myTeam >= 0 && targetTeam === this.myTeam;
            // Friendly → Guard (assist/escort). Enemy → Attack.
            const cmd = isFriendly ? CMD.GUARD : CMD.ATTACK;
            this.commandBuffer.issueImmediate(cmd, this.selectedIds, [targetId], opts);
        } else {
            this.commandBuffer.issueImmediate(CMD.MOVE, this.selectedIds, [groundPos.x, groundPos.y, groundPos.z], opts);
        }
    }

    // ---- Keyboard ----

    private setupKeyboardHandler(): void {
        window.addEventListener('keydown', (e) => {
            // Ignore if an input element has focus.
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            // ESC cancels build placement and any pending modal command. The
            // main.ts ESC handler shows the quit dialog after we early-out.
            if (e.key === 'Escape') {
                let consumed = false;
                if (this.buildPlacement) {
                    this.cancelBuildPlacement();
                    consumed = true;
                }
                if (this.pendingCmd !== null) {
                    this.pendingCmd = null;
                    this.updateCursorMode();
                    consumed = true;
                }
                if (consumed) {
                    e.stopPropagation();
                    return;
                }
            }

            if (this.selectedIds.length === 0) return;

            switch (e.key.toLowerCase()) {
                case 's':
                    this.commandBuffer.issueImmediate(CMD.STOP, this.selectedIds, []);
                    break;
                case 'h':
                    this.commandBuffer.issueImmediate(CMD.MOVE_STATE, this.selectedIds, [0]);
                    break;
                case 'a':
                    // Attack-move: arms a modal command. Next right-click on
                    // ground issues a FIGHT order at the click point.
                    this.pendingCmd = CMD.FIGHT;
                    this.updateCursorMode();
                    break;
                case 'p':
                    // Patrol: arms a modal command. Next right-click on ground
                    // becomes a PATROL waypoint.
                    this.pendingCmd = CMD.PATROL;
                    this.updateCursorMode();
                    break;
                case 'f':
                    // Fight (alias of attack-move; matches Spring's keybinding).
                    this.pendingCmd = CMD.FIGHT;
                    this.updateCursorMode();
                    break;
            }
        });
    }

    /** Reflect pendingCmd in the canvas cursor so the player can see they're
     *  in attack-move/patrol mode. Falls back to the default cursor when no
     *  modal command is pending. */
    private updateCursorMode(): void {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return;
        if (this.pendingCmd === CMD.FIGHT) {
            canvas.style.cursor = 'crosshair';
        } else if (this.pendingCmd === CMD.PATROL) {
            canvas.style.cursor = 'cell';
        } else {
            canvas.style.cursor = '';
        }
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
