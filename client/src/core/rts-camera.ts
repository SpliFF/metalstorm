/**
 * RTSCamera — top-down tactical camera controls.
 *
 * Handles:
 *   - Arrow keys              → pan on the XZ plane (Spring/ZK default;
 *                                WASD is reserved for unit orders, not
 *                                camera pan, to match `uikeys.txt`)
 *   - Mouse wheel             → zoom (changes camera height and target distance)
 *   - Edge-scrolling          → pan when the mouse nears a screen edge
 *   - Middle-mouse + drag     → pan the camera on the XZ plane (matches
 *                                Recoil's Spring/TA camera default — drag
 *                                world stays glued to the cursor)
 *   - Right-mouse + drag      → orbit around the *ground point under the
 *                               cursor at drag start*. A right-click without
 *                               drag falls through to onRightClickCommit so
 *                               InputManager can issue an order.
 *
 * The camera keeps a fixed look-at target on the Y=0 plane. Pan moves both
 * the camera and look-at together; yaw/tilt rotate the camera around the
 * look-at; zoom eases the camera's distance to the look-at without moving
 * the look-at itself. It does NOT use Babylon's built-in FreeCamera input
 * system.
 */

import { FreeCamera, Vector3, Quaternion } from '@babylonjs/core';

/** Pending animated camera transition. */
interface CameraTransition {
    startPos: Vector3;
    endPos: Vector3;
    startLookAt: Vector3;
    endLookAt: Vector3;
    durationMs: number;
    elapsed: number;
}

export interface RTSCameraConfig {
    /** Minimum height above ground (elmos). */
    minHeight?: number;
    /** Maximum height above ground (elmos). */
    maxHeight?: number;
    /** Pan speed in elmos per second at height = 1000. */
    panSpeed?: number;
    /** Zoom step as a fraction of height per wheel tick (e.g. 0.15 = 15%). */
    zoomStep?: number;
    /** Edge-scroll threshold in pixels. 0 to disable. */
    edgeScrollPixels?: number;
    /** Radians of yaw / tilt per pixel of right-mouse drag. */
    orbitSpeed?: number;
    /** Vertical clearance kept between the camera and the underlying
     *  ground or water surface. Defaults to 20 elmos. */
    terrainClearance?: number;
}

/** Shorthand for the world-space (x, y, z) triple shared by every
 *  camera-pose entry-point. Accepts the Babylon Vector3 type structurally. */
export interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

/** Full camera pose — camera position + look-at point. Returned by
 *  getPose() / consumed by setPose(). Mirrors the saveView/restoreView
 *  shape (which is kept as a backwards-compatible alias). */
export interface CameraPose {
    pos: { x: number; y: number; z: number };
    lookAt: { x: number; y: number; z: number };
}

export class RTSCamera {
    private camera: FreeCamera;
    // GW4-c5b: RTSCamera runs INSIDE the game-processor worker — it owns no DOM
    // element. The thin main-thread `CameraInput` (camera-input.ts) captures the
    // raw DOM events on `#game-canvas` and forwards canvas-relative CSS-pixel
    // intents (pointer/wheel/key) here via the input methods below. We keep the
    // canvas *size* (CSS pixels) + device-pixel-ratio so the camera math (edge
    // scroll, drag-pan span) and `scene.pick` (which wants backing-store pixels =
    // CSS×dpr) both have what they need without a DOM canvas.
    private canvasW: number;
    private canvasH: number;
    private dpr: number;
    private minHeight: number;
    private maxHeight: number;
    private panSpeed: number;
    private zoomStep: number;
    private edgeScrollPixels: number;
    private orbitSpeed: number;

    private keys = new Set<string>();
    private mouseX = 0;
    private mouseY = 0;
    private mouseInCanvas = false;
    private lastTickTime = performance.now();
    private disposed = false;

    // Middle-mouse pan state. Last drag position is in client-space
    // (window pixels, not canvas-relative) because we attach the move/up
    // listeners to `window` for the duration of the drag so the pan
    // keeps tracking even if the cursor leaves the canvas. The camera
    // pans at a rate scaled by current height so the world point under
    // the cursor stays roughly glued to it as you drag — Recoil's
    // Spring/TA camera default behaviour.
    private middleDragging = false;
    private middleLastX = 0;
    private middleLastY = 0;

    // Right-mouse orbit state. Pivot is the ground point under the cursor
    // at mousedown — it stays fixed in world space for the entire drag.
    // The drag is a click until we cross rightDragThresholdPx; that lets
    // a right-tap fall through as an order via onRightClickCommit.
    private rightDragging = false;
    private rightLastX = 0;
    private rightLastY = 0;
    private rightStartX = 0;
    private rightStartY = 0;
    private rightStartShift = false;
    private rightStartCtrl = false;
    private rightStartAlt = false;
    private rightCrossedThreshold = false;
    private rightPivot = new Vector3();
    private readonly rightDragThresholdPx = 4;
    /// Optional UI hover probe — when set and returning true at right-down
    /// time, the right-click is left to the UI and no drag/order fires. In the
    /// worker this is wired to the LuaUI `IsAbove` check (GW4-c6); until then it
    /// defaults false (no widgets drawn yet).
    private isOverUI: () => boolean = () => false;
    /// Fired on right-click WITHOUT drag, after pointer up. The worker wires this
    /// to its pick→order handler. `x`/`y` are canvas-relative CSS px (top-left).
    onRightClickCommit?: (x: number, y: number,
        mods: { shift: boolean; ctrl: boolean; alt: boolean }) => void;
    // Pitch is clamped so the camera never flattens past horizontal
    // (looking sideways is useless for an RTS) or tips right over the
    // top (which flips the view upside-down).
    private readonly minPitchRad = 10 * Math.PI / 180;
    private readonly maxPitchRad = 89 * Math.PI / 180;

    // Target camera-to-target distance. tick() eases the actual distance
    // toward this value for smooth zoom. Populated lazily on the first
    // wheel event so the initial distance comes from the Babylon camera.
    private targetDistance = -1;
    // Fraction of the gap to close per second. 0 = no smoothing (snap),
    // ~12 = roughly 5 frames to settle at 60fps.
    private zoomSmoothing = 12;

    // Active animated transition (null when idle).
    private transition: CameraTransition | null = null;

    // Forward and right vectors projected onto the XZ plane.
    // Computed from the current camera look direction.
    private forward = new Vector3(0, 0, 1);
    private right = new Vector3(1, 0, 0);

    // Explicit look-at point. Babylon's FreeCamera.getTarget() returns a
    // unit-distance point computed from rotation, which drifts when we move
    // the camera — so we keep our own copy to make zoom maths stable.
    private lookAt = new Vector3(0, 0, 0);

    // Ground-height sampler — set by host (main.ts wires
    // entityRenderer.getGroundHeight). Used by `clampAboveGround` so the
    // camera (and animated transitions) never pierce terrain or dive
    // below sea level. Optional; clamp is a no-op when unset.
    private groundSampler: ((x: number, z: number) => number) | null = null;

    /// Vertical buffer kept above the higher of ground and water (Y=0).
    private terrainClearance: number;

    /// Map size used by `fitMap()`. Populated when host calls
    /// `setMapBounds(width, height)`; falls back to a generous 8 km² when
    /// unset so `fitMap` still produces something usable.
    private mapWidth = 8192;
    private mapHeight = 8192;

    /// Numbered saved-view slots (Spring's F2..F6 + Shift+F2..F6 idiom).
    /// Slot 0 is the special "previous view" jump that pairs naturally
    /// with `loadSlot`. Stored as plain pose-records so callers can
    /// serialise the table.
    private savedSlots = new Map<number, CameraPose>();

    // ─── Input intents (GW4-c5b) ────────────────────────────────────────────
    //
    // These replace the old DOM event handlers. The main-thread `CameraInput`
    // owns the listeners + pointer capture and forwards canvas-relative CSS-pixel
    // coordinates (origin top-left, y-down — Babylon's native screen space) plus
    // a `buttons` bitmask. `mods` is 1=shift 2=ctrl 4=alt 8=meta. Drag state
    // (middle-pan / right-orbit) is tracked here off the pointer stream because
    // capture lives on main, so move/up keep arriving even off-canvas.

    /** Update the cached viewport size (CSS px) + device-pixel-ratio. Call on
     *  init and on every resize so edge-scroll, drag-pan and pick stay correct. */
    setViewportSize(width: number, height: number, dpr: number): void {
        if (width > 0) this.canvasW = width;
        if (height > 0) this.canvasH = height;
        if (dpr > 0) this.dpr = dpr;
    }

    /** Key down. `code` is a lowercased KeyboardEvent.code (e.g. 'arrowup'). */
    keyDown(code: string): void {
        this.keys.add(code);
    }

    keyUp(code: string): void {
        this.keys.delete(code);
    }

    /** Focus loss — drop all held keys + cancel any active drag so the camera
     *  doesn't keep panning after the tab/window loses focus. Also clears the
     *  in-canvas flag: a blur with the cursor parked over an edge would
     *  otherwise leave edge-scroll running forever. */
    blur(): void {
        this.keys.clear();
        this.middleDragging = false;
        this.rightDragging = false;
        this.mouseInCanvas = false;
    }

    /** Pointer left the canvas/window. Stops edge-scroll: without this the last
     *  in-bounds pointermove (typically right at an edge) leaves `mouseInCanvas`
     *  true with no further events to clear it, so the camera edge-scrolls into
     *  the void. An active middle/right drag keeps tracking via pointer capture,
     *  so we only gate edge-scroll here and leave drag state untouched. */
    pointerLeave(): void {
        this.mouseInCanvas = false;
    }

    /** Mouse wheel. `delta` is the raw WheelEvent.deltaY. */
    wheel(_x: number, _y: number, delta: number): void {
        // User scroll cancels any animated transition
        this.transition = null;
        // Initialise targetDistance on first wheel event from the actual
        // camera position, so we pick up wherever the camera currently is.
        if (this.targetDistance < 0) {
            this.targetDistance = Vector3.Distance(this.lookAt, this.camera.position);
        }
        // Normalise deltaY across browsers/devices: macOS trackpad gives
        // small per-event deltas, mouse wheels give larger ones. Clamp so
        // a single notch never moves the target by more than one step.
        const norm = Math.max(-1, Math.min(1, delta / 100));
        const factor = Math.pow(1 + this.zoomStep, norm);
        this.targetDistance *= factor;
        this.targetDistance = this.clampDistance(this.targetDistance);
    }

    /** Pointer move. `x`/`y` are canvas-relative CSS px; `buttons` is the live
     *  button bitmask (1=left, 2=right, 4=middle — DOM PointerEvent.buttons). */
    pointerMove(x: number, y: number, _buttons: number): void {
        this.mouseX = x;
        this.mouseY = y;
        this.mouseInCanvas = x >= 0 && x < this.canvasW && y >= 0 && y < this.canvasH;

        if (this.middleDragging) {
            const dx = x - this.middleLastX;
            const dy = y - this.middleLastY;
            this.middleLastX = x;
            this.middleLastY = y;
            if (dx !== 0 || dy !== 0) this.middleDragPanBy(dx, dy);
        }
        if (this.rightDragging) {
            if (!this.rightCrossedThreshold) {
                const tx = x - this.rightStartX;
                const ty = y - this.rightStartY;
                if (Math.hypot(tx, ty) < this.rightDragThresholdPx) return;
                this.rightCrossedThreshold = true;
                this.transition = null;
            }
            const dx = x - this.rightLastX;
            const dy = y - this.rightLastY;
            this.rightLastX = x;
            this.rightLastY = y;
            if (dx !== 0 || dy !== 0) this.orbitAroundPivot(this.rightPivot, dx, dy);
        }
    }

    /** Pointer down. `button` is 0=left 1=middle 2=right (DOM convention). */
    pointerDown(x: number, y: number, button: number, mods: number): void {
        if (button === 1) {
            // Middle button → pan drag.
            this.middleDragging = true;
            this.middleLastX = x;
            this.middleLastY = y;
        } else if (button === 2) {
            // Right button → ground-pivoted orbit (or a fall-through order on a
            // click without drag). Leave it to the UI when over a widget.
            if (this.isOverUI()) return;
            this.rightDragging = true;
            this.rightCrossedThreshold = false;
            this.rightStartX = x;
            this.rightStartY = y;
            this.rightLastX = x;
            this.rightLastY = y;
            this.rightStartShift = (mods & 1) !== 0;
            this.rightStartCtrl = (mods & 2) !== 0;
            this.rightStartAlt = (mods & 4) !== 0;
            const ground = this.pickGroundAt(x, y);
            this.rightPivot.copyFrom(ground ?? this.lookAt);
        }
    }

    /** Pointer up. Mirrors `pointerDown`'s button codes. */
    pointerUp(x: number, y: number, button: number, _mods: number): void {
        if (button === 1) {
            this.middleDragging = false;
        } else if (button === 2) {
            const wasClick = this.rightDragging && !this.rightCrossedThreshold;
            this.rightDragging = false;
            if (wasClick) {
                this.onRightClickCommit?.(x, y, {
                    shift: this.rightStartShift,
                    ctrl: this.rightStartCtrl,
                    alt: this.rightStartAlt,
                });
            }
        }
    }

    /** Translate the camera so the world point under the cursor follows
     *  the cursor 1:1 — i.e. dragging the mouse right scrolls the world
     *  right, dragging down scrolls the world down. The conversion from
     *  screen pixels to world elmos uses the camera's vertical FOV and
     *  current height so the gluing is roughly correct at any zoom. */
    private middleDragPanBy(dxPx: number, dyPx: number): void {
        const h = this.canvasH || 1;
        // World-elmos per screen pixel at the look-at depth.
        // 2 * height * tan(fov/2) covers the visible vertical span at
        // ground level for a near-vertical overhead camera; spreading
        // that across `h` pixels gives elmos-per-pixel.
        const fov = this.camera.fov; // radians
        const verticalSpan = 2.0 * Math.max(50, this.camera.position.y) * Math.tan(fov * 0.5);
        const elmoPerPx = verticalSpan / h;

        // Negate so the world drags with the cursor (camera moves the
        // opposite direction of the cursor delta).
        const sx = -dxPx * elmoPerPx;
        const sy = -dyPx * elmoPerPx;

        const dx = this.right.x * sx + this.forward.x * sy;
        const dz = this.right.z * sx + this.forward.z * sy;
        this.panBy(dx, dz);
    }

    /// Ray-pick the visible terrain mesh under a canvas-relative CSS-pixel point.
    /// `scene.pick` works in backing-store pixels (= CSS × dpr), so we scale up.
    private pickGroundAt(cssX: number, cssY: number): Vector3 | null {
        const scene = this.camera.getScene();
        const pick = scene.pick(cssX * this.dpr, cssY * this.dpr,
            (m) => m.name === 'terrain', false, this.camera);
        return (pick?.hit && pick.pickedPoint) ? pick.pickedPoint : null;
    }

    constructor(camera: FreeCamera, width: number, height: number, dpr: number,
                config: RTSCameraConfig = {}) {
        this.camera = camera;
        this.canvasW = Math.max(1, width);
        this.canvasH = Math.max(1, height);
        this.dpr = dpr > 0 ? dpr : 1;
        this.minHeight = config.minHeight ?? 100;
        this.maxHeight = config.maxHeight ?? 5000;
        this.panSpeed = config.panSpeed ?? 800;
        this.zoomStep = config.zoomStep ?? 0.15;
        this.edgeScrollPixels = config.edgeScrollPixels ?? 8;
        // 0.006 rad/px ≈ a full 360° sweep after dragging ~1050 px, which
        // feels roughly right for a 1080p-ish canvas.
        this.orbitSpeed = config.orbitSpeed ?? 0.006;
        this.terrainClearance = config.terrainClearance ?? 20;

        // Detach Babylon's default input so it doesn't fight our intents
        camera.detachControl();

        // Seed our look-at point from the camera's current direction,
        // projected onto the Y = 0 plane (so we're looking at the ground).
        this.lookAt.copyFrom(this.computeGroundLookAt());
        this.camera.setTarget(this.lookAt);
        this.updateAxes();
        // No DOM listeners here — input arrives via the intent methods above,
        // forwarded by the main-thread CameraInput (GW4-c5b).
    }

    /** Set the UI hover probe — used by right-click handling so a click
     *  on a chili control falls through to the widget instead of starting
     *  a camera rotation. Wired to LuaUI IsAbove in the worker (GW4-c6). */
    setUIHitTest(probe: () => boolean): void {
        this.isOverUI = probe;
    }

    /**
     * Update the camera each frame. Call this from the render loop with
     * the current scene.
     */
    tick(): void {
        if (this.disposed) return;
        const now = performance.now();
        const dt = Math.min((now - this.lastTickTime) / 1000, 0.1);
        this.lastTickTime = now;

        // If an animated transition is active, advance it and skip
        // normal input processing.
        if (this.transition) {
            this.tickTransition(dt);
            return;
        }

        // Pan speed scales with camera height so zoomed-out is faster
        const heightFactor = Math.max(0.3, this.camera.position.y / 1000);
        const distance = this.panSpeed * heightFactor * dt;

        let moveX = 0, moveZ = 0;
        // Arrow keys only — Spring/ZK reserve WASD for unit orders.
        if (this.keys.has('arrowup'))    moveZ += 1;
        if (this.keys.has('arrowdown'))  moveZ -= 1;
        if (this.keys.has('arrowleft'))  moveX -= 1;
        if (this.keys.has('arrowright')) moveX += 1;

        // Edge scrolling
        if (this.edgeScrollPixels > 0 && this.mouseInCanvas) {
            const w = this.canvasW;
            const h = this.canvasH;
            const t = this.edgeScrollPixels;
            if (this.mouseX < t)       moveX -= 1;
            else if (this.mouseX > w - t) moveX += 1;
            if (this.mouseY < t)       moveZ += 1;
            else if (this.mouseY > h - t) moveZ -= 1;
        }

        if (moveX !== 0 || moveZ !== 0) {
            // Normalise diagonal movement
            const len = Math.hypot(moveX, moveZ);
            moveX /= len;
            moveZ /= len;

            const dx = this.right.x * moveX * distance + this.forward.x * moveZ * distance;
            const dz = this.right.z * moveX * distance + this.forward.z * moveZ * distance;
            this.panBy(dx, dz);
        }

        this.applyZoomSmoothing(dt);

        // Terrain protection: lift the camera if it ended up below the
        // ground or under sea level after any of the above (pan / zoom /
        // edge-scroll). Runs every tick whether the user provided input
        // or not so the camera self-rights when the terrain rises beneath
        // it during animated transitions or external pose changes.
        this.clampAboveGround();

        // Keep the focus point on (or just past) the map. Belt-and-braces with
        // the edge-scroll gating: even if some path runs the camera off the
        // map, this rubber-bands the look-at back to within `edgePanMargin` of
        // the playable area so we can never end up staring into the void.
        this.clampToBounds();
    }

    /**
     * Clamp the ground focus point (`lookAt`) to the map extent plus a small
     * margin, carrying the camera by the same XZ delta so the view offset is
     * preserved. The margin lets you nudge slightly past an edge to centre a
     * corner unit, without allowing an unbounded run-off.
     */
    private clampToBounds(): void {
        // 10% of the shorter map axis, floored so tiny maps still get slack.
        const margin = Math.max(512, Math.min(this.mapWidth, this.mapHeight) * 0.1);
        const cx = Math.max(-margin, Math.min(this.mapWidth + margin, this.lookAt.x));
        const cz = Math.max(-margin, Math.min(this.mapHeight + margin, this.lookAt.z));
        const dx = cx - this.lookAt.x;
        const dz = cz - this.lookAt.z;
        if (dx === 0 && dz === 0) return;
        this.lookAt.x = cx;
        this.lookAt.z = cz;
        this.camera.position.x += dx;
        this.camera.position.z += dz;
        this.camera.setTarget(this.lookAt);
    }

    /**
     * Exponentially ease the actual camera distance toward targetDistance.
     * Uses framerate-independent smoothing: per-step factor = 1 - exp(-k*dt).
     */
    private applyZoomSmoothing(dt: number): void {
        if (this.targetDistance < 0) return;
        const dx = this.camera.position.x - this.lookAt.x;
        const dy = this.camera.position.y - this.lookAt.y;
        const dz = this.camera.position.z - this.lookAt.z;
        const actual = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (actual < 0.0001) return;
        const diff = this.targetDistance - actual;

        // Snap-to-target dead-zone so we don't drift indefinitely.
        if (Math.abs(diff) < 1.0) {
            const scale = this.targetDistance / actual;
            this.camera.position.x = this.lookAt.x + dx * scale;
            this.camera.position.y = this.lookAt.y + dy * scale;
            this.camera.position.z = this.lookAt.z + dz * scale;
            this.camera.setTarget(this.lookAt);
            return;
        }

        const alpha = 1 - Math.exp(-this.zoomSmoothing * dt);
        const newLen = actual + diff * alpha;
        const scale = newLen / actual;
        this.camera.position.x = this.lookAt.x + dx * scale;
        this.camera.position.y = this.lookAt.y + dy * scale;
        this.camera.position.z = this.lookAt.z + dz * scale;

        // Clamp on camera Y
        if (this.camera.position.y < this.minHeight) {
            // Rescale distance so camera.y == minHeight
            const rescale = (this.lookAt.y + (this.minHeight - this.lookAt.y)) === 0
                ? 1 : (this.minHeight - this.lookAt.y) / dy;
            this.camera.position.x = this.lookAt.x + dx * rescale;
            this.camera.position.y = this.minHeight;
            this.camera.position.z = this.lookAt.z + dz * rescale;
        } else if (this.camera.position.y > this.maxHeight) {
            const rescale = (this.maxHeight - this.lookAt.y) / dy;
            this.camera.position.x = this.lookAt.x + dx * rescale;
            this.camera.position.y = this.maxHeight;
            this.camera.position.z = this.lookAt.z + dz * rescale;
        }

        this.camera.setTarget(this.lookAt);
    }

    /**
     * Clamp a target distance so the resulting camera Y stays within
     * [minHeight, maxHeight]. Because the look vector's Y component is
     * constant along the zoom axis, distance ↔ height scales linearly.
     */
    private clampDistance(distance: number): number {
        const dx = this.camera.position.x - this.lookAt.x;
        const dy = this.camera.position.y - this.lookAt.y;
        const dz = this.camera.position.z - this.lookAt.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 0.0001 || Math.abs(dy) < 0.0001) return distance;
        // Camera height at distance d = lookAt.y + (dy / len) * d
        // Solve for d given camera.y == minHeight or maxHeight
        const ratio = dy / len; // +ve if camera is above lookAt
        const minDist = (this.minHeight - this.lookAt.y) / ratio;
        const maxDist = (this.maxHeight - this.lookAt.y) / ratio;
        const lo = Math.min(minDist, maxDist);
        const hi = Math.max(minDist, maxDist);
        return Math.max(lo, Math.min(hi, distance));
    }

    /**
     * Given the camera's current rotation, compute where its forward
     * ray intersects the Y=0 plane. Used to seed our explicit lookAt.
     */
    private computeGroundLookAt(): Vector3 {
        // FreeCamera.getTarget() returns position + direction. Direction
        // is valid, we just don't want unit-distance.
        const t = this.camera.getTarget();
        const dir = t.subtract(this.camera.position);
        if (Math.abs(dir.y) < 0.0001) {
            // Looking horizontally — pick a point 1000 elmos ahead
            return new Vector3(
                this.camera.position.x + dir.x * 1000,
                0,
                this.camera.position.z + dir.z * 1000);
        }
        const tParam = -this.camera.position.y / dir.y;
        return new Vector3(
            this.camera.position.x + dir.x * tParam,
            0,
            this.camera.position.z + dir.z * tParam);
    }

    /** Translate both camera and target by the same XZ delta. */
    private panBy(dx: number, dz: number): void {
        this.camera.position.x += dx;
        this.camera.position.z += dz;
        this.lookAt.x += dx;
        this.lookAt.z += dz;
        this.camera.setTarget(this.lookAt);
    }

    /**
     * Orbit the camera around `lookAt` by mouse-delta pixels:
     *   horizontal drag (dx) → yaw around the world-Y axis
     *   vertical drag (dy)   → tilt by changing the elevation angle
     *
     * The distance from `lookAt` to the camera is preserved, so this
     * doesn't interact with the zoom path. The final height is still
     * clamped by [minHeight, maxHeight] via the pitch limits plus a
     * safety clamp so steep tilts on a distant view don't pop the
     * camera above the max.
     *
     * Drag directions: right = world rotates counter-clockwise under
     * us (the view appears to swing right); down = view tilts
     * further overhead.
     */
    private orbitBy(dx: number, dy: number): void {
        let ox = this.camera.position.x - this.lookAt.x;
        let oy = this.camera.position.y - this.lookAt.y;
        let oz = this.camera.position.z - this.lookAt.z;

        const radius = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (radius < 0.0001) return;

        // ---- Yaw around world Y ----
        // Rotate (ox, oz) by -dx * orbitSpeed. Right-drag (+dx) should
        // feel like "the world turns left under me", which means we
        // rotate the offset clockwise when looking down from +Y.
        const yaw = -dx * this.orbitSpeed;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const rx = ox * cy + oz * sy;
        const rz = -ox * sy + oz * cy;
        ox = rx;
        oz = rz;

        // ---- Tilt (pitch) ----
        // Convert to (horizontalDist, verticalOffset) polar coords
        // around `lookAt` and rotate by -dy * orbitSpeed. Drag up (-dy)
        // lowers pitch → more horizontal view; drag down raises pitch
        // → more overhead view.
        const horiz = Math.sqrt(ox * ox + oz * oz);
        let pitch = Math.atan2(oy, horiz);
        pitch += dy * this.orbitSpeed;
        if (pitch < this.minPitchRad) pitch = this.minPitchRad;
        if (pitch > this.maxPitchRad) pitch = this.maxPitchRad;

        const newHoriz = radius * Math.cos(pitch);
        const newVert  = radius * Math.sin(pitch);

        // Preserve the (already yaw-rotated) horizontal direction.
        if (horiz > 0.0001) {
            const scale = newHoriz / horiz;
            ox *= scale;
            oz *= scale;
        } else {
            // Degenerate case: camera directly above lookAt. Fall back
            // to +Z so we still have a sensible direction.
            ox = 0;
            oz = newHoriz;
        }
        oy = newVert;

        // Clamp absolute camera height — pitch alone isn't enough if
        // the look-at itself is elevated (unlikely, but cheap to guard).
        let cameraY = this.lookAt.y + oy;
        if (cameraY < this.minHeight) {
            oy = this.minHeight - this.lookAt.y;
            cameraY = this.minHeight;
        } else if (cameraY > this.maxHeight) {
            oy = this.maxHeight - this.lookAt.y;
            cameraY = this.maxHeight;
        }

        this.camera.position.x = this.lookAt.x + ox;
        this.camera.position.y = cameraY;
        this.camera.position.z = this.lookAt.z + oz;
        this.camera.setTarget(this.lookAt);

        // WASD uses the projected forward/right axes of the camera, so
        // rotating the view needs to update them or W starts walking
        // the camera sideways relative to where you're looking.
        this.updateAxes();

        // Zoom tracks `targetDistance` independently; a pure orbit
        // shouldn't re-trigger smoothing. Sync it to the new actual
        // distance (unchanged mathematically, but this avoids any drift
        // from the tiny clamp above).
        if (this.targetDistance >= 0) {
            this.targetDistance = Math.sqrt(
                ox * ox + oy * oy + oz * oz);
        }
    }

    /**
     * Orbit the camera AND look-at together around an arbitrary world
     * point. Used for right-mouse drag, where the pivot is the ground
     * point under the cursor at drag-start so that point stays anchored
     * in world space while the view swings around it.
     *
     * Same drag-direction conventions as orbitBy:
     *   horizontal drag (dx) → yaw around world Y through pivot
     *   vertical drag (dy)   → pitch around the horizontal axis (through
     *                          pivot) perpendicular to the post-yaw view
     *                          direction
     *
     * Pitch is clamped to [minPitch, maxPitch] in the lookAt frame, so
     * the view never tips over the top or flattens past horizontal even
     * when the pivot is far from screen centre.
     */
    private orbitAroundPivot(pivot: Vector3, dx: number, dy: number): void {
        const yawAngle = -dx * this.orbitSpeed;

        // ── Yaw: rigid rotation around world Y axis through pivot ──
        const yawQ = Quaternion.RotationAxis(RTSCamera.UP, yawAngle);
        const camTmp = new Vector3();
        const lookTmp = new Vector3();
        this.camera.position.rotateByQuaternionAroundPointToRef(yawQ, pivot, camTmp);
        this.lookAt.rotateByQuaternionAroundPointToRef(yawQ, pivot, lookTmp);

        // ── Pitch: clamp delta against the lookAt-frame pitch ──
        const viewX = lookTmp.x - camTmp.x;
        const viewY = lookTmp.y - camTmp.y;
        const viewZ = lookTmp.z - camTmp.z;
        const viewHoriz = Math.sqrt(viewX * viewX + viewZ * viewZ);

        let camFinal = camTmp;
        let lookFinal = lookTmp;

        if (viewHoriz > 0.0001 && Math.abs(dy) > 0.0001) {
            // pitch = angle of camera above lookAt, same convention as orbitBy
            const camRelY = camTmp.y - lookTmp.y;
            const currentPitch = Math.atan2(camRelY, viewHoriz);
            let newPitch = currentPitch + dy * this.orbitSpeed;
            if (newPitch < this.minPitchRad) newPitch = this.minPitchRad;
            if (newPitch > this.maxPitchRad) newPitch = this.maxPitchRad;
            const pitchDelta = newPitch - currentPitch;

            if (Math.abs(pitchDelta) > 1e-6) {
                // Pitch axis: horizontal vector perpendicular to view's
                // horizontal projection, rotated 90° CCW from above. A
                // positive rotation around this axis tilts the +Y end
                // *toward* the view direction — i.e. lowers the camera
                // toward the horizontal — so we negate to match the
                // "drag down → more overhead" convention.
                const ax = -viewZ / viewHoriz;
                const az = viewX / viewHoriz;
                const pitchAxis = new Vector3(ax, 0, az);
                const pitchQ = Quaternion.RotationAxis(pitchAxis, -pitchDelta);
                const camTmp2 = new Vector3();
                const lookTmp2 = new Vector3();
                camTmp.rotateByQuaternionAroundPointToRef(pitchQ, pivot, camTmp2);
                lookTmp.rotateByQuaternionAroundPointToRef(pitchQ, pivot, lookTmp2);
                camFinal = camTmp2;
                lookFinal = lookTmp2;
            }
        }

        // Defensive height clamp — pitch clamping handles the usual case,
        // but if the pivot is elevated (or in the future, when lookAt
        // isn't on Y=0), the camera could still pop out of bounds.
        let cy = camFinal.y;
        if (cy < this.minHeight) cy = this.minHeight;
        else if (cy > this.maxHeight) cy = this.maxHeight;

        this.camera.position.set(camFinal.x, cy, camFinal.z);
        this.lookAt.copyFrom(lookFinal);
        this.camera.setTarget(this.lookAt);
        this.updateAxes();

        // Keep targetDistance in sync so a follow-up wheel zoom doesn't
        // snap to a stale value.
        if (this.targetDistance >= 0) {
            const dx2 = this.camera.position.x - this.lookAt.x;
            const dy2 = this.camera.position.y - this.lookAt.y;
            const dz2 = this.camera.position.z - this.lookAt.z;
            this.targetDistance = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
        }
    }

    private static readonly UP = new Vector3(0, 1, 0);

    /**
     * Called when the camera is repositioned externally (e.g. when MapData
     * arrives and we centre on the map). Re-seeds the explicit look-at
     * point from the camera's current rotation and recomputes axes.
     */
    recomputeAxes(): void {
        this.lookAt.copyFrom(this.computeGroundLookAt());
        this.camera.setTarget(this.lookAt);
        // Reset target distance so the first wheel event will pick up
        // the new camera-to-lookAt distance.
        this.targetDistance = -1;
        this.updateAxes();
    }

    private updateAxes(): void {
        // Forward = camera's look direction projected onto XZ plane
        const lx = this.lookAt.x - this.camera.position.x;
        const lz = this.lookAt.z - this.camera.position.z;
        const lenSq = lx * lx + lz * lz;
        if (lenSq < 0.0001) {
            this.forward.set(0, 0, 1);
        } else {
            const len = Math.sqrt(lenSq);
            this.forward.set(lx / len, 0, lz / len);
        }
        // Right = forward × up. Under the RH scene (Phase 2d) this is
        // (-fz, 0, fx); the pre-Phase-2 LH form (fz, 0, -fx) inverted
        // horizontal pan on arrow keys, middle-drag, and edge-scroll.
        this.right.set(-this.forward.z, 0, this.forward.x);
    }

    /**
     * Move the camera to focus on a world XZ position.
     * @param x World X coordinate
     * @param z World Z coordinate
     * @param durationMs If 0 or omitted, teleport instantly. Otherwise
     *   animate over this many milliseconds using ease-in-out.
     */
    focusOn(x: number, z: number, durationMs = 0): void {
        if (durationMs <= 0) {
            this.transition = null;
            const dx = x - this.lookAt.x;
            const dz = z - this.lookAt.z;
            this.panBy(dx, dz);
            return;
        }
        // Animate: keep same relative offset between camera and lookAt
        const endLookAt = new Vector3(x, 0, z);
        const offset = this.camera.position.subtract(this.lookAt);
        const endPos = endLookAt.add(offset);
        this.startTransition(endPos, endLookAt, durationMs);
    }

    /**
     * Move the camera to look at an arbitrary 3D position, keeping the
     * current distance from the target.
     * @param x World X
     * @param y World Y (height)
     * @param z World Z
     * @param durationMs Animation time. 0 = instant.
     */
    lookAtPosition(x: number, y: number, z: number, durationMs = 0): void {
        const target = new Vector3(x, y, z);
        const currentDist = Vector3.Distance(this.camera.position, this.lookAt);
        // Compute the new camera position by maintaining the same offset
        // direction from camera to lookAt, scaled to the same distance.
        const dir = this.camera.position.subtract(this.lookAt).normalize();
        const endPos = target.add(dir.scale(currentDist));
        const endLookAt = target.clone();
        if (durationMs <= 0) {
            this.transition = null;
            this.camera.position.copyFrom(endPos);
            this.lookAt.copyFrom(endLookAt);
            this.camera.setTarget(this.lookAt);
            this.targetDistance = -1;
            this.updateAxes();
            return;
        }
        this.startTransition(endPos, endLookAt, durationMs);
    }

    /**
     * Save the current camera view (position + look-at).
     * Returns an opaque state object that can be passed to restoreView().
     */
    saveView(): { pos: Vector3; lookAt: Vector3 } {
        return {
            pos: this.camera.position.clone(),
            lookAt: this.lookAt.clone(),
        };
    }

    /**
     * Restore a previously saved camera view.
     * @param view The object returned from saveView()
     * @param durationMs Animation time. 0 = instant.
     */
    restoreView(view: { pos: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } }, durationMs = 0): void {
        const endPos = new Vector3(view.pos.x, view.pos.y, view.pos.z);
        const endLookAt = new Vector3(view.lookAt.x, view.lookAt.y, view.lookAt.z);
        if (durationMs <= 0) {
            this.transition = null;
            this.camera.position.copyFrom(endPos);
            this.lookAt.copyFrom(endLookAt);
            this.camera.setTarget(this.lookAt);
            this.targetDistance = -1;
            this.updateAxes();
            return;
        }
        this.startTransition(endPos, endLookAt, durationMs);
    }

    // ─── Pose primitives (programmatic API) ─────────────────────────────
    //
    // The methods below are the canonical entry points for scripted
    // camera control: tests, debug consoles, MCP tooling and Lua widgets
    // all route through them. They map onto the existing transition
    // machinery so animation is uniform across every entry-point.

    /** Read the current pose as a plain object. Pairs with `setPose`. */
    getPose(): CameraPose {
        return {
            pos: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
            lookAt: { x: this.lookAt.x, y: this.lookAt.y, z: this.lookAt.z },
        };
    }

    /** Set both camera position and look-at in one call. Equivalent to
     *  `restoreView` but takes raw coordinates so callers don't have to
     *  construct an opaque view object first. */
    setPose(pose: CameraPose, durationMs = 0): void {
        this.restoreView(pose, durationMs);
    }

    /** Look at a ground point, sampling the height when one isn't
     *  supplied. `opts.height` is the camera Y offset above the target;
     *  defaults to keeping the current camera-to-target Y delta. */
    snapToGround(x: number, z: number, opts: {
        height?: number;
        pitchDeg?: number;
        durationMs?: number;
    } = {}): void {
        const groundY = this.groundSampler ? Math.max(0, this.groundSampler(x, z)) : 0;
        const targetY = groundY;
        const wantedHeight = opts.height ?? (this.camera.position.y - this.lookAt.y);
        const lookAt = { x, y: targetY, z };
        const camPos = opts.pitchDeg !== undefined
            ? this.cameraPosFromOrbit(lookAt, this.currentYawDeg(), opts.pitchDeg,
                                      Math.max(this.minHeight, wantedHeight))
            : { x, y: targetY + wantedHeight, z };
        this.setPose({ pos: camPos, lookAt }, opts.durationMs ?? 0);
    }

    /** Look at an arbitrary 3D point. Mirrors `lookAtPosition` but in the
     *  same `{x,y,z}` style as the rest of the new API. */
    pointAt(p: Vec3Like, durationMs = 0): void {
        this.lookAtPosition(p.x, p.y, p.z, durationMs);
    }

    /** Move the camera to an absolute world position; the look-at follows
     *  by the same delta so the view direction is preserved. */
    moveTo(p: Vec3Like, durationMs = 0): void {
        const dx = p.x - this.camera.position.x;
        const dy = p.y - this.camera.position.y;
        const dz = p.z - this.camera.position.z;
        this.moveBy({ x: dx, y: dy, z: dz }, durationMs);
    }

    /** Translate the camera (and its look-at) by `(dx, dy, dz)`. */
    moveBy(delta: Vec3Like, durationMs = 0): void {
        const pos = {
            x: this.camera.position.x + delta.x,
            y: this.camera.position.y + delta.y,
            z: this.camera.position.z + delta.z,
        };
        const lookAt = {
            x: this.lookAt.x + delta.x,
            y: this.lookAt.y + delta.y,
            z: this.lookAt.z + delta.z,
        };
        this.setPose({ pos, lookAt }, durationMs);
    }

    /** Orbit the camera around its current look-at, optionally also
     *  changing the orbit distance. */
    orbit(opts: {
        yawDeg?: number;
        pitchDeg?: number;
        distance?: number;
        durationMs?: number;
    } = {}): void {
        if (opts.distance !== undefined) {
            this.targetDistance = this.clampDistance(opts.distance);
        }
        if (opts.yawDeg !== undefined || opts.pitchDeg !== undefined) {
            this.rotateAroundTarget(opts.yawDeg ?? 0, opts.pitchDeg ?? 0,
                                    opts.durationMs ?? 0);
        }
    }

    /** Set the camera's heading (yaw) to face the given world direction.
     *  Heading is degrees clockwise from +Z (Spring's convention). */
    setHeading(yawDeg: number, durationMs = 0): void {
        const delta = yawDeg - this.currentYawDeg();
        // Wrap into (-180, 180] so we always take the short rotation.
        const wrapped = ((delta + 540) % 360) - 180;
        this.rotateAroundTarget(wrapped, 0, durationMs);
    }

    /** Set the camera's pitch (angle below horizontal looking down). */
    setPitch(pitchDeg: number, durationMs = 0): void {
        const delta = pitchDeg - this.currentPitchDeg();
        this.rotateAroundTarget(0, delta, durationMs);
    }

    /** Set the camera-to-target distance. Eases over time when a duration
     *  is supplied; instant otherwise. */
    setDistance(distance: number, durationMs = 0): void {
        const d = this.clampDistance(distance);
        if (durationMs <= 0) {
            const offset = this.camera.position.subtract(this.lookAt);
            const len = offset.length();
            if (len < 1e-4) return;
            offset.scaleInPlace(d / len);
            const endPos = this.lookAt.add(offset);
            this.camera.position.copyFrom(endPos);
            this.camera.setTarget(this.lookAt);
            this.targetDistance = d;
            this.updateAxes();
            return;
        }
        // Reuse transition: compute endPos along current offset direction.
        const offset = this.camera.position.subtract(this.lookAt);
        const len = offset.length();
        if (len < 1e-4) return;
        offset.scaleInPlace(d / len);
        const endPos = this.lookAt.add(offset);
        this.startTransition(endPos, this.lookAt.clone(), durationMs);
    }

    /** Top-down framing of the entire map. The camera is placed directly
     *  above the map centre at a height that puts the whole heightmap
     *  inside the vertical FOV (with `padding` headroom). */
    fitMap(opts: { padding?: number; pitchDeg?: number; durationMs?: number } = {}): void {
        const padding = opts.padding ?? 1.05;
        const pitch = opts.pitchDeg ?? 89;            // near-straight-down
        const fovRad = this.camera.fov || (45 * Math.PI / 180);
        const half = Math.max(this.mapWidth, this.mapHeight) * 0.5 * padding;
        const distance = half / Math.tan(fovRad * 0.5);
        const lookAt = { x: this.mapWidth * 0.5, y: 0, z: this.mapHeight * 0.5 };
        // Place camera at (cx, distance·sin(pitch), cz - distance·cos(pitch))
        // — a slight southward offset so non-90° pitches still frame the
        // map without parallax skew.
        const pr = pitch * Math.PI / 180;
        const pos = {
            x: lookAt.x,
            y: lookAt.y + Math.sin(pr) * distance,
            z: lookAt.z - Math.cos(pr) * distance,
        };
        this.setPose({ pos, lookAt }, opts.durationMs ?? 0);
    }

    /** Frame an arbitrary set of world points so they all fit inside the
     *  vertical FOV. The look-at lands on the centroid; distance is
     *  derived from the bounding-box half-extent + `padding`. `pitchDeg`
     *  controls how steep the view is (lower = more side-on, useful for
     *  watching projectile trajectories). */
    fitPoints(points: Vec3Like[], opts: {
        padding?: number;
        pitchDeg?: number;
        durationMs?: number;
        minDistance?: number;
    } = {}): void {
        if (points.length === 0) return;
        const padding = opts.padding ?? 1.4;
        const pitch = opts.pitchDeg ?? 55;
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        let sumY = 0;
        for (const p of points) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
            sumY += p.y ?? 0;
        }
        const cx = (minX + maxX) * 0.5;
        const cz = (minZ + maxZ) * 0.5;
        const avgY = sumY / points.length;
        const groundY = this.groundSampler ? Math.max(0, this.groundSampler(cx, cz)) : 0;
        // Use the higher of ground or average y so air engagements aren't
        // framed underground.
        const targetY = Math.max(groundY, avgY);
        // Minimum half-extent so a 1-unit framing doesn't put the camera
        // inside the model.
        const half = Math.max(40, Math.max(maxX - minX, maxZ - minZ) * 0.5) * padding;
        const fovRad = this.camera.fov || (45 * Math.PI / 180);
        const distance = Math.max(opts.minDistance ?? 200, half / Math.tan(fovRad * 0.5));
        const lookAt = { x: cx, y: targetY, z: cz };
        const pr = pitch * Math.PI / 180;
        const pos = {
            x: lookAt.x,
            y: lookAt.y + Math.sin(pr) * distance,
            z: lookAt.z - Math.cos(pr) * distance,
        };
        this.setPose({ pos, lookAt }, opts.durationMs ?? 0);
    }

    /** Save the current pose into a numbered slot. Spring/Recoil binds
     *  Shift+F2..F6 to save, F2..F6 to recall. */
    saveSlot(slot: number): void {
        this.savedSlots.set(slot, this.getPose());
    }

    /** Recall a numbered slot. Returns false when the slot hasn't been
     *  populated yet. */
    loadSlot(slot: number, durationMs = 0): boolean {
        const pose = this.savedSlots.get(slot);
        if (!pose) return false;
        this.setPose(pose, durationMs);
        return true;
    }

    /** Whether a save-slot has a stored pose. */
    hasSlot(slot: number): boolean {
        return this.savedSlots.has(slot);
    }

    /** Wire the heightmap sampler — used by terrain clamping in tick()
     *  and by `snapToGround`. */
    setGroundSampler(fn: (x: number, z: number) => number): void {
        this.groundSampler = fn;
    }

    /** Tell the camera the map's playable extent so `fitMap` can size
     *  itself. Both axes in elmos. */
    setMapBounds(width: number, height: number): void {
        if (width > 0) this.mapWidth = width;
        if (height > 0) this.mapHeight = height;
    }

    // ─── Internals shared by the new API ────────────────────────────────

    /** Lift the camera so it never penetrates terrain or sea level. Sea
     *  level is fixed at Y=0 in Spring; ground comes from `groundSampler`
     *  when wired. No-ops at the configured `terrainClearance` margin so
     *  the lift doesn't fight a deliberate low-altitude pose. */
    private clampAboveGround(): void {
        if (!this.groundSampler) return;
        const cx = this.camera.position.x;
        const cz = this.camera.position.z;
        const ground = this.groundSampler(cx, cz);
        const floor = Math.max(ground, 0) + this.terrainClearance;
        if (this.camera.position.y < floor) {
            this.camera.position.y = floor;
        }
    }

    /** Camera yaw as a Spring-style world heading under RH (PLAN-
     *  coordinate-system Phase 2d): 0° looks toward -Z (glTF forward),
     *  +90° looks toward +X. The `-dz` flip aligns the camera basis
     *  with the RH server convention so `cameraPose().yaw` matches the
     *  unit heading wire field. */
    private currentYawDeg(): number {
        const dx = this.lookAt.x - this.camera.position.x;
        const dz = this.lookAt.z - this.camera.position.z;
        return Math.atan2(dx, -dz) * 180 / Math.PI;
    }

    /** Camera pitch (downward tilt) in degrees. */
    private currentPitchDeg(): number {
        const dy = this.camera.position.y - this.lookAt.y;
        const dx = this.lookAt.x - this.camera.position.x;
        const dz = this.lookAt.z - this.camera.position.z;
        const horiz = Math.sqrt(dx * dx + dz * dz);
        return Math.atan2(dy, horiz) * 180 / Math.PI;
    }

    /** Compute a camera world position from spherical-coords-around-lookAt.
     *  RH inverse of currentYawDeg: at yaw=0 the camera sits at +Z relative
     *  to lookAt (so it looks toward -Z, the RH forward direction). */
    private cameraPosFromOrbit(lookAt: Vec3Like, yawDeg: number, pitchDeg: number,
                                distance: number): { x: number; y: number; z: number } {
        const yaw = yawDeg * Math.PI / 180;
        const pitch = Math.max(this.minPitchRad,
                               Math.min(this.maxPitchRad, pitchDeg * Math.PI / 180));
        const horiz = distance * Math.cos(pitch);
        const vert = distance * Math.sin(pitch);
        return {
            x: lookAt.x - horiz * Math.sin(yaw),
            y: lookAt.y + vert,
            z: lookAt.z + horiz * Math.cos(yaw),
        };
    }

    /**
     * Rotate the camera around the current look-at point.
     * @param yawDeg   Degrees to rotate horizontally (positive = clockwise when viewed from above)
     * @param pitchDeg Degrees to change elevation (positive = steeper / more overhead)
     * @param durationMs Animation time. 0 = instant.
     */
    rotateAroundTarget(yawDeg: number, pitchDeg = 0, durationMs = 0): void {
        // Compute the destination position by applying the rotation to
        // the current camera offset from lookAt.
        let ox = this.camera.position.x - this.lookAt.x;
        let oy = this.camera.position.y - this.lookAt.y;
        let oz = this.camera.position.z - this.lookAt.z;
        const radius = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (radius < 0.0001) return;

        // Yaw
        const yaw = yawDeg * Math.PI / 180;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const rx = ox * cy + oz * sy;
        const rz = -ox * sy + oz * cy;
        ox = rx;
        oz = rz;

        // Pitch
        const horiz = Math.sqrt(ox * ox + oz * oz);
        let pitch = Math.atan2(oy, horiz);
        pitch += pitchDeg * Math.PI / 180;
        pitch = Math.max(this.minPitchRad, Math.min(this.maxPitchRad, pitch));

        const newHoriz = radius * Math.cos(pitch);
        const newVert = radius * Math.sin(pitch);
        if (horiz > 0.0001) {
            const scale = newHoriz / horiz;
            ox *= scale;
            oz *= scale;
        } else {
            ox = 0;
            oz = newHoriz;
        }
        oy = newVert;

        // Clamp height
        let cameraY = this.lookAt.y + oy;
        if (cameraY < this.minHeight) oy = this.minHeight - this.lookAt.y;
        else if (cameraY > this.maxHeight) oy = this.maxHeight - this.lookAt.y;

        const endPos = new Vector3(
            this.lookAt.x + ox,
            this.lookAt.y + oy,
            this.lookAt.z + oz,
        );

        if (durationMs <= 0) {
            this.transition = null;
            this.camera.position.copyFrom(endPos);
            this.camera.setTarget(this.lookAt);
            this.targetDistance = -1;
            this.updateAxes();
            return;
        }
        this.startTransition(endPos, this.lookAt.clone(), durationMs);
    }

    /** Cancel any in-progress animated transition. */
    cancelTransition(): void {
        this.transition = null;
    }

    /** Whether an animated transition is currently running. */
    get isAnimating(): boolean {
        return this.transition !== null;
    }

    /** Current look-at position (read-only copy). */
    get target(): Vector3 {
        return this.lookAt.clone();
    }

    /** Current camera position (read-only copy). */
    get position(): Vector3 {
        return this.camera.position.clone();
    }

    // ─── Transition internals ───

    private startTransition(endPos: Vector3, endLookAt: Vector3, durationMs: number): void {
        this.transition = {
            startPos: this.camera.position.clone(),
            endPos,
            startLookAt: this.lookAt.clone(),
            endLookAt,
            durationMs,
            elapsed: 0,
        };
    }

    /** Smooth-step ease-in-out: 3t^2 - 2t^3 */
    private static smoothStep(t: number): number {
        return t * t * (3 - 2 * t);
    }

    private tickTransition(dt: number): void {
        const t = this.transition!;
        t.elapsed += dt * 1000;

        // Any user input (keys, middle/right drag, wheel) cancels the animation
        if (this.keys.size > 0 || this.middleDragging || this.rightDragging) {
            this.transition = null;
            return;
        }

        const progress = Math.min(t.elapsed / t.durationMs, 1);
        const alpha = RTSCamera.smoothStep(progress);

        Vector3.LerpToRef(t.startPos, t.endPos, alpha, this.camera.position);
        Vector3.LerpToRef(t.startLookAt, t.endLookAt, alpha, this.lookAt);
        // Lift the camera if the interpolated path runs through ground.
        this.clampAboveGround();
        this.camera.setTarget(this.lookAt);

        if (progress >= 1) {
            this.transition = null;
            this.targetDistance = -1;
            this.updateAxes();
        }
    }

    dispose(): void {
        // No DOM listeners to detach (GW4-c5b: the main-thread CameraInput owns
        // them). Just stop ticking and drop any active drag/transition state.
        this.disposed = true;
        this.middleDragging = false;
        this.rightDragging = false;
        this.transition = null;
    }
}
