/**
 * RTSCamera — top-down tactical camera controls.
 *
 * Handles:
 *   - WASD / arrow keys → pan on the XZ plane
 *   - Mouse wheel      → zoom (changes camera height and target distance)
 *   - Edge-scrolling   → pan when the mouse nears a screen edge
 *
 * The camera keeps a fixed look direction (looking forward+down) and only
 * its world-space position changes. It does NOT use Babylon's built-in
 * FreeCamera input system.
 */

import { FreeCamera, Vector3 } from '@babylonjs/core';

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
}

export class RTSCamera {
    private camera: FreeCamera;
    private canvas: HTMLCanvasElement;
    private minHeight: number;
    private maxHeight: number;
    private panSpeed: number;
    private zoomStep: number;
    private edgeScrollPixels: number;

    private keys = new Set<string>();
    private mouseX = 0;
    private mouseY = 0;
    private mouseInCanvas = false;
    private lastTickTime = performance.now();
    private disposed = false;

    // Target camera-to-target distance. tick() eases the actual distance
    // toward this value for smooth zoom. Populated lazily on the first
    // wheel event so the initial distance comes from the Babylon camera.
    private targetDistance = -1;
    // Fraction of the gap to close per second. 0 = no smoothing (snap),
    // ~12 = roughly 5 frames to settle at 60fps.
    private zoomSmoothing = 12;

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

    constructor(camera: FreeCamera, canvas: HTMLCanvasElement, config: RTSCameraConfig = {}) {
        this.camera = camera;
        this.canvas = canvas;
        this.minHeight = config.minHeight ?? 100;
        this.maxHeight = config.maxHeight ?? 5000;
        this.panSpeed = config.panSpeed ?? 800;
        this.zoomStep = config.zoomStep ?? 0.15;
        this.edgeScrollPixels = config.edgeScrollPixels ?? 8;

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

    /** Teleport the camera to focus on a world position. */
    focusOn(x: number, z: number): void {
        // Keep the current height and look angle; just translate both
        // camera position and look-at by the same XZ delta.
        const dx = x - this.lookAt.x;
        const dz = z - this.lookAt.z;
        this.panBy(dx, dz);
    }

    dispose(): void {
        this.disposed = true;
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        this.canvas.removeEventListener('wheel', this.onWheel);
        this.canvas.removeEventListener('mousemove', this.onMouseMove);
        this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
    }
}
