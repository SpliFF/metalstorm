/**
 * RTSCamera — top-down tactical camera controls.
 *
 * Handles:
 *   - WASD / arrow keys       → pan on the XZ plane
 *   - Mouse wheel             → zoom (changes camera height and target distance)
 *   - Edge-scrolling          → pan when the mouse nears a screen edge
 *   - Middle-mouse + drag     → orbit the camera around its look-at point
 *                               (horizontal drag yaws, vertical drag tilts)
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
    /** Radians of yaw / tilt per pixel of middle-mouse drag. */
    orbitSpeed?: number;
}

export class RTSCamera {
    private camera: FreeCamera;
    private canvas: HTMLCanvasElement;
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

    // Middle-mouse orbit state. Last drag position is in client-space
    // (window pixels, not canvas-relative) because we attach the move/up
    // listeners to `window` for the duration of the drag so the orbit
    // keeps tracking even if the cursor leaves the canvas.
    private orbitDragging = false;
    private orbitLastX = 0;
    private orbitLastY = 0;
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

    // Bound handlers so we can remove them on dispose()
    private onKeyDown = (e: KeyboardEvent): void => {
        // Ignore if an input element has focus
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        this.keys.add(e.key.toLowerCase());
    };

    private onKeyUp = (e: KeyboardEvent): void => {
        this.keys.delete(e.key.toLowerCase());
    };

    private onBlur = (): void => {
        this.keys.clear();
    };

    private onWheel = (e: WheelEvent): void => {
        if (e.target !== this.canvas) return;
        e.preventDefault();
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
        const norm = Math.max(-1, Math.min(1, e.deltaY / 100));
        const factor = Math.pow(1 + this.zoomStep, norm);
        this.targetDistance *= factor;
        this.targetDistance = this.clampDistance(this.targetDistance);
    };

    private onMouseMove = (e: MouseEvent): void => {
        const rect = this.canvas.getBoundingClientRect();
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        this.mouseInCanvas =
            this.mouseX >= 0 && this.mouseX < rect.width &&
            this.mouseY >= 0 && this.mouseY < rect.height;
    };

    private onMouseLeave = (): void => {
        this.mouseInCanvas = false;
    };

    // Middle-mouse press on the canvas starts an orbit drag. We use
    // pointer events (not mouse events) because Babylon hooks pointer
    // events via scene.onPointerObservable, and modern browsers don't
    // always generate compatibility `mousedown` events for middle
    // button on a canvas that already has a pointer-event listener.
    // Pointer capture then guarantees that pointermove/pointerup keep
    // being delivered to the canvas even when the cursor leaves it.
    private capturedPointerId = -1;

    private onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 1) return; // middle button only
        // Swallow default middle-click behaviour (autoscroll marker,
        // "open in new tab" compat click) and stop the event from
        // reaching Babylon's pointer observable, so a stray middle-
        // click can never be mistaken for a selection/command.
        e.preventDefault();
        e.stopPropagation();
        this.orbitDragging = true;
        this.orbitLastX = e.clientX;
        this.orbitLastY = e.clientY;
        try {
            this.canvas.setPointerCapture(e.pointerId);
            this.capturedPointerId = e.pointerId;
        } catch {
            // setPointerCapture can throw if the pointer id is gone
            // (very rare — e.g. if the browser released the pointer
            // between dispatch and handler run). Fall back to window
            // listeners so we still see move/up events.
            window.addEventListener('pointermove', this.onPointerMove);
            window.addEventListener('pointerup', this.onPointerUp);
            return;
        }
        this.canvas.addEventListener('pointermove', this.onPointerMove);
        this.canvas.addEventListener('pointerup', this.onPointerUp);
    };

    private onPointerMove = (e: PointerEvent): void => {
        if (!this.orbitDragging) return;
        const dx = e.clientX - this.orbitLastX;
        const dy = e.clientY - this.orbitLastY;
        this.orbitLastX = e.clientX;
        this.orbitLastY = e.clientY;
        if (dx !== 0 || dy !== 0) {
            this.orbitBy(dx, dy);
        }
    };

    private onPointerUp = (e: PointerEvent): void => {
        if (e.button !== 1) return;
        this.orbitDragging = false;
        if (this.capturedPointerId >= 0) {
            try { this.canvas.releasePointerCapture(this.capturedPointerId); } catch { /* already released */ }
            this.capturedPointerId = -1;
        }
        this.canvas.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerup', this.onPointerUp);
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('pointerup', this.onPointerUp);
    };

    constructor(camera: FreeCamera, canvas: HTMLCanvasElement, config: RTSCameraConfig = {}) {
        this.camera = camera;
        this.canvas = canvas;
        this.minHeight = config.minHeight ?? 100;
        this.maxHeight = config.maxHeight ?? 5000;
        this.panSpeed = config.panSpeed ?? 800;
        this.zoomStep = config.zoomStep ?? 0.15;
        this.edgeScrollPixels = config.edgeScrollPixels ?? 8;
        // 0.006 rad/px ≈ a full 360° sweep after dragging ~1050 px, which
        // feels roughly right for a 1080p-ish canvas.
        this.orbitSpeed = config.orbitSpeed ?? 0.006;

        // Detach Babylon's default input so it doesn't fight our handlers
        camera.detachControl();

        // Seed our look-at point from the camera's current direction,
        // projected onto the Y = 0 plane (so we're looking at the ground).
        this.lookAt.copyFrom(this.computeGroundLookAt());
        this.camera.setTarget(this.lookAt);
        this.updateAxes();

        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('blur', this.onBlur);
        canvas.addEventListener('wheel', this.onWheel, { passive: false });
        canvas.addEventListener('mousemove', this.onMouseMove);
        canvas.addEventListener('mouseleave', this.onMouseLeave);
        // Pointerdown runs in the capture phase so it fires before any
        // other canvas-attached pointer listener (e.g. Babylon's scene
        // observable). That lets us stopPropagation on middle-button
        // events without missing them ourselves.
        canvas.addEventListener('pointerdown', this.onPointerDown, { capture: true });
        // Some browsers open an autoscroll marker on middle-click.
        // auxclick is the cleanest way to suppress it without also
        // breaking left/right click handling in InputManager.
        canvas.addEventListener('auxclick', this.onAuxClick);
    }

    // Swallow middle-button auxclicks on the canvas so the browser
    // doesn't interpret them as "open link in new tab" / autoscroll
    // once the orbit drag ends.
    private onAuxClick = (e: MouseEvent): void => {
        if (e.button === 1) e.preventDefault();
    };

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
        if (this.keys.has('w') || this.keys.has('arrowup'))    moveZ += 1;
        if (this.keys.has('s') || this.keys.has('arrowdown'))  moveZ -= 1;
        if (this.keys.has('a') || this.keys.has('arrowleft'))  moveX -= 1;
        if (this.keys.has('d') || this.keys.has('arrowright')) moveX += 1;

        // Edge scrolling
        if (this.edgeScrollPixels > 0 && this.mouseInCanvas) {
            const w = this.canvas.clientWidth;
            const h = this.canvas.clientHeight;
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
        // Right = forward × up (left-handed coords)
        this.right.set(this.forward.z, 0, -this.forward.x);
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

        // Any user input (keys, orbit drag, wheel) cancels the animation
        if (this.keys.size > 0 || this.orbitDragging) {
            this.transition = null;
            return;
        }

        const progress = Math.min(t.elapsed / t.durationMs, 1);
        const alpha = RTSCamera.smoothStep(progress);

        Vector3.LerpToRef(t.startPos, t.endPos, alpha, this.camera.position);
        Vector3.LerpToRef(t.startLookAt, t.endLookAt, alpha, this.lookAt);
        this.camera.setTarget(this.lookAt);

        if (progress >= 1) {
            this.transition = null;
            this.targetDistance = -1;
            this.updateAxes();
        }
    }

    dispose(): void {
        this.disposed = true;
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        this.canvas.removeEventListener('wheel', this.onWheel);
        this.canvas.removeEventListener('mousemove', this.onMouseMove);
        this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
        this.canvas.removeEventListener('pointerdown', this.onPointerDown, { capture: true } as EventListenerOptions);
        this.canvas.removeEventListener('auxclick', this.onAuxClick);
        // Defensively detach any drag-time listeners in case the
        // camera is disposed mid-drag. These are registered on
        // either the canvas (normal path) or window (setPointerCapture
        // fallback path) so we have to try both.
        if (this.orbitDragging) {
            this.canvas.removeEventListener('pointermove', this.onPointerMove);
            this.canvas.removeEventListener('pointerup', this.onPointerUp);
            window.removeEventListener('pointermove', this.onPointerMove);
            window.removeEventListener('pointerup', this.onPointerUp);
            if (this.capturedPointerId >= 0) {
                try { this.canvas.releasePointerCapture(this.capturedPointerId); } catch { /* already released */ }
                this.capturedPointerId = -1;
            }
            this.orbitDragging = false;
        }
    }
}
