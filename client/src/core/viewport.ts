/**
 * Per-frame viewport update.
 *
 * The server filters entity-state snapshots to only those inside the
 * viewport rectangle. When we sized the rectangle off
 * `camera.position.y * tan(fov/2)`, zooming in dropped the viewport to
 * ~100 elmos wide — any unit outside that tiny box was filtered out, the
 * client received an empty full-snapshot, and `EntityRenderer.update()`
 * wiped its `entityMeta` map. Entity counter on the HUD dropped to 0 and
 * every unit vanished until the camera zoomed back out enough for them
 * to re-enter the box.
 *
 * Pragmatic fix: always send a viewport that comfortably covers an
 * entire typical map. 16k elmos is bigger than wanderlust /
 * scorched_crossing / pools_of_ilys, so the server effectively passes
 * everything through. Proper frustum-on-ground math for the tilted
 * camera is a future optimisation — when we start running maps or unit
 * counts big enough that viewport filtering buys us real bandwidth, we
 * can revisit.
 */

import type { FreeCamera } from '@babylonjs/core';
import type { Connection } from './connection.js';

export function sendCameraViewport(camera: FreeCamera, connection: Connection): void {
    if (!connection.authenticated) return;

    const height = Math.max(camera.position.y, 1);
    const visibleHeight = 16384;
    const visibleWidth = 16384;

    const dir = camera.getTarget().subtract(camera.position).normalize();
    const t = dir.y !== 0 ? -camera.position.y / dir.y : 0;
    const groundX = camera.position.x + dir.x * Math.max(t, 0);
    const groundZ = camera.position.z + dir.z * Math.max(t, 0);
    const rotation = Math.atan2(dir.x, dir.z);
    // zoomLevel is metadata for LOD selection on the server; keep the
    // same height-based heuristic we used before.
    const zoomLevel = Math.max(1, height / 100);

    connection.sendViewportUpdate(0, groundX, groundZ, visibleWidth, visibleHeight, rotation, zoomLevel);
}
