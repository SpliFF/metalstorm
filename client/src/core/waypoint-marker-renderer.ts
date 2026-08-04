/**
 * WaypointMarkerRenderer — draws billboarded icons at each queued order's
 * destination for the current selection. Companion to CommandPathRenderer
 * (which draws the connecting line). Gated on the same shift-held gesture.
 *
 * Recoil reference (rts/Rendering/CommandDrawer.cpp): each segment endpoint
 * gets a cursor-icon sprite via `cursorIcons.AddIcon(cmdID, endPos)`. The
 * icon is rendered as a screen-space billboarded quad with the same PNG
 * the per-command cursor uses. Build orders additionally call
 * `cursorIcons.AddBuildIcon(...)` to draw a translucent footprint outline
 * at the build position.
 *
 * Visual goals:
 *   1. One billboarded quad per waypoint, sized in world units so it scales
 *      naturally with camera zoom.
 *   2. Colour-coded by command type (matches command-path-renderer.ts):
 *      green for build/move, red for attack, etc.
 *   3. White outer ring for contrast against arbitrary terrain.
 *   4. X-ray render (depth-always) so markers stay visible behind hills.
 *
 * Marker hit-test (`pick`) is used by the waypoint-dragger and revocation
 * paths — each marker mesh's `metadata.waypoint` field carries the
 * `(unitId, tag, cmdId)` tuple for the order it represents. Scene picks
 * filtered on `mesh.name.startsWith('waypoint-marker')` return the
 * waypoint mesh; the metadata then identifies the underlying order.
 */

import {
    Scene,
    Vector3,
    Mesh,
    MeshBuilder,
    StandardMaterial,
    DynamicTexture,
    Color3,
    Texture,
    type InstancedMesh,
} from '@babylonjs/core';
import type { EntityRenderer } from './entity-renderer.js';
import type { ParsedMapData } from './map-data.js';

interface OrderInfo {
    cmdId: number;
    tag?: number;
    params: number[];
}

interface QueueInfo {
    unitId: number;
    orders: ReadonlyArray<OrderInfo>;
}

/** Metadata attached to each marker mesh — read by waypoint-dragger /
 *  revocation hit-tests. `tag` is the server-assigned order tag (used as
 *  the argument to CMD.INSERT / CMD.REMOVE); 0 means "untagged" (rare;
 *  the server tags every queued order with tag >= 1). */
export interface WaypointMarkerMeta {
    unitId: number;
    tag: number;
    cmdId: number;
    /** Index of the order within the unit's queue when the marker was
     *  rendered. Useful for queue-position UI (e.g. the dimming gradient
     *  Recoil applies to deeper queue entries). */
    queueIndex: number;
}

const CMD_MOVE     = 10;
const CMD_PATROL   = 15;
const CMD_FIGHT    = 16;
const CMD_ATTACK   = 20;
const CMD_GUARD    = 25;
const CMD_REPAIR   = 40;
const CMD_RECLAIM  = 90;
const CMD_RESURRECT = 125;
const CMD_CAPTURE  = 130;

const COLOR_MOVE    = new Color3(0.5, 1.0, 0.5);
const COLOR_ATTACK  = new Color3(1.0, 0.2, 0.2);
const COLOR_BUILD   = new Color3(0.0, 1.0, 0.0);
const COLOR_FIGHT   = new Color3(0.5, 0.5, 1.0);
const COLOR_PATROL  = new Color3(0.3, 0.3, 1.0);
const COLOR_GUARD   = new Color3(0.3, 0.3, 1.0);
const COLOR_REPAIR  = new Color3(0.3, 1.0, 1.0);
const COLOR_RECLAIM = new Color3(1.0, 0.2, 1.0);
const COLOR_CAPTURE = new Color3(1.0, 1.0, 0.3);
const COLOR_RESURRECT = new Color3(0.2, 0.6, 1.0);

/// gl.ALWAYS — matches the X-ray treatment CommandPathRenderer uses for
/// the connecting lines.
const DEPTH_ALWAYS = 519;

/// +3 elmos terrain lift (matches CommandDrawer.cpp endpoint Y).
const ENDPOINT_TERRAIN_LIFT = 3;

/// World-space size of each marker. Sized so a marker covers ~24 elmos
/// (about the footprint of a small unit) at the default RTS camera
/// distance. Babylon's plane mesh uses size = edge length.
const MARKER_SIZE = 28;

/// Lift markers a small distance above the line endpoint Y so they stack
/// cleanly on top of the path line (which sits at terrain + 3 elmos).
const MARKER_Y_LIFT = 2;

/** Key for the cmdColors / master-mesh map. Negative cmd_ids (build)
 *  collapse to -1 since they all share one colour. */
function bucketKey(cmdId: number): number {
    return cmdId < 0 ? -1 : cmdId;
}

function colorForBucket(key: number): Color3 {
    if (key < 0) return COLOR_BUILD;
    switch (key) {
        case CMD_MOVE:      return COLOR_MOVE;
        case CMD_PATROL:    return COLOR_PATROL;
        case CMD_FIGHT:     return COLOR_FIGHT;
        case CMD_ATTACK:    return COLOR_ATTACK;
        case CMD_GUARD:     return COLOR_GUARD;
        case CMD_REPAIR:    return COLOR_REPAIR;
        case CMD_RECLAIM:   return COLOR_RECLAIM;
        case CMD_RESURRECT: return COLOR_RESURRECT;
        case CMD_CAPTURE:   return COLOR_CAPTURE;
        default:            return COLOR_MOVE;
    }
}

/** Pull a 3-vector destination off an order's param list. */
function destOf(order: OrderInfo): Vector3 | null {
    const p = order.params;
    if (p.length >= 3) return new Vector3(p[0], p[1], p[2]);
    return null;
}

export class WaypointMarkerRenderer {
    private scene: Scene;
    private entityRenderer: EntityRenderer;
    private mapData: ParsedMapData | null = null;
    private shiftHeld = false;
    private lastSelection: ReadonlyArray<number> = [];
    private lastQueues: ReadonlyArray<QueueInfo> = [];

    /** One master mesh per cmd-color bucket. Each is a flat plane lying on
     *  the ground (rotated x=PI/2). InstancedMesh copies share the master's
     *  material + geometry — cheap to spawn N instances. The master itself
     *  has `isVisible=false`; only its instances render. */
    private masters = new Map<number, Mesh>();
    private materials = new Map<number, StandardMaterial>();
    /** Per-waypoint instances. Disposed and rebuilt on each render(). */
    private instances: InstancedMesh[] = [];

    /** Number of waypoint markers currently in the scene. Read-only probe for
     *  the PLAN-latency L4 measurement — it counts the artifact the player
     *  actually sees, rather than the data structure behind it. */
    get markerCount(): number { return this.instances.length; }

    /// Same fingerprint scheme as CommandPathRenderer — skip the rebuild
    /// when nothing changed between broadcasts to avoid a 1 Hz flicker.
    private renderedFingerprint = '';

    constructor(scene: Scene, entityRenderer: EntityRenderer) {
        this.scene = scene;
        this.entityRenderer = entityRenderer;
    }

    setMapData(map: ParsedMapData): void {
        this.mapData = map;
    }

    setShiftHeld(held: boolean): void {
        if (held === this.shiftHeld) return;
        this.shiftHeld = held;
        if (held) {
            // Clear the fingerprint so the first frame of a press cycle
            // always re-renders.
            this.renderedFingerprint = '';
            this.render();
        } else {
            this.clearInstances();
        }
    }

    update(queues: ReadonlyArray<QueueInfo>, selection: ReadonlyArray<number>): void {
        this.lastQueues = queues;
        this.lastSelection = selection;
        if (this.shiftHeld) this.render();
    }

    /** Bilinear height sample at world (x, z). Copied from
     *  command-path-renderer.ts — divergence here would cause the marker
     *  to float above or below the line endpoint. */
    private sampleHeight(x: number, z: number): number {
        const m = this.mapData;
        if (!m || m.heightmap.length === 0) return 0;
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

    private fingerprint(): string {
        const sel = this.lastSelection.length === 0
            ? ''
            : this.lastSelection.slice().sort((a, b) => a - b).join(',');
        const qparts: string[] = [];
        for (const q of this.lastQueues) {
            qparts.push(`${q.unitId}:${q.orders.map(o => `${o.cmdId}|${o.tag ?? 0}|${o.params.join(',')}`).join(';')}`);
        }
        return `${sel}#${qparts.join('/')}`;
    }

    /** Lazily-built per-bucket master mesh. Texture is drawn on a 64×64
     *  DynamicTexture: an outlined disc filled with the command colour.
     *  Material is unlit + alpha-blended; depth-always so markers see
     *  through hills like the connecting line does. */
    private ensureMaster(bucketKey: number): Mesh {
        const existing = this.masters.get(bucketKey);
        if (existing) return existing;

        const color = colorForBucket(bucketKey);
        const size = 64;
        const dyn = new DynamicTexture(
            `waypoint-tex-${bucketKey}`,
            size,
            this.scene,
            false,
            Texture.TRILINEAR_SAMPLINGMODE,
        );
        dyn.hasAlpha = true;
        const ctx = dyn.getContext() as CanvasRenderingContext2D;
        ctx.clearRect(0, 0, size, size);

        // White outer ring for contrast against arbitrary terrain.
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 4;
        ctx.stroke();

        // Filled disc in the command colour. Alpha 0.78 so the underlying
        // terrain shows through slightly — matches the queued-line look.
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 7, 0, Math.PI * 2);
        const r = Math.round(color.r * 255);
        const g = Math.round(color.g * 255);
        const b = Math.round(color.b * 255);
        ctx.fillStyle = `rgba(${r},${g},${b},0.78)`;
        ctx.fill();
        dyn.update(false);

        const mat = new StandardMaterial(`waypoint-mat-${bucketKey}`, this.scene);
        mat.diffuseTexture = dyn;
        mat.opacityTexture = dyn;
        mat.useAlphaFromDiffuseTexture = true;
        mat.emissiveColor = new Color3(1, 1, 1);
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.depthFunction = DEPTH_ALWAYS;
        this.materials.set(bucketKey, mat);

        // Plane lying flat on the ground (x rotation = PI/2). Top-down
        // orientation matches the minimap convention and reads cleanly
        // at the default RTS camera tilt without needing per-frame
        // billboard calculations.
        const master = MeshBuilder.CreatePlane(
            `waypoint-master-${bucketKey}`,
            { size: MARKER_SIZE, sideOrientation: Mesh.DOUBLESIDE },
            this.scene,
        );
        master.rotation.x = Math.PI / 2;
        master.material = mat;
        master.isVisible = false; // source mesh; only instances render
        master.isPickable = false;
        // Same renderingGroupId=3 as the connecting line so markers always
        // sit on top of world geometry.
        master.renderingGroupId = 3;
        master.alwaysSelectAsActiveMesh = true;

        this.masters.set(bucketKey, master);
        return master;
    }

    private render(): void {
        const fp = this.fingerprint();
        if (fp === this.renderedFingerprint && this.instances.length > 0) return;

        this.clearInstances();

        if (this.lastSelection.length === 0) {
            this.renderedFingerprint = fp;
            return;
        }

        const sel = new Set(this.lastSelection);
        let count = 0;

        for (const q of this.lastQueues) {
            if (!sel.has(q.unitId)) continue;
            for (let i = 0; i < q.orders.length; i++) {
                const o = q.orders[i];
                const dest = destOf(o);
                if (!dest) continue;
                const ground = this.sampleHeight(dest.x, dest.z);
                if (!Number.isFinite(ground)) continue;
                const y = Math.max(dest.y, ground) + ENDPOINT_TERRAIN_LIFT + MARKER_Y_LIFT;

                const master = this.ensureMaster(bucketKey(o.cmdId));
                const inst = master.createInstance(`waypoint-marker-${q.unitId}-${o.tag ?? i}`);
                inst.position.set(dest.x, y, dest.z);
                inst.rotation.x = Math.PI / 2;
                inst.isPickable = true;
                inst.alwaysSelectAsActiveMesh = true;
                inst.renderingGroupId = 3;
                // Stash the order identity on the instance so hit-tests
                // can map a picked mesh back to an (insertable/removable)
                // order tag.
                const meta: WaypointMarkerMeta = {
                    unitId: q.unitId,
                    tag: o.tag ?? 0,
                    cmdId: o.cmdId,
                    queueIndex: i,
                };
                inst.metadata = { waypoint: meta };
                this.instances.push(inst);
                count++;
            }
        }

        this.renderedFingerprint = fp;
        // Suppress lint complaints about `count` being unused; kept for
        // future logging once we wire perf telemetry.
        void count;
    }

    private clearInstances(): void {
        for (const inst of this.instances) inst.dispose();
        this.instances = [];
    }

    clear(): void {
        this.clearInstances();
        this.renderedFingerprint = '';
    }

    dispose(): void {
        this.clear();
        for (const master of this.masters.values()) master.dispose();
        for (const mat of this.materials.values()) {
            mat.diffuseTexture?.dispose();
            mat.dispose();
        }
        this.masters.clear();
        this.materials.clear();
    }
}
