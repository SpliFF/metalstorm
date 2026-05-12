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
    TransformNode,
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
import type { AnimatedCursor } from './animated-cursor.js';
import type { WaypointMarkerMeta } from './waypoint-marker-renderer.js';

/// How close (in world elmos) a click has to be to a unit's XZ to
/// count as selecting that unit. Accounts for pickWithRay landing
/// slightly off the unit base on a tilted view. Used by right-click
/// target classification (pickNearestEntityAt); single-click selection
/// uses a screen-space pixel radius instead — see SELECT_PIXEL_RADIUS.
const SELECT_RADIUS = 32;

/// Single-click select tolerance, in screen pixels. World-space radii
/// don't work for tall structures: clicking the top of a factory
/// projects a ray that exits the back of the model and lands on terrain
/// 100+ elmos behind the footprint, which then fails any ground-based
/// proximity test. Comparing the click pixel to each unit's projected
/// centre handles all unit shapes uniformly.
const SELECT_PIXEL_RADIUS = 32;

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

/// Mirror of `CGameHelper::Pos2BuildPos` — snap a world position to Spring's
/// 16-elmo build grid with a parity offset based on bit 1 of the unit's
/// footprint (engine checks `xsize & 2`, NOT `xsize & 1`): xsize ∈ {2, 3, 6,
/// 7, ...} centres on 16k+8, the rest line up on 16k. ZK's
/// `mex_spot_finder.AdjustCoordinates` produces the same grid, so reusing it
/// here keeps the build position aligned with `metalSpotsByPos[x][z]` lookups
/// in `mex_placement.AllowCommand` (otherwise mex builds get silently dropped).
function snapToBuildGrid(x: number, z: number, xsize: number, zsize: number): [number, number] {
    const sx = (xsize & 2)
        ? Math.floor(x / 16) * 16 + 8
        : Math.floor((x + 8) / 16) * 16;
    const sz = (zsize & 2)
        ? Math.floor(z / 16) * 16 + 8
        : Math.floor((z + 8) / 16) * 16;
    return [sx, sz];
}

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

    /// Latest broadcast of command queues, cached so the waypoint-drag
    /// handler can read the dragged order's full params (tag alone isn't
    /// enough — we preserve cmdId, options, and any trailing params like
    /// build facing when sending the INSERT half of the drag-batch).
    private lastQueues: ReadonlyArray<{
        unitId: number;
        orders: ReadonlyArray<{
            cmdId: number;
            params: number[];
            tag?: number;
            options?: number;
        }>;
    }> = [];

    /// Active waypoint-drag, if any. Captured on shift+left-down over a
    /// waypoint marker; committed on pointerup as an INSERT+REMOVE batch.
    /// originalOrder is a snapshot of the dragged order from lastQueues
    /// at the moment the drag began — preserves cmdId, options, and the
    /// non-positional trailing params (e.g. build facing).
    private waypointDrag: {
        unitId: number;
        tag: number;
        cmdId: number;
        originalParams: number[];
        originalOptions: number;
        ghostLine: Mesh | null;
        markerMesh: Mesh | null;
    } | null = null;

    // Build placement state — non-null while the player has clicked a build
    // button and is choosing a ground location. Cancelled by ESC, right-click,
    // selection change, or a successful left-click placement (unless shift is
    // held, in which case placement mode persists for queue building).
    private buildPlacement: {
        defId: number;
        ghost: TransformNode;
        /// True when ghost is the procedural box fallback (no model loaded
        /// yet). Box ghosts get a solid-fill emissive tint; unit-mesh
        /// ghosts use per-piece materials we own and re-tint via the
        /// shared StandardMaterial set up in EntityRenderer.createGhostMesh.
        ghostIsBox: boolean;
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

    /// Pending "modal" command set by a hotkey (A=fight, P=patrol, R=repair,
    /// E=reclaim, G=guard, etc.). When non-null, the next right-click consumes
    /// the modal and resolves it according to `pendingCmdTarget`. Cleared
    /// after the next click or by pressing ESC.
    private pendingCmd: number | null = null;
    /// How to resolve the next click for `pendingCmd`:
    ///   - 'ground'  → params = [x, y, z]            (move, fight, patrol)
    ///   - 'unit'    → params = [unitId]             (guard, attack, repair, reclaim, capture, dgun, load, resurrect)
    ///   - 'either'  → unit if one is under cursor, else ground point
    /// Reclaim/repair/resurrect can target features as well as units; the
    /// server-side resolver tolerates a feature id offset by FEATURE_BIT
    /// (handled in MobileCAI / BuilderCAI).
    private pendingCmdTarget: 'ground' | 'unit' | 'either' = 'ground';

    private connection: Connection;

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
        this.connection = connection;
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

    /** Optional AnimatedCursor — when set, cmd-mode changes drive the
     *  animated overlay instead of falling back to CSS cursors. Wired
     *  from main.ts once the lobby URL + game ID are known. */
    private animatedCursor: AnimatedCursor | null = null;
    setAnimatedCursor(cursor: AnimatedCursor | null): void {
        this.animatedCursor = cursor;
    }

    /** Install (or clear) the CommandNotify gate on the CommandBuffer.
     *  Wired from main.ts once the LuaWidgetManager exists — every
     *  mouse-issued command then routes through widgetHandler.CommandNotify
     *  before reaching the server. */
    setCommandNotifier(fn: import('./command-buffer.js').CommandNotifier | null): void {
        this.commandBuffer.setNotifier(fn);
    }

    /** Latest cursor hover-target (unit under the pointer, or -1 for none).
     *  Updated each pointermove that crosses a different entity; reset to
     *  -1 when the cursor moves off all entities or onto UI. The change
     *  callback fires only on transitions so the worker doesn't see a
     *  flood of identical defaults during a stationary cursor. */
    private hoveredEntityId = -1;
    /** Spring contract: the engineCmd that the widget DefaultCommand
     *  callin gets passed alongside the target type. We compute it
     *  client-side from the unit's team relative to ours: friendly →
     *  GUARD, enemy → ATTACK, no target → MOVE. This mirrors Spring's
     *  CGuiHandler::GetDefaultCommand which picks the cmd that would
     *  fire on right-click absent a widget override. */
    private hoveredEngineCmd: number = CMD.MOVE;
    private onHoverTargetChange:
        ((info: { targetType: 'unit' | 'feature' | null; targetId: number; engineCmd: number }) => void)
        | null = null;
    /** Wired from main.ts to LuaWidgetManager.forwardDefaultCommandTarget
     *  so the worker can dispatch widget:DefaultCommand on every
     *  hover-target change. Pass null to disable. */
    setHoverTargetCallback(
        fn: ((info: { targetType: 'unit' | 'feature' | null; targetId: number; engineCmd: number }) => void) | null,
    ): void {
        this.onHoverTargetChange = fn;
    }

    /** Resolved default-command override for the current hover target.
     *  Populated by main.ts from `LuaWidgetManager.onDefaultCommandResolved`
     *  after the worker walked widget:DefaultCommand. Consulted by the
     *  right-click handler so widgets like unit_default_commands /
     *  cmd_mex_placement actually steer the issued cmd, not just the
     *  cursor tooltip. */
    private defaultCommandOverride: { cmdId: number; targetType: 'unit' | 'feature' | null; targetId: number } | null = null;
    setDefaultCommandOverride(info: { cmdId: number; targetType: 'unit' | 'feature' | null; targetId: number } | null): void {
        this.defaultCommandOverride = info;
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
     * Modifiers are forwarded to the Command options bitmask:
     *   - factories: shift=×5, ctrl=×20, shift+ctrl=×100 batch counts
     *     (FactoryCAI::GetCountMultiplierFromOptions; OTA convention).
     *   - builders: shift queues the build behind existing commands and
     *     keeps placement mode open for chain-building.
     */
    startBuildPlacement(
        defId: number,
        mods: boolean | { shift?: boolean; ctrl?: boolean } = false,
    ): void {
        // Accept the legacy boolean shape from older callers.
        const shift = typeof mods === 'boolean' ? mods : !!mods.shift;
        const ctrl  = typeof mods === 'boolean' ? false : !!mods.ctrl;

        // Replace any existing placement (rapid button switch).
        this.cancelBuildPlacement();

        if (this.selectedIds.length === 0) return;

        // Pure factory selection: queue immediately, skip ground placement.
        if (this.allSelectedAreFactories()) {
            const options = (shift ? OPT_SHIFT : 0) | (ctrl ? OPT_CTRL : 0);
            this.commandBuffer.issueImmediate(
                -defId, this.selectedIds.slice(),
                [],
                options);
            return;
        }

        const def = this.defCache?.getUnitDef(defId);
        // Spring footprints are in heightmap squares (8 elmos each). Default
        // to 2x2 if the def hasn't streamed yet — the ghost is just a hint,
        // not a constraint, so a guess is fine.
        // Spring's xsize/zsize are already in elmos (footprint * 2 each).
        const fpX = (def?.xsize ?? 4) * 8;
        const fpZ = (def?.zsize ?? 4) * 8;

        // Build the ghost mesh. Try the unit's actual model first so
        // the player sees the building they're placing; fall back to a
        // box-shaped placeholder if the model isn't loaded yet or the
        // mesh build fails. The fallback is wrapped in try/catch so a
        // bug in createGhostMesh can never block placement state setup
        // — building must work even if the ghost doesn't render.
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
            console.warn('[input] unit-mesh ghost failed, using box', err);
            ghost = makeBoxGhost(this.scene, fpX, fpZ, baseEmissive);
            ghostIsBox = true;
        }
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
            defId, ghost, ghostIsBox, footprintX: fpX, footprintZ: fpZ,
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

    /** Pending-build ghosts. Each entry is the ghost mesh issued by a
     *  previous left-click during build placement, plus the matching
     *  defId, builder ids, and grid-snapped (x,z). Lives until either
     *  the construction starts (any owner's command queue no longer
     *  references this build at this position) or the player explicitly
     *  cancels via the per-ghost ESC handler / a new selection (we do
     *  NOT auto-clear on selection change, only on explicit cancel —
     *  pending sites are expected to outlive the originating selection
     *  on a typical "queue then move on" flow).
     *
     *  Quantised position (16-elmo grid for normal builds, exact spot
     *  for mex placements) is what we match against incoming command
     *  queue updates. Server snaps build coords to the same grid so the
     *  match is exact. */
    private pendingBuilds: Array<{
        ghost: TransformNode;
        defId: number;
        gx: number;
        gz: number;
        owners: Set<number>;
    }> = [];

    get isPlacingBuild(): boolean { return this.buildPlacement !== null; }

    private updateBuildGhost(clientX: number, clientY: number): void {
        if (!this.buildPlacement) return;
        const groundPos = this.pickGroundAt(clientX, clientY);
        if (!groundPos) return;

        const bp = this.buildPlacement;
        const def = this.defCache?.getUnitDef(bp.defId);
        // Spring's xsize/zsize are footprint*2 in heightmap squares (8 elmos
        // each). The engine's Pos2BuildPos snaps to a 16-elmo grid with a
        // parity offset based on xsize/zsize (odd → +8, even → 0). ZK's
        // metal-spot table is keyed by the same grid (mex_spot_finder's
        // AdjustCoordinates), so we have to apply this exact snap before
        // sending — otherwise mex_placement.lua's AllowCommand silently
        // rejects the build because metalSpotsByPos[x][z] doesn't exist.
        const xsize = def?.xsize ?? 4;
        const zsize = def?.zsize ?? 4;

        if (bp.isMex) {
            // Mex placement snaps to the nearest metal spot. A spot out of
            // range means the placement won't actually extract anything —
            // tint the ghost red so the player can see the click is bad.
            const spot = nearestMetalSpot(this.metalSpots, groundPos.x, groundPos.z, bp.mexSnapRadius);
            if (spot) {
                const [sx, sz] = snapToBuildGrid(spot.x, spot.z, xsize, zsize);
                bp.snappedSpot = { ...spot, x: sx, z: sz };
                bp.ghost.position.set(sx, groundPos.y + 0.5, sz);
                this.tintGhost(bp.ghost, bp.ghostIsBox, bp.defaultEmissive);
            } else {
                bp.snappedSpot = null;
                // No spot in range — follow cursor, tint red.
                bp.ghost.position.set(groundPos.x, groundPos.y + 0.5, groundPos.z);
                this.tintGhost(bp.ghost, bp.ghostIsBox, new Color3(0.5, 0.05, 0.05));
            }
            return;
        }

        // Standard build: snap to Spring's 16-elmo grid using footprint parity.
        const [gx, gz] = snapToBuildGrid(groundPos.x, groundPos.z, xsize, zsize);
        bp.ghost.position.set(gx, groundPos.y + 0.5, gz);
    }

    /** Re-tint the ghost emissive. Box ghosts carry their material directly;
     *  mesh ghosts share a single StandardMaterial across all piece clones
     *  (created by EntityRenderer.createGhostMesh), so updating the first
     *  child's material is enough to repaint the whole ghost. */
    private tintGhost(ghost: TransformNode, isBox: boolean, color: Color3): void {
        if (isBox) {
            const mat = (ghost as Mesh).material as StandardMaterial;
            mat.emissiveColor = color;
            return;
        }
        for (const c of ghost.getChildMeshes()) {
            const mat = c.material as StandardMaterial | null;
            if (mat) {
                mat.emissiveColor = color;
                break;
            }
        }
    }

    private issueBuildAt(groundPos: Vector3, queue: boolean): void {
        if (!this.buildPlacement) return;
        const bp = this.buildPlacement;
        const defId = bp.defId;
        // Default facing south (0). A future enhancement: hold-and-drag to set
        // facing from the drag direction (Spring's standard build placement).
        const facing = 0;

        const def = this.defCache?.getUnitDef(defId);
        const xsize = def?.xsize ?? 4;
        const zsize = def?.zsize ?? 4;
        let x: number, y: number, z: number;
        if (bp.isMex) {
            // Mex placement requires snapping to a metal spot. If the player
            // clicks while no spot is in range (ghost was red), drop the
            // command — issuing it anyway just builds a useless mex on dead
            // ground. Stay in placement mode so the player can adjust. The
            // spot's (x, z) was already snapped to the build grid in
            // updateBuildGhost so it matches ZK's metalSpotsByPos keys.
            if (!bp.snappedSpot) {
                return;
            }
            x = bp.snappedSpot.x;
            z = bp.snappedSpot.z;
            y = groundPos.y;
        } else {
            // Apply the same Pos2BuildPos snap the server would. Matching
            // the server-side grid client-side keeps the ghost position
            // identical to where the building will actually land.
            [x, z] = snapToBuildGrid(groundPos.x, groundPos.z, xsize, zsize);
            y = groundPos.y;
        }

        // Negative cmdId = build command, -cmdId is the unit-def id.
        // Shift in options bitfield = queue order behind existing commands.
        const builders = this.selectedIds.slice();
        this.commandBuffer.issueImmediate(
            -defId, builders,
            [x, y, z, facing],
            queue ? OPT_SHIFT : 0);

        // Promote the placement ghost into a "pending" marker that lingers
        // at the build site until construction starts (the unit will
        // appear there) or the player explicitly cancels. We snapshot the
        // ghost so the next placement (in queue mode) gets a fresh one.
        this.promoteGhostToPending(defId, x, z, builders);

        // Stay in placement mode while shift is held (chain-build sites);
        // otherwise drop out so the next left-click selects normally.
        if (!queue) {
            this.buildPlacement = null;
            if (this.moveListener) {
                const canvas = this.scene.getEngine().getRenderingCanvas();
                canvas?.removeEventListener('mousemove', this.moveListener);
                this.moveListener = null;
            }
            // Don't dispose the ghost — it now lives in pendingBuilds.
        } else {
            // Queue mode: spawn a fresh hover ghost so the next click
            // gets its own marker. Same try-mesh-then-fall-back-to-box
            // path as startBuildPlacement.
            let fresh: TransformNode;
            let freshIsBox = false;
            try {
                const meshGhost = this.entityRenderer.createGhostMesh(defId, `build-ghost-${defId}`);
                if (meshGhost) {
                    fresh = meshGhost;
                } else {
                    fresh = makeBoxGhost(this.scene,
                        this.buildPlacement.footprintX,
                        this.buildPlacement.footprintZ,
                        this.buildPlacement.defaultEmissive);
                    freshIsBox = true;
                }
            } catch (err) {
                console.warn('[input] queue ghost failed, using box', err);
                fresh = makeBoxGhost(this.scene,
                    this.buildPlacement.footprintX,
                    this.buildPlacement.footprintZ,
                    this.buildPlacement.defaultEmissive);
                freshIsBox = true;
            }
            fresh.position.set(-1e6, 0, 0);
            this.buildPlacement.ghost = fresh;
            this.buildPlacement.ghostIsBox = freshIsBox;
        }
    }

    /** Hand off the active hover ghost to the pending list. The ghost is
     *  re-tinted to a paler "queued" colour so it reads differently from
     *  the live placement preview. */
    private promoteGhostToPending(defId: number, x: number, z: number, owners: number[]): void {
        if (!this.buildPlacement) return;
        const bp = this.buildPlacement;
        // Soften the colour so queued sites don't compete visually with
        // the live placement ghost.
        this.tintGhost(bp.ghost, bp.ghostIsBox, new Color3(0.05, 0.2, 0.1));
        if (bp.ghostIsBox) {
            const mat = (bp.ghost as Mesh).material as StandardMaterial;
            mat.alpha = 0.25;
        } else {
            for (const c of bp.ghost.getChildMeshes()) {
                const m = c.material as StandardMaterial | null;
                if (m) { m.alpha = 0.25; break; }
            }
        }
        this.pendingBuilds.push({
            ghost: bp.ghost,
            defId,
            gx: Math.round(x),
            gz: Math.round(z),
            owners: new Set(owners),
        });
    }

    /** Called from the host when fresh command queue snapshots arrive.
     *  Drops any pending ghost whose corresponding build order is no
     *  longer in *any* of its owning units' command queues — that's our
     *  signal that construction has started (the order pops off the head
     *  when the builder reaches the site) or the player cancelled it.
     *  Also caches the queues so the waypoint-drag handler can look up
     *  the original order's full params on commit. */
    onCommandQueuesUpdated(queues: ReadonlyArray<{ unitId: number; orders: ReadonlyArray<{ cmdId: number; params: number[]; tag?: number; options?: number }> }>): void {
        this.lastQueues = queues;
        if (this.pendingBuilds.length === 0) return;
        // Build a quick lookup: unitId → set of "build@x,z@defId" keys.
        const unitToBuilds = new Map<number, Set<string>>();
        for (const q of queues) {
            const set = new Set<string>();
            for (const o of q.orders) {
                if (o.cmdId < 0 && o.params.length >= 3) {
                    const defId = -o.cmdId;
                    const x = Math.round(o.params[0]);
                    const z = Math.round(o.params[2]);
                    set.add(`${defId}@${x},${z}`);
                }
            }
            unitToBuilds.set(q.unitId, set);
        }
        const stillPending: typeof this.pendingBuilds = [];
        for (const p of this.pendingBuilds) {
            const key = `${p.defId}@${p.gx},${p.gz}`;
            let stillQueued = false;
            for (const owner of p.owners) {
                const set = unitToBuilds.get(owner);
                if (set && set.has(key)) { stillQueued = true; break; }
            }
            if (stillQueued) {
                stillPending.push(p);
            } else {
                p.ghost.dispose();
            }
        }
        this.pendingBuilds = stillPending;
    }

    /** Drop every pending ghost (e.g. on quit-to-lobby teardown). */
    clearPendingBuilds(): void {
        for (const p of this.pendingBuilds) p.ghost.dispose();
        this.pendingBuilds = [];
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
                    if (this.onHoverTargetChange) this.updateHoverTarget(evt);
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

        // Per-waypoint revocation: Ctrl+left-click on a waypoint marker
        // sends CMD.REMOVE for that order's tag. Must run before build-
        // placement / drag-select fall-through so the gesture isn't
        // misinterpreted as a deselect or build commit.
        if (evt.ctrlKey && !evt.shiftKey && !evt.altKey) {
            if (this.tryRevokeWaypointAt(evt)) return;
        }

        // Waypoint drag: Shift+left-down over a waypoint marker captures
        // the drag. Commit happens on pointerup (onLeftUp). Must run
        // before the regular shift-additive selection path.
        if (evt.shiftKey && !evt.ctrlKey && !evt.altKey) {
            if (this.tryStartWaypointDrag(evt)) return;
        }

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

    /** Pick test against waypoint marker meshes. Returns true if a
     *  marker was hit and CMD.REMOVE was sent — caller should bail out
     *  of the rest of the left-click handler. */
    private tryRevokeWaypointAt(evt: PointerEvent): boolean {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return false;
        const rect = canvas.getBoundingClientRect();
        const cx = evt.clientX - rect.left;
        const cy = evt.clientY - rect.top;
        // scene.pick uses canvas-relative pixel coords; predicate filters
        // out everything except marker instances. Markers are
        // depth-always so even those hidden behind hills still pick.
        const pick = this.scene.pick(cx, cy, (m) =>
            m.isPickable && m.name.startsWith('waypoint-marker-'),
        );
        if (!pick?.hit || !pick.pickedMesh) return false;
        const meta = (pick.pickedMesh.metadata as { waypoint?: WaypointMarkerMeta } | null)?.waypoint;
        if (!meta || !meta.tag) {
            // Untagged orders (tag = 0) shouldn't reach revocation — the
            // server reserves tag 0 for "no tag". Bail without dropping
            // through to selection.
            return false;
        }
        // CMD.REMOVE params = [tag1, tag2, ...]. Plain REMOVE (no OPT.ALT)
        // matches by tag — exactly one queued order is removed. Multi-
        // unit revocation by position-match is deferred; revoking the
        // picked marker's specific order is the simplest correct
        // behaviour and matches Spring's per-tag REMOVE semantics.
        this.commandBuffer.issueImmediate(
            CMD.REMOVE,
            [meta.unitId],
            [meta.tag],
            0,
        );
        return true;
    }

    private onDragMove(evt: PointerEvent): void {
        this.dragCurX = evt.clientX;
        this.dragCurY = evt.clientY;
        if (this.waypointDrag) {
            this.updateWaypointDrag(evt);
            return;
        }
        const dx = this.dragCurX - this.dragStartX;
        const dy = this.dragCurY - this.dragStartY;
        if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
            this.showDragOverlay();
        }
    }

    private onLeftUp(evt: PointerEvent): void {
        this.dragActive = false;
        this.hideDragOverlay();

        if (this.waypointDrag) {
            this.commitWaypointDrag(evt);
            return;
        }

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

    /** Try to start a waypoint drag from a Shift+left-down. Returns true
     *  if the gesture was captured (caller should bail). */
    private tryStartWaypointDrag(evt: PointerEvent): boolean {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return false;
        const rect = canvas.getBoundingClientRect();
        const cx = evt.clientX - rect.left;
        const cy = evt.clientY - rect.top;
        const pick = this.scene.pick(cx, cy, (m) =>
            m.isPickable && m.name.startsWith('waypoint-marker-'),
        );
        if (!pick?.hit || !pick.pickedMesh) return false;
        const meta = (pick.pickedMesh.metadata as { waypoint?: WaypointMarkerMeta } | null)?.waypoint;
        if (!meta || !meta.tag) return false;

        // Look up the original order in the cached queue snapshot so we
        // preserve its full params + options when re-inserting. Bail if
        // the queue cache hasn't received the order yet — the marker is
        // stale and we can't issue a correct INSERT.
        const queue = this.lastQueues.find((q) => q.unitId === meta.unitId);
        const order = queue?.orders.find((o) => o.tag === meta.tag);
        if (!order) return false;

        // Set up drag state. Hide the picked marker so it doesn't
        // re-appear at the original position while the user drags.
        const markerMesh = pick.pickedMesh as Mesh;
        markerMesh.isVisible = false;

        this.waypointDrag = {
            unitId: meta.unitId,
            tag: meta.tag,
            cmdId: meta.cmdId,
            originalParams: order.params.slice(),
            originalOptions: order.options ?? 0,
            ghostLine: null,
            markerMesh,
        };

        // Trigger drag-active state so onDragMove keeps firing. dragShift
        // is irrelevant for a waypoint drag — we read evt.shiftKey on
        // commit. Use a tiny epsilon delta so the drag-threshold check in
        // onDragMove doesn't immediately fire the regular drag-overlay.
        this.dragActive = true;
        this.dragStartX = evt.clientX;
        this.dragStartY = evt.clientY;
        this.dragCurX = evt.clientX;
        this.dragCurY = evt.clientY;
        return true;
    }

    /** Update the ghost-line preview while a waypoint drag is in flight. */
    private updateWaypointDrag(evt: PointerEvent): void {
        const drag = this.waypointDrag;
        if (!drag) return;
        const groundPos = this.pickGroundAt(evt.clientX, evt.clientY);
        if (!groundPos) return;

        // Original world position (from the snapshotted params) →
        // current cursor ground point. Simple 2-vertex line line — we
        // recreate on every move rather than updating vertices in place;
        // pointer-move frequency is low enough that re-allocation is
        // cheaper than the bookkeeping for updateable meshes.
        const oP = drag.originalParams;
        if (oP.length < 3) return;
        const start = new Vector3(oP[0], oP[1] + 6, oP[2]);
        const end = new Vector3(groundPos.x, groundPos.y + 6, groundPos.z);

        drag.ghostLine?.dispose();
        const line = MeshBuilder.CreateLines(
            'waypoint-drag-ghost',
            { points: [start, end], updatable: false },
            this.scene,
        );
        line.color = new Color3(1, 1, 1);
        line.alpha = 0.85;
        line.isPickable = false;
        line.renderingGroupId = 3;
        drag.ghostLine = line;
    }

    /** Commit the waypoint drag — send a PlayerCommandBatch with an
     *  INSERT (new position, tagged via OPT.ALT to anchor before the
     *  original order's slot) and a REMOVE (drop the original tag). The
     *  batch guarantees atomic execution on a single sim tick so the
     *  unit never sees an intermediate state with both orders queued. */
    private commitWaypointDrag(evt: PointerEvent): void {
        const drag = this.waypointDrag;
        if (!drag) return;
        // Always clear visual state first so an early bail-out below
        // doesn't leak the ghost line or hidden marker.
        drag.ghostLine?.dispose();
        if (drag.markerMesh) drag.markerMesh.isVisible = true;
        this.waypointDrag = null;

        const groundPos = this.pickGroundAt(evt.clientX, evt.clientY);
        if (!groundPos) return;

        // Detect a no-op: cursor barely moved (treated as a click, not a
        // drag). Cancel rather than committing a redundant batch.
        const dx = evt.clientX - this.dragStartX;
        const dy = evt.clientY - this.dragStartY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

        // Construct the new params: replace the first three (x, y, z)
        // with the cursor's ground position, keep any trailing params
        // (build facing, radius, etc.) untouched.
        const newParams = drag.originalParams.slice();
        newParams[0] = groundPos.x;
        newParams[1] = groundPos.y;
        newParams[2] = groundPos.z;

        // INSERT params layout (see CommandAI.cpp ExecuteInsert):
        //   [insertPos, newCmdId, newOpts, ...newParams]
        // With OPT.ALT on the INSERT itself, insertPos is interpreted as
        // a TAG: the server looks up the order with that tag and inserts
        // the new order before it. Pair with a REMOVE on the same tag
        // and the result is a positional rewrite of the dragged order
        // (the original tag's slot is filled by the new INSERT, then
        // the original is dropped).
        const insertParams = [drag.tag, drag.cmdId, drag.originalOptions, ...newParams];

        this.connection.sendPlayerCommandBatch([
            {
                commandId: CMD.INSERT,
                unitIds: [drag.unitId],
                params: insertParams,
                options: OPT_ALT,
            },
            {
                commandId: CMD.REMOVE,
                unitIds: [drag.unitId],
                params: [drag.tag],
                options: 0,
            },
        ]);
    }

    // ---- Single click ----

    private handleSingleClick(evt: PointerEvent): void {
        // Project each entity's world position to screen space and pick
        // the one whose projected centre is closest to the click pixel.
        // World-space proximity to the ground-pick fails for tall units
        // (factories, towers) — the click ray hits terrain well behind
        // the footprint and the entity ends up outside SELECT_RADIUS.
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cx = evt.clientX - rect.left;
        const cy = evt.clientY - rect.top;

        const engine = this.scene.getEngine();
        const viewport = this.camera.viewport.toGlobal(
            engine.getRenderWidth(),
            engine.getRenderHeight(),
        );
        const worldMat = this.scene.getTransformMatrix();
        const identity = Matrix.Identity();

        let nearestId = -1;
        let nearestDistSq = SELECT_PIXEL_RADIUS * SELECT_PIXEL_RADIUS;
        for (const [id] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const projected = Vector3.Project(
                new Vector3(pos.x, pos.y, pos.z),
                identity, worldMat, viewport);
            // Skip entities behind the camera or beyond the far plane.
            if (projected.z < 0 || projected.z > 1) continue;
            const dx = projected.x - cx;
            const dy = projected.y - cy;
            const distSq = dx * dx + dy * dy;
            if (distSq < nearestDistSq) {
                nearestDistSq = distSq;
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

        const opts = shift ? OPT_SHIFT : 0;

        // Find the nearest non-selected unit to the click point — used both
        // by modal-cmd resolution and the default right-click behaviour.
        const nearest = this.pickNearestEntityAt(groundPos);

        // Modal hotkey command (A=fight, P=patrol, R=repair, etc.). The
        // pendingCmdTarget governs how the click resolves.
        if (this.pendingCmd !== null) {
            const cmd = this.pendingCmd;
            this.pendingCmd = null;
            this.updateCursorMode();

            if (this.pendingCmdTarget === 'ground') {
                this.commandBuffer.issueImmediate(
                    cmd, this.selectedIds,
                    [groundPos.x, groundPos.y, groundPos.z], opts);
                return;
            }
            // unit-required: needs a target under the cursor; abort if none.
            if (this.pendingCmdTarget === 'unit') {
                if (nearest.id < 0) return;
                this.commandBuffer.issueImmediate(cmd, this.selectedIds, [nearest.id], opts);
                return;
            }
            // either: prefer unit if there is one nearby, else ground point.
            if (nearest.id >= 0) {
                this.commandBuffer.issueImmediate(cmd, this.selectedIds, [nearest.id], opts);
            } else {
                this.commandBuffer.issueImmediate(
                    cmd, this.selectedIds,
                    [groundPos.x, groundPos.y, groundPos.z], opts);
            }
            return;
        }

        // Widget DefaultCommand override: if the cursor is over the same
        // unit we tracked at hover time and a widget rewrote the
        // engineCmd (cmd_mex_placement returning CMD_RECLAIM, etc.), use
        // its cmdId in place of the engine default. The override is
        // cleared when the hover target moves elsewhere, so a stale
        // override never applies to a fresh click target.
        const override = this.defaultCommandOverride;
        const overrideAppliesToUnit =
            override && override.targetType === 'unit' && nearest.id >= 0 && override.targetId === nearest.id;
        const overrideAppliesToGround =
            override && override.targetType === null && nearest.id < 0;

        if (nearest.id >= 0) {
            const isFriendly = this.myTeam >= 0 && nearest.team === this.myTeam;
            // Friendly → Guard (assist/escort). Enemy → Attack.
            const engineCmd = isFriendly ? CMD.GUARD : CMD.ATTACK;
            const cmd = overrideAppliesToUnit ? override!.cmdId : engineCmd;
            // Unit-targeting cmds take [unitId]; ground-targeting cmds
            // (RECLAIM, REPAIR, etc. can also accept a ground point with
            // a radius) want [unitId] when applied to a unit. Stick with
            // [unitId] for the override case — it matches Spring's
            // CGuiHandler::ProcessLocalActions.
            this.commandBuffer.issueImmediate(cmd, this.selectedIds, [nearest.id], opts);
        } else {
            const cmd = overrideAppliesToGround ? override!.cmdId : CMD.MOVE;
            this.commandBuffer.issueImmediate(cmd, this.selectedIds, [groundPos.x, groundPos.y, groundPos.z], opts);
        }
    }

    /** Pick the nearest non-selected entity within SELECT_RADIUS of a ground
     *  point. Returns id<0 when nothing matches. Used for right-click target
     *  classification and modal-command resolution. */
    /** Throttled to fire on hover-target change only. The worker's
     *  widget:DefaultCommand gets the (targetType, targetID, engineCmd)
     *  triple — engineCmd is the cmd Spring would issue absent a widget
     *  override (friendly→GUARD, enemy→ATTACK, none→MOVE). Feature
     *  hovering isn't wired yet; targetType is 'unit' or null today. */
    private updateHoverTarget(evt: PointerEvent): void {
        if (this.isOverUI()) {
            // Cursor over chili → no hover-target. Reset and emit a
            // null transition so the worker clears any stale override.
            if (this.hoveredEntityId !== -1 || this.hoveredEngineCmd !== CMD.MOVE) {
                this.hoveredEntityId = -1;
                this.hoveredEngineCmd = CMD.MOVE;
                this.onHoverTargetChange?.({ targetType: null, targetId: 0, engineCmd: CMD.MOVE });
            }
            return;
        }
        const groundPos = this.pickGroundAt(evt.clientX, evt.clientY);
        if (!groundPos) return;
        const nearest = this.pickNearestEntityForHover(groundPos);
        let targetType: 'unit' | 'feature' | null = null;
        let targetId = 0;
        let engineCmd: number = CMD.MOVE;
        if (nearest.id > 0) {
            targetType = 'unit';
            targetId = nearest.id;
            engineCmd = (nearest.team === this.myTeam) ? CMD.GUARD : CMD.ATTACK;
        }
        if (targetId === this.hoveredEntityId && engineCmd === this.hoveredEngineCmd) return;
        this.hoveredEntityId = targetId;
        this.hoveredEngineCmd = engineCmd;
        this.onHoverTargetChange?.({ targetType, targetId, engineCmd });
    }

    /** Like pickNearestEntityAt but doesn't skip selected units — the
     *  hover-target tracker wants to know about every unit under the
     *  cursor (a widget might still rewrite the default command when
     *  hovering one of your own selected units, e.g. cmd_stop_selfd
     *  reading SelfD state). */
    private pickNearestEntityForHover(groundPos: Vector3): { id: number; team: number } {
        let id = -1;
        let team = -1;
        let bestSq = SELECT_RADIUS * SELECT_RADIUS;
        for (const [eid, meta] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(eid);
            if (!pos) continue;
            const dx = pos.x - groundPos.x;
            const dz = pos.z - groundPos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < bestSq) {
                bestSq = distSq;
                id = eid;
                team = meta.team;
            }
        }
        return { id, team };
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
            if (distSq < bestSq) {
                bestSq = distSq;
                id = eid;
                team = meta.team;
            }
        }
        return { id, team };
    }

    /** Arm a modal command — the next right-click resolves it. Used both by
     *  the keyboard handler and the order-panel UI. `target` controls how the
     *  click is interpreted (ground point, unit id, or either). */
    armPendingCommand(cmd: number, target: 'ground' | 'unit' | 'either'): void {
        this.pendingCmd = cmd;
        this.pendingCmdTarget = target;
        this.updateCursorMode();
    }

    /** True if a modal command is currently armed. */
    hasPendingCommand(): boolean {
        return this.pendingCmd !== null;
    }

    /** Issue a command immediately — used by the order panel for instant
     *  toggles (stop, fire-state, move-state, on/off, repeat, trajectory). */
    issueImmediateCommand(cmd: number, params: number[], options: number = 0): void {
        if (this.selectedIds.length === 0) return;
        this.commandBuffer.issueImmediate(cmd, this.selectedIds, params, options);
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

            // Don't fire hotkeys while modifiers are held (Ctrl-A is browser
            // select-all, Cmd-W closes the tab, etc.). Shift is treated as
            // queue-mode and is handled per-command below where it makes sense.
            if (e.ctrlKey || e.altKey || e.metaKey) return;

            const queue = e.shiftKey ? OPT_SHIFT : 0;

            switch (e.key.toLowerCase()) {
                // ---- Instant orders ----
                case 's':
                    this.commandBuffer.issueImmediate(CMD.STOP, this.selectedIds, []);
                    break;
                case 'w':
                    // Wait — Spring's "pause this unit's queue" toggle.
                    this.commandBuffer.issueImmediate(CMD.WAIT, this.selectedIds, [], queue);
                    break;
                case 'h':
                    // Hold position — sets MOVE_STATE to 0.
                    this.commandBuffer.issueImmediate(CMD.MOVE_STATE, this.selectedIds, [0]);
                    break;
                case 'q':
                    // Cycle fire-state (hold-fire → return-fire → fire-at-will).
                    // Without per-unit state on the client we just bump it; the
                    // server clamps modulo the unit's allowed range.
                    this.cycleFireState();
                    break;
                case 'i':
                    // Toggle idle mode (factories: rally vs roam newly built units).
                    this.commandBuffer.issueImmediate(CMD.IDLEMODE, this.selectedIds, [-1]);
                    break;

                // ---- Modal target-then-click commands ----
                case 'm':
                    // Move — explicit modal so right-click can be reserved
                    // for default behaviour. Next click resolves to ground.
                    this.armPendingCommand(CMD.MOVE, 'ground');
                    break;
                case 'a':
                case 'f':
                    // Attack-move / Fight: ground target.
                    this.armPendingCommand(CMD.FIGHT, 'ground');
                    break;
                case 'p':
                    // Patrol: ground waypoint.
                    this.armPendingCommand(CMD.PATROL, 'ground');
                    break;
                case 'g':
                    // Guard: friendly unit.
                    this.armPendingCommand(CMD.GUARD, 'unit');
                    break;
                case 'r':
                    // Repair: friendly unit (or feature for builders).
                    this.armPendingCommand(CMD.REPAIR, 'unit');
                    break;
                case 'e':
                    // rEclaim: feature / unit / wreck.
                    this.armPendingCommand(CMD.RECLAIM, 'either');
                    break;
                case 'c':
                    // Capture: enemy unit.
                    this.armPendingCommand(CMD.CAPTURE, 'unit');
                    break;
                case 'x':
                    // Resurrect: feature (corpse).
                    this.armPendingCommand(CMD.RESURRECT, 'either');
                    break;
                case 'd':
                    // D-gun / manual fire: enemy unit (or ground for AoE D-guns).
                    this.armPendingCommand(CMD.MANUALFIRE, 'either');
                    break;
                case 'l':
                    // Load units into transport: friendly unit.
                    this.armPendingCommand(CMD.LOAD_UNITS, 'unit');
                    break;
                case 'u':
                    // Unload units from transport at ground point.
                    this.armPendingCommand(CMD.UNLOAD_UNITS, 'ground');
                    break;
            }
        });
    }

    /** Bump fire state by one (hold → return-fire → fire-at-will → hold).
     *  Without per-unit state cached client-side we always send the next
     *  step; the server clamps it. */
    private cycleFireState(): void {
        // Spring's fire-state values: 0 = hold, 1 = return, 2 = fire at will.
        // We send a synthetic "advance" via param=-1 if the server supports
        // it; otherwise step through 0/1/2 from a local cycle counter.
        const next = (this.fireStateCycle + 1) % 3;
        this.fireStateCycle = next;
        this.commandBuffer.issueImmediate(CMD.FIRE_STATE, this.selectedIds, [next]);
    }
    private fireStateCycle = 2;

    /** Reflect pendingCmd in the canvas cursor so the player can see they're
     *  in a modal-command mode. Prefers AnimatedCursor (loads ZK's PNG
     *  cursor packs from `Anims/cursor*.txt`); falls back to generic CSS
     *  cursors when no AnimatedCursor is wired or its load failed. */
    private updateCursorMode(): void {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return;
        // Map pendingCmd → Spring's canonical cursor name (the same
        // strings ZK widgets pass to AssignMouseCursor / SetMouseCursor).
        let cursorName: string | null = null;
        let cssFallback = '';
        switch (this.pendingCmd) {
            case CMD.ATTACK:      cursorName = 'Attack';       cssFallback = 'crosshair'; break;
            case CMD.AREA_ATTACK: cursorName = 'Area attack';  cssFallback = 'crosshair'; break;
            case CMD.FIGHT:       cursorName = 'Fight';        cssFallback = 'crosshair'; break;
            case CMD.MANUALFIRE:  cursorName = 'ManualFire';   cssFallback = 'crosshair'; break;
            case CMD.PATROL:      cursorName = 'Patrol';       cssFallback = 'cell';      break;
            case CMD.MOVE:        cursorName = 'Move';         cssFallback = 'move';      break;
            case CMD.UNLOAD_UNITS: cursorName = 'Unload units'; cssFallback = 'move';     break;
            case CMD.LOAD_UNITS:  cursorName = 'Load units';   cssFallback = 'pointer';   break;
            case CMD.GUARD:       cursorName = 'Guard';        cssFallback = 'pointer';   break;
            case CMD.REPAIR:      cursorName = 'Repair';       cssFallback = 'pointer';   break;
            case CMD.RECLAIM:     cursorName = 'Reclaim';      cssFallback = 'pointer';   break;
            case CMD.CAPTURE:     cursorName = 'Capture';      cssFallback = 'pointer';   break;
            case CMD.RESURRECT:   cursorName = 'Resurrect';    cssFallback = 'pointer';   break;
            case CMD.SELFD:       cursorName = 'SelfD';        cssFallback = 'crosshair'; break;
            case CMD.WAIT:        cursorName = 'Wait';         cssFallback = 'progress';  break;
        }
        if (this.animatedCursor) {
            this.animatedCursor.setActive(cursorName);
            // CSS fallback covers the brief window before the manifest
            // loads on first activation.
            canvas.style.cursor = cursorName ? cssFallback : '';
        } else {
            canvas.style.cursor = cursorName ? cssFallback : '';
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

/** Build a translucent green box of the given footprint as a fallback
 *  ghost when the unit's actual model isn't loaded or createGhostMesh
 *  fails. Caller positions and disposes it. */
function makeBoxGhost(scene: Scene, fpX: number, fpZ: number, emissive: Color3): Mesh {
    const box = MeshBuilder.CreateBox('build-ghost', {
        width: fpX, depth: fpZ, height: 24,
    }, scene);
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
