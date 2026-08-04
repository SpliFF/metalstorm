/**
 * DirectiveShapeCapture — worker-side orchestrator that drives
 * `ShapeGestureCapture` (the shared, environment-agnostic gesture state
 * machine) against the game-processor worker's Babylon scene: resolves
 * pointer events to ground picks, renders a live shape preview, and commits
 * the finished shape as a `GroupDirective` (PLAN-macro-ui.md §2, §5).
 *
 * Consumed two ways, per the "shared library, not widget-private" mandate
 * (macro-ui task): (1) directly, via worker-internal hotkeys arming a
 * capture for the currently-selected org group (this file's `arm()`); (2) a
 * main-thread JS widget (org panel's "paint directive" button, or
 * metalstorm-scripting task 4's map-arm integration) can arm the *same*
 * underlying `ShapeGestureCapture` cross-thread via `gp:armDirectiveShape` /
 * `gp:directiveShapeResult` (game-processor.ts wires those onto this class —
 * neither consumer owns the gesture logic privately).
 *
 * Pointer routing mirrors `worker-command-modes.ts`'s area-attack drag: an
 * armed capture consumes every left click/drag exclusively (no selection
 * drag-box, no build placement underneath) until it completes or is
 * cancelled (ESC / RMB, wired by the caller).
 */

import {
    Scene,
    FreeCamera,
    Vector3,
    Mesh,
    MeshBuilder,
    StandardMaterial,
    Color3,
    CreateGreasedLine,
    GreasedLineMeshColorMode,
    GreasedLineMeshMaterialType,
} from '@babylonjs/core';
import type { Connection } from './connection.js';
import { ShapeGestureCapture, type ShapeKind } from './shape-gesture-capture.js';
import { OrderShape } from '../protocol/spring-web/order-shape.js';

/// gl.ALWAYS — same depth-always convention as standing-order-renderer /
/// worker-command-modes overlays (visible behind hills).
const DEPTH_ALWAYS = 519;

const PREVIEW_COLOR = new Color3(1.0, 0.85, 0.15); // amber — distinct from the red area-attack ring
const PREVIEW_LINE_WIDTH = 5;
const VERTEX_DOT_SIZE = 10;

const SHAPE_TO_ENUM: Record<ShapeKind, OrderShape> = {
    Point: OrderShape.Point,
    Circle: OrderShape.Circle,
    Polygon: OrderShape.Polygon,
    Polyline: OrderShape.Polyline,
};

export interface ArmedDirective {
    /** `DirectiveType` enum value (schemas/protocol.fbs). */
    directiveType: number;
    /** Target org group; 0 = condition-scoped (rare from a UI gesture — the
     *  org panel / hotkey path always arms with a real group id). */
    groupId: number;
    priority?: number;
    requestedStrength?: number;
    /** Skip the auto-send on commit — return the raw shape/params instead
     *  (metalstorm-scripting task 4's map-arm integration: the command
     *  composer wants the drawn shape to fill its Target slot for review,
     *  not an immediate directive). */
    captureOnly?: boolean;
}

export interface DirectiveShapeCaptureOpts {
    getCamera: (viewId: number) => FreeCamera | null;
    getDpr: () => number;
    /** Ground pick, CSS px → world point. Mirrors WorkerCommandModes'
     *  `pickGroundAt` (same terrain-mesh pick, kept as an injected callback
     *  so this class stays scene-generic). */
    pickGround: (cssX: number, cssY: number, viewId: number) => Vector3 | null;
    /** Fires whenever armed state flips — the caller mirrors it to
     *  `gp:cursorMode` / `gp:sceneState.commandModeArmed`-style feeds. */
    onArmedChanged?: (armed: boolean) => void;
    /** Fires once per capture lifecycle end (commit or cancel) — the caller
     *  forwards it as `gp:directiveShapeResult` for a cross-thread `arm()`er.
     *  `shape`/`params` are only populated on a `captureOnly` commit. */
    onResult?: (result: { committed: boolean; directiveId: number; shape?: ShapeKind; params?: number[] }) => void;
}

export class DirectiveShapeCapture {
    private readonly scene: Scene;
    private readonly connection: Connection;
    private readonly opts: DirectiveShapeCaptureOpts;
    private readonly capture = new ShapeGestureCapture();

    private armedDirective: ArmedDirective | null = null;
    private previewMeshes: Mesh[] = [];
    private previewMat: StandardMaterial | null = null;

    constructor(scene: Scene, connection: Connection, opts: DirectiveShapeCaptureOpts) {
        this.scene = scene;
        this.connection = connection;
        this.opts = opts;
    }

    get isArmed(): boolean { return this.capture.isArmed; }
    get armedShape(): ShapeKind | null { return this.capture.currentShape; }

    /** Arm a shape capture for a directive. `freehand`/`arrow` select the
     *  Polyline gesture variant (PLAN-macro-ui.md §7: both freehand and
     *  click-vertex are supported, caller's choice). */
    arm(directive: ArmedDirective, shape: ShapeKind, gestureOpts: { freehand?: boolean; arrow?: boolean } = {}): void {
        this.cancel(); // defensive: a stale capture never lingers under a new arm
        this.armedDirective = directive;
        if (gestureOpts.arrow) this.capture.beginArrow();
        else this.capture.begin(shape, { freehand: gestureOpts.freehand });
        this.opts.onArmedChanged?.(true);
        this.renderPreview();
    }

    /** Abandon the in-progress capture without committing. Safe to call
     *  when nothing is armed (ESC / RMB / re-arm). */
    cancel(): void {
        if (!this.capture.isArmed) return;
        this.capture.cancel();
        this.armedDirective = null;
        this.clearPreview();
        this.opts.onArmedChanged?.(false);
        this.opts.onResult?.({ committed: false, directiveId: 0 });
    }

    /** Left-press. Caller must route this BEFORE command-modes/selection
     *  while `isArmed` — an armed capture owns the mouse exclusively, same
     *  as an area-attack drag. Returns true (always) while armed. */
    pointerDown(cssX: number, cssY: number, viewId: number): boolean {
        if (!this.capture.isArmed) return false;
        const ground = this.opts.pickGround(cssX, cssY, viewId);
        if (ground) {
            const complete = this.capture.pointerDown([ground.x, ground.y, ground.z]);
            this.renderPreview();
            if (complete) this.commit();
        }
        return true;
    }

    pointerMove(cssX: number, cssY: number, viewId: number): void {
        if (!this.capture.isArmed) return;
        const ground = this.opts.pickGround(cssX, cssY, viewId);
        if (!ground) return;
        this.capture.pointerMove([ground.x, ground.y, ground.z]);
        this.renderPreview();
    }

    /** Left-release. Returns true if consumed (always, while armed). */
    pointerUp(): boolean {
        if (!this.capture.isArmed) return false;
        const complete = this.capture.pointerUp();
        this.renderPreview();
        if (complete) this.commit();
        return true;
    }

    /** Wheel while armed adjusts Polyline/Arrow frontage instead of camera
     *  zoom (PLAN-macro-ui.md §2 arrow row). Returns true if consumed. */
    wheel(delta: number): boolean {
        if (!this.capture.isArmed || this.capture.currentShape !== 'Polyline') return false;
        this.capture.adjustFrontage(delta > 0 ? 32 : -32);
        this.renderPreview();
        return true;
    }

    /** Enter / double-click equivalent — finishes a click-chained Polygon
     *  or Polyline early (without closing on vertex 0). Returns true if it
     *  completed and committed. */
    finish(): boolean {
        if (!this.capture.isArmed) return false;
        if (this.capture.finish()) { this.commit(); return true; }
        return false;
    }

    private commit(): void {
        const result = this.capture.takeResult();
        const directive = this.armedDirective;
        this.armedDirective = null;
        this.clearPreview();
        this.opts.onArmedChanged?.(false);
        if (!result || !directive) {
            this.opts.onResult?.({ committed: false, directiveId: 0 });
            return;
        }
        if (directive.captureOnly) {
            // The caller (e.g. the command composer's map-arm target slot)
            // wants the drawn geometry, not a directive — nothing is sent.
            this.opts.onResult?.({ committed: true, directiveId: 0, shape: result.shape, params: result.params });
            return;
        }
        this.connection.sendGroupDirective(
            0, directive.groupId, directive.directiveType, SHAPE_TO_ENUM[result.shape], result.params,
            { priority: directive.priority, requestedStrength: directive.requestedStrength },
        );
        // The server assigns the real directiveId; the client learns it from
        // the next DirectiveState push (create is fire-and-forget, matching
        // sendPlayerCommand's un-acked semantics elsewhere in this file).
        this.opts.onResult?.({ committed: true, directiveId: 0 });
    }

    // ---- Preview rendering (world-anchored GL stays in the worker per
    // PLAN-native-ui.md's "screen-space UI → DOM, world-anchored → GL" rule —
    // this is not a widget concern even once the org panel's DOM half lands) ----

    private renderPreview(): void {
        this.clearPreview();
        if (!this.capture.isArmed) return;
        const mat = this.previewMaterial();
        if (this.capture.currentShape === 'Circle') {
            const c = this.capture.previewCircle;
            if (c) this.previewMeshes.push(this.makeRing(c.center[0], c.center[1], c.center[2], c.radius, mat));
            return;
        }
        const verts = this.capture.previewVertices;
        if (verts.length >= 2) {
            const closed = this.capture.currentShape === 'Polygon' && verts.length >= 3;
            const flat: number[] = [];
            for (const v of verts) flat.push(v[0], v[1] + 3, v[2]);
            if (closed) flat.push(verts[0][0], verts[0][1] + 3, verts[0][2]);
            const line = this.makeLine(flat);
            if (line) this.previewMeshes.push(line);
        }
        for (const v of verts) this.previewMeshes.push(this.makeVertexDot(v[0], v[1], v[2], mat));
    }

    private previewMaterial(): StandardMaterial {
        if (this.previewMat) return this.previewMat;
        const mat = new StandardMaterial('directive-capture-preview-mat', this.scene);
        mat.diffuseColor = new Color3(0, 0, 0);
        mat.emissiveColor = PREVIEW_COLOR;
        mat.specularColor = new Color3(0, 0, 0);
        mat.disableLighting = true;
        mat.alpha = 0.85;
        mat.disableDepthWrite = true;
        mat.depthFunction = DEPTH_ALWAYS;
        this.previewMat = mat;
        return mat;
    }

    private makeRing(x: number, y: number, z: number, radius: number, mat: StandardMaterial): Mesh {
        const tess = Math.max(24, Math.min(96, Math.floor(radius / 24)));
        const thickness = Math.max(2, radius * 0.012);
        const ring = MeshBuilder.CreateTorus('directive-capture-ring',
            { diameter: radius * 2, thickness, tessellation: tess }, this.scene);
        ring.scaling.y = 0.15;
        ring.position.set(x, y + 2, z);
        ring.material = mat;
        ring.isPickable = false;
        ring.renderingGroupId = 3;
        return ring;
    }

    private makeLine(flatPoints: number[]): Mesh | null {
        if (flatPoints.length < 6) return null;
        try {
            const mesh = CreateGreasedLine('directive-capture-line', {
                points: flatPoints, updatable: false,
            }, {
                width: PREVIEW_LINE_WIDTH,
                color: PREVIEW_COLOR,
                colorMode: GreasedLineMeshColorMode.COLOR_MODE_SET,
                materialType: GreasedLineMeshMaterialType.MATERIAL_TYPE_SIMPLE,
                sizeAttenuation: true,
            }, this.scene);
            mesh.renderingGroupId = 3;
            mesh.isPickable = false;
            const lineMat = mesh.material as StandardMaterial | null;
            if (lineMat) { lineMat.disableDepthWrite = true; lineMat.depthFunction = DEPTH_ALWAYS; lineMat.alpha = 0.85; }
            return mesh;
        } catch (err) {
            console.warn('[directive-capture] preview line build failed', err);
            return null;
        }
    }

    private makeVertexDot(x: number, y: number, z: number, mat: StandardMaterial): Mesh {
        const dot = MeshBuilder.CreateSphere('directive-capture-vertex',
            { diameter: VERTEX_DOT_SIZE }, this.scene);
        dot.position.set(x, y + 3, z);
        dot.material = mat;
        dot.isPickable = false;
        dot.renderingGroupId = 3;
        return dot;
    }

    private clearPreview(): void {
        for (const m of this.previewMeshes) m.dispose();
        this.previewMeshes = [];
    }

    dispose(): void {
        this.cancel();
        this.previewMat?.dispose();
        this.previewMat = null;
    }
}
