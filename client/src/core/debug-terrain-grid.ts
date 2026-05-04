/**
 * DebugTerrainGrid — diagnostic overlay that draws a contour-following
 * grid using the *exact same* tube + X-ray material setup as
 * CommandPathRenderer. If the grid renders but order paths don't, the
 * bug is path-specific (selection wiring, queue snapshot, NaN from
 * sampleHeight). If neither renders, the bug is in the shared
 * draw/material/depth pipeline.
 *
 * Wire it through the window helpers exposed at the bottom of this
 * file so it can be toggled live from devtools without rebuilds:
 *
 *   window.__terrainGrid.show()    // draw default 256-elmo grid
 *   window.__terrainGrid.show(512) // 512-elmo cell spacing
 *   window.__terrainGrid.hide()
 */

import {
    Scene,
    Color3,
    Vector3,
    Mesh,
    MeshBuilder,
    StandardMaterial,
} from '@babylonjs/core';
import type { ParsedMapData } from './map-data.js';

/// Mirror of CommandPathRenderer's constants so any divergence in
/// rendering between the two renderers is purely about the data they
/// feed in, not their materials/setup.
const PATH_SAMPLE_STEP = 32;
const PATH_TERRAIN_LIFT = 5;
const PATH_TUBE_RADIUS = 8;
const DEPTH_ALWAYS = 519;

const COLOR_X = new Color3(1.0, 0.4, 0.4);
const COLOR_Z = new Color3(0.4, 0.6, 1.0);

export class DebugTerrainGrid {
    private scene: Scene;
    private mapData: ParsedMapData | null = null;
    private meshes: Mesh[] = [];

    constructor(scene: Scene) {
        this.scene = scene;
    }

    setMapData(map: ParsedMapData): void {
        this.mapData = map;
    }

    /** Bilinear height sample — copied verbatim from CommandPathRenderer
     *  so the comparison is apples-to-apples. */
    private sampleHeight(x: number, z: number): number {
        const m = this.mapData;
        if (!m) return 0;
        const hmW = m.mapx + 1;
        const hmH = m.mapy + 1;
        const hRange = m.maxHeight - m.minHeight;
        const fx = x / m.squareSize;
        const fz = z / m.squareSize;
        const x0 = Math.max(0, Math.min(hmW - 1, Math.floor(fx)));
        const z0 = Math.max(0, Math.min(hmH - 1, Math.floor(fz)));
        const x1 = Math.min(hmW - 1, x0 + 1);
        const z1 = Math.min(hmH - 1, z0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0));
        const tz = Math.max(0, Math.min(1, fz - z0));
        const h00 = m.heightmap[z0 * hmW + x0];
        const h10 = m.heightmap[z0 * hmW + x1];
        const h01 = m.heightmap[z1 * hmW + x0];
        const h11 = m.heightmap[z1 * hmW + x1];
        const h0 = h00 * (1 - tx) + h10 * tx;
        const h1 = h01 * (1 - tx) + h11 * tx;
        const raw = h0 * (1 - tz) + h1 * tz;
        return m.minHeight + (raw / 65535) * hRange;
    }

    /** Walk a horizontal line, sampling terrain every PATH_SAMPLE_STEP
     *  elmos. Same shape as CommandPathRenderer.tessellateSegment. */
    private contourLine(ax: number, az: number, bx: number, bz: number): Vector3[] {
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.sqrt(dx * dx + dz * dz);
        const steps = Math.max(2, Math.ceil(len / PATH_SAMPLE_STEP));
        const pts: Vector3[] = new Array(steps + 1);
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = ax + dx * t;
            const z = az + dz * t;
            const y = this.sampleHeight(x, z) + PATH_TERRAIN_LIFT;
            pts[i] = new Vector3(x, y, z);
        }
        return pts;
    }

    /** Identical material + tube setup to CommandPathRenderer.drawSegment.
     *  Any rendering-pipeline bug there reproduces here. */
    private drawTube(points: Vector3[], color: Color3, name: string): void {
        if (points.length < 2) return;
        const cleaned: Vector3[] = [points[0]];
        for (let i = 1; i < points.length; i++) {
            const p = points[i];
            const last = cleaned[cleaned.length - 1];
            const dx = p.x - last.x;
            const dy = p.y - last.y;
            const dz = p.z - last.z;
            if (!Number.isFinite(p.y)) {
                console.warn(`[debug-grid] non-finite y at ${name}[${i}]:`, p);
                return;
            }
            if (dx * dx + dy * dy + dz * dz > 1e-3) cleaned.push(p);
        }
        if (cleaned.length < 2) return;

        const mesh = MeshBuilder.CreateTube(name, {
            path: cleaned,
            radius: PATH_TUBE_RADIUS,
            tessellation: 6,
            cap: Mesh.CAP_ALL,
            updatable: false,
        }, this.scene);
        const mat = new StandardMaterial(`${name}-mat`, this.scene);
        mat.diffuseColor = color;
        mat.emissiveColor = color;
        mat.specularColor = new Color3(0, 0, 0);
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.depthFunction = DEPTH_ALWAYS;
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.renderingGroupId = 3;
        this.meshes.push(mesh);
    }

    /** Build a contour-following grid over the whole map at `cell`-elmo
     *  spacing. Default 256 ≈ 32 heightmap squares: enough lines to see
     *  the topography without flooding the scene. */
    show(cell = 256): void {
        this.hide();
        const m = this.mapData;
        if (!m) {
            console.warn('[debug-grid] no map data — call setMapData first');
            return;
        }
        const w = m.widthElmos ?? m.mapx * m.squareSize;
        const h = m.heightElmos ?? m.mapy * m.squareSize;
        let drawn = 0;

        // Lines along Z (constant x) — drawn red
        for (let x = 0; x <= w; x += cell) {
            const pts = this.contourLine(x, 0, x, h);
            this.drawTube(pts, COLOR_X, `dbg-grid-x-${x}`);
            drawn++;
        }
        // Lines along X (constant z) — drawn blue
        for (let z = 0; z <= h; z += cell) {
            const pts = this.contourLine(0, z, w, z);
            this.drawTube(pts, COLOR_Z, `dbg-grid-z-${z}`);
            drawn++;
        }

        const sampleAtCenter = this.sampleHeight(w / 2, h / 2);
        console.log(
            `[debug-grid] drew ${drawn} contour lines, ${this.meshes.length} tubes; ` +
            `map ${w}x${h} elmos, cell=${cell}, ` +
            `minH=${m.minHeight} maxH=${m.maxHeight} ` +
            `sample(center)=${sampleAtCenter.toFixed(1)}`
        );
    }

    hide(): void {
        for (const mesh of this.meshes) {
            mesh.material?.dispose();
            mesh.dispose();
        }
        this.meshes = [];
    }

    dispose(): void {
        this.hide();
    }
}
