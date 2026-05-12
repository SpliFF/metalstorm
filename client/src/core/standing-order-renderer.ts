/**
 * StandingOrderRenderer — draws per-type map overlays for each active
 * standing order in `LiveState.standingOrders`. Sibling to
 * CommandPathRenderer (which draws the queued-command lines of the
 * current selection) and WaypointMarkerRenderer (which draws the
 * billboarded endpoint icons).
 *
 * The server scopes the `StandingOrderState` broadcast to the viewer's
 * own team + allied teams, so anything that reaches this renderer is
 * legal to show. Optional `setShowAllies(false)` collapses the display
 * to own-team only for users who find allied orders distracting; the
 * flag persists via localStorage key `standing-orders-show-allies`.
 *
 * Per-type rendering (matches the StandingOrderType enum in
 * `schemas/protocol.fbs`):
 *   DefendArea  → ground ring (torus) at radius
 *   PatrolRoute → dotted polyline through waypoints
 *   RallyPoint  → flag billboard
 *   Fallback    → red retreat ring + arrow billboard
 *   Reinforce   → dashed ring + assigned-count label
 *   Screen      → dotted line between endpoints
 *   SupplyRoute → dotted line between source & sink
 *   BuildBase   → centre marker (blueprint outlines for queued defs
 *                 deferred — game-Lua owns the build queue per
 *                 PLAN-orders.md "BuildBase concrete behaviour")
 *
 * All overlays draw at renderingGroupId=3 with depth-always so they
 * stay visible across hills — same convention as the path-line and
 * waypoint-marker renderers. Colour is per-team using the same palette
 * as EntityRenderer.
 */

import {
    Scene,
    Color3,
    Vector3,
    Mesh,
    MeshBuilder,
    StandardMaterial,
    DynamicTexture,
    Texture,
    CreateGreasedLine,
    GreasedLineMeshColorMode,
    GreasedLineMeshMaterialType,
} from '@babylonjs/core';
import type { ParsedMapData } from './map-data.js';
import type { StandingOrderInfoMsg } from './connection.js';

/// gl.ALWAYS — keep overlays visible behind terrain. Mirrors the
/// `glDisable(GL_DEPTH_TEST)` Recoil uses for the command path X-ray.
const DEPTH_ALWAYS = 519;

/// Lift overlays slightly above terrain so they don't z-fight on flat
/// ground. Same value used by command-path / waypoint-marker for
/// endpoint Y.
const TERRAIN_LIFT = 3;

/// Team palette — duplicated from entity-renderer.ts because that
/// constant isn't exported. Keep in sync; any future per-team-colour
/// stream should replace both copies.
const TEAM_COLORS = [
    new Color3(90/255, 90/255, 255/255),
    new Color3(200/255, 0/255, 0/255),
    new Color3(255/255, 255/255, 255/255),
    new Color3(38/255, 155/255, 32/255),
    new Color3(7/255, 31/255, 125/255),
    new Color3(150/255, 10/255, 180/255),
    new Color3(255/255, 255/255, 0/255),
    new Color3(50/255, 50/255, 50/255),
    new Color3(152/255, 200/255, 220/255),
    new Color3(171/255, 171/255, 131/255),
];

function teamColor(team: number): Color3 {
    return TEAM_COLORS[((team % TEAM_COLORS.length) + TEAM_COLORS.length) % TEAM_COLORS.length];
}

const SHOW_ALLIES_KEY = 'standing-orders-show-allies';

/// Width in world units for the path-style overlays (PatrolRoute,
/// Screen, SupplyRoute). Slightly wider than the queued-command line so
/// strategic intent reads differently from per-unit orders.
const STANDING_LINE_WIDTH = 6;

/// Dash period as a fraction of total line length. Higher = finer
/// dashes. Matches the "queued segment" pattern of command-path-renderer
/// but with longer dashes since standing orders need to read as
/// strategic, not operational.
const DASH_PER_ELMO = 1 / 48;
const DASH_RATIO = 0.5;

/// World-space size of billboard markers (rally flag, reinforce icon).
const ICON_SIZE = 36;

export class StandingOrderRenderer {
    private scene: Scene;
    private mapData: ParsedMapData | null = null;
    private myTeam = -1;
    private myAllyTeam = -1;
    /** team → ally? lookup. Empty map means treat every team as
     *  "unknown" — render whatever the server sent. */
    private allyOf = new Map<number, boolean>();

    private showAllies: boolean = (() => {
        try {
            const v = localStorage.getItem(SHOW_ALLIES_KEY);
            return v === null ? true : v !== 'false';
        } catch {
            return true;
        }
    })();

    /** Active overlay meshes; disposed and rebuilt on every render. */
    private overlays: Mesh[] = [];

    /** Lazy materials keyed by team index. One per team is enough — the
     *  per-order tint comes from the material's emissiveColor. */
    private ringMats = new Map<number, StandardMaterial>();
    private iconMats = new Map<string, StandardMaterial>();

    private lastOrders: ReadonlyArray<StandingOrderInfoMsg> = [];
    private lastFingerprint = '';

    constructor(scene: Scene) {
        this.scene = scene;
    }

    setMapData(map: ParsedMapData): void {
        this.mapData = map;
    }

    /** Push the viewer's team identity so allied-team filtering works.
     *  `allyMap[team]=true` means that team is allied with the viewer.
     *  Called from main.ts on `stateUpdate`. */
    setIdentity(myTeam: number, myAllyTeam: number, allyMap?: ReadonlyMap<number, boolean>): void {
        this.myTeam = myTeam;
        this.myAllyTeam = myAllyTeam;
        if (allyMap) {
            this.allyOf = new Map(allyMap);
        }
        // Identity change can flip visibility — rebuild from cache.
        this.lastFingerprint = '';
        this.render();
    }

    setShowAllies(show: boolean): void {
        if (show === this.showAllies) return;
        this.showAllies = show;
        try { localStorage.setItem(SHOW_ALLIES_KEY, show ? 'true' : 'false'); } catch { /* ignore */ }
        this.lastFingerprint = '';
        this.render();
    }

    /** Called from Connection.onStandingOrders. Wholesale replacement
     *  semantics — every push is a full snapshot of orders the viewer
     *  is allowed to see. */
    update(orders: ReadonlyArray<StandingOrderInfoMsg>): void {
        this.lastOrders = orders;
        this.render();
    }

    private isOwnTeam(team: number): boolean {
        return this.myTeam >= 0 && team === this.myTeam;
    }

    private isAlly(team: number): boolean {
        if (this.isOwnTeam(team)) return false;
        const flag = this.allyOf.get(team);
        if (flag !== undefined) return flag;
        // Fall back: if we don't have an ally map yet, assume the server
        // already scoped the broadcast (own + allies). Anything that
        // isn't own-team is allied.
        return true;
    }

    private fingerprint(): string {
        const parts: string[] = [`${this.showAllies ? 'A' : 'O'}/${this.myTeam}`];
        for (const o of this.lastOrders) {
            parts.push(`${o.orderId}:${o.type}:${o.ownerTeam}:${o.active ? 1 : 0}:${o.assignedSquadCount}:${o.params.join(',')}`);
        }
        return parts.join('|');
    }

    /** Bilinear terrain height sample. Mirrors the helper in
     *  waypoint-marker-renderer and command-path-renderer. */
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

    /** y-on-terrain at world (x, z), lifted by `lift`. Falls through
     *  the supplied y when no map data is available. */
    private groundY(x: number, suppliedY: number, z: number, lift = TERRAIN_LIFT): number {
        const g = this.sampleHeight(x, z);
        return Math.max(suppliedY, g) + lift;
    }

    private render(): void {
        const fp = this.fingerprint();
        if (fp === this.lastFingerprint && this.overlays.length > 0) return;
        this.clearOverlays();

        for (const order of this.lastOrders) {
            if (!order.active) continue;
            const ownTeam = this.isOwnTeam(order.ownerTeam);
            const allied = this.isAlly(order.ownerTeam);
            if (!ownTeam && allied && !this.showAllies) continue;
            if (!ownTeam && !allied) continue; // safety: enemy shouldn't reach us

            this.renderOne(order);
        }

        this.lastFingerprint = fp;
    }

    private renderOne(o: StandingOrderInfoMsg): void {
        switch (o.type) {
            case 'DefendArea':  this.renderDefendArea(o);  break;
            case 'PatrolRoute': this.renderPolyline(o, true);   break;
            case 'RallyPoint':  this.renderPointIcon(o, '🚩'); break;
            case 'Fallback':    this.renderFallback(o);    break;
            case 'Reinforce':   this.renderReinforce(o);   break;
            case 'Screen':      this.renderLineSegment(o); break;
            case 'SupplyRoute': this.renderLineSegment(o); break;
            case 'BuildBase':   this.renderPointIcon(o, '🏗'); break;
            default: break;
        }
    }

    /** DefendArea params: [x, y, z, radius] → ground ring. */
    private renderDefendArea(o: StandingOrderInfoMsg): void {
        const p = o.params;
        if (p.length < 4) return;
        const [x, y, z, radius] = [p[0], p[1], p[2], p[3]];
        if (radius <= 0) return;
        const color = teamColor(o.ownerTeam);
        const ring = this.makeRing(`defend-ring-${o.orderId}`, radius, color);
        ring.position.set(x, this.groundY(x, y, z, 2), z);
        this.overlays.push(ring);
    }

    /** PatrolRoute params: [x1, y1, z1, x2, y2, z2, ...] → dotted
     *  polyline through waypoints. */
    private renderPolyline(o: StandingOrderInfoMsg, dashed: boolean): void {
        const p = o.params;
        const n = Math.floor(p.length / 3);
        if (n < 2) return;
        const points: Vector3[] = [];
        let totalLen = 0;
        for (let i = 0; i < n; i++) {
            const x = p[i * 3 + 0];
            const y = p[i * 3 + 1];
            const z = p[i * 3 + 2];
            const v = new Vector3(x, this.groundY(x, y, z), z);
            if (i > 0) totalLen += Vector3.Distance(points[i - 1], v);
            points.push(v);
        }
        const color = teamColor(o.ownerTeam);
        const line = this.makeGreasedLine(`patrol-${o.orderId}`, points, color, dashed, totalLen);
        if (line) this.overlays.push(line);
    }

    /** Two-point line segment used by Screen + SupplyRoute. Params:
     *  [x1, y1, z1, x2, y2, z2]. */
    private renderLineSegment(o: StandingOrderInfoMsg): void {
        const p = o.params;
        if (p.length < 6) return;
        const a = new Vector3(p[0], this.groundY(p[0], p[1], p[2]), p[2]);
        const b = new Vector3(p[3], this.groundY(p[3], p[4], p[5]), p[5]);
        const color = teamColor(o.ownerTeam);
        const line = this.makeGreasedLine(`segment-${o.orderId}`, [a, b], color, true,
            Vector3.Distance(a, b));
        if (line) this.overlays.push(line);
    }

    /** Fallback: red ring at the rally position, regardless of team
     *  colour (so it reads as "retreat" universally). Params: [x,y,z]. */
    private renderFallback(o: StandingOrderInfoMsg): void {
        const p = o.params;
        if (p.length < 3) return;
        const [x, y, z] = [p[0], p[1], p[2]];
        const radius = 96;
        const ring = this.makeRing(`fallback-ring-${o.orderId}`, radius, new Color3(1, 0.25, 0.25));
        ring.position.set(x, this.groundY(x, y, z, 2), z);
        this.overlays.push(ring);
        this.overlays.push(this.makePointIcon(`fallback-icon-${o.orderId}`, x, y, z, '⮌', new Color3(1, 0.5, 0.5)));
    }

    /** Reinforce: dashed ring (radius = friendlyCountThreshold * 8 elmos
     *  as a rough visual scale, clamped) plus a centre billboard with
     *  the assigned-squad count. Params: [x, y, z, threshold]. */
    private renderReinforce(o: StandingOrderInfoMsg): void {
        const p = o.params;
        if (p.length < 4) return;
        const [x, y, z, threshold] = [p[0], p[1], p[2], p[3]];
        const visualRadius = Math.max(64, Math.min(512, threshold * 8));
        const color = teamColor(o.ownerTeam);
        const ring = this.makeRing(`reinforce-ring-${o.orderId}`, visualRadius, color);
        ring.position.set(x, this.groundY(x, y, z, 2), z);
        this.overlays.push(ring);
        const label = `${o.assignedSquadCount}/${threshold}`;
        this.overlays.push(this.makeLabelIcon(`reinforce-label-${o.orderId}`, x, y, z, label, color));
    }

    /** Pure point icon — used by RallyPoint and BuildBase. */
    private renderPointIcon(o: StandingOrderInfoMsg, glyph: string): void {
        const p = o.params;
        if (p.length < 3) return;
        const [x, y, z] = [p[0], p[1], p[2]];
        const color = teamColor(o.ownerTeam);
        this.overlays.push(this.makePointIcon(`icon-${o.orderId}`, x, y, z, glyph, color));
    }

    /** Build a ground-projected ring (flat torus) at the given world
     *  radius. Tessellation scales with radius so a 4096-elmo ring
     *  stays smooth without burning verts on a 64-elmo one. */
    private makeRing(name: string, radius: number, color: Color3): Mesh {
        const tess = Math.max(24, Math.min(96, Math.floor(radius / 24)));
        const thickness = Math.max(2, radius * 0.012);
        const ring = MeshBuilder.CreateTorus(name, {
            diameter: radius * 2,
            thickness,
            tessellation: tess,
        }, this.scene);
        ring.scaling.y = 0.15;
        const mat = new StandardMaterial(`${name}-mat`, this.scene);
        mat.diffuseColor = new Color3(0, 0, 0);
        mat.emissiveColor = color;
        mat.specularColor = new Color3(0, 0, 0);
        mat.disableLighting = true;
        mat.alpha = 0.55;
        mat.disableDepthWrite = true;
        mat.depthFunction = DEPTH_ALWAYS;
        ring.material = mat;
        ring.isPickable = false;
        ring.renderingGroupId = 3;
        return ring;
    }

    /** Build a dashed (or solid) world-space line through `points`.
     *  Returns null if Babylon refuses to build (degenerate input). */
    private makeGreasedLine(
        name: string,
        points: ReadonlyArray<Vector3>,
        color: Color3,
        dashed: boolean,
        totalLen: number,
    ): Mesh | null {
        if (points.length < 2) return null;
        const flat: number[] = [];
        for (const v of points) flat.push(v.x, v.y, v.z);
        try {
            const dashCount = dashed
                ? Math.max(8, Math.min(256, Math.round(totalLen * DASH_PER_ELMO)))
                : 0;
            const mesh = CreateGreasedLine(name, {
                points: flat,
                updatable: false,
            }, {
                width: STANDING_LINE_WIDTH,
                useDash: dashed,
                dashCount: dashed ? dashCount : 1,
                dashRatio: DASH_RATIO,
                color,
                colorMode: GreasedLineMeshColorMode.COLOR_MODE_SET,
                materialType: GreasedLineMeshMaterialType.MATERIAL_TYPE_SIMPLE,
                sizeAttenuation: true,
            }, this.scene);
            mesh.renderingGroupId = 3;
            const mat = mesh.material as StandardMaterial | null;
            if (mat) {
                mat.disableDepthWrite = true;
                mat.depthFunction = DEPTH_ALWAYS;
                mat.alpha = 0.7;
            }
            return mesh;
        } catch (err) {
            console.warn('[standing-order] greased line build failed', err);
            return null;
        }
    }

    /** Billboard glyph at a world position. Glyph is rendered into a
     *  DynamicTexture and stamped on a quad facing the camera. */
    private makePointIcon(name: string, x: number, y: number, z: number, glyph: string, color: Color3): Mesh {
        const matKey = `${glyph}:${color.r.toFixed(2)}:${color.g.toFixed(2)}:${color.b.toFixed(2)}`;
        let mat = this.iconMats.get(matKey);
        if (!mat) {
            const size = 128;
            const dyn = new DynamicTexture(`standing-icon-tex-${matKey}`, size, this.scene, false,
                Texture.TRILINEAR_SAMPLINGMODE);
            dyn.hasAlpha = true;
            const ctx = dyn.getContext() as CanvasRenderingContext2D;
            ctx.clearRect(0, 0, size, size);
            // Faded coloured disc behind the glyph for contrast.
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
            const r = Math.round(color.r * 255);
            const g = Math.round(color.g * 255);
            const b = Math.round(color.b * 255);
            ctx.fillStyle = `rgba(${r},${g},${b},0.5)`;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 4;
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.font = '64px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(glyph, size / 2, size / 2 + 4);
            dyn.update(false);

            mat = new StandardMaterial(`standing-icon-mat-${matKey}`, this.scene);
            mat.diffuseTexture = dyn;
            mat.opacityTexture = dyn;
            mat.useAlphaFromDiffuseTexture = true;
            mat.emissiveColor = new Color3(1, 1, 1);
            mat.disableLighting = true;
            mat.backFaceCulling = false;
            mat.disableDepthWrite = true;
            mat.depthFunction = DEPTH_ALWAYS;
            this.iconMats.set(matKey, mat);
        }
        const plane = MeshBuilder.CreatePlane(name, {
            size: ICON_SIZE, sideOrientation: Mesh.DOUBLESIDE,
        }, this.scene);
        plane.material = mat;
        plane.position.set(x, this.groundY(x, y, z) + ICON_SIZE * 0.4, z);
        plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        plane.renderingGroupId = 3;
        plane.isPickable = false;
        return plane;
    }

    /** Text label on a billboard. Used for Reinforce's
     *  assigned/threshold counter. */
    private makeLabelIcon(name: string, x: number, y: number, z: number, text: string, color: Color3): Mesh {
        const w = 256, h = 96;
        const dyn = new DynamicTexture(`standing-label-${name}`, { width: w, height: h }, this.scene, false,
            Texture.TRILINEAR_SAMPLINGMODE);
        dyn.hasAlpha = true;
        const ctx = dyn.getContext() as CanvasRenderingContext2D;
        ctx.clearRect(0, 0, w, h);
        const r = Math.round(color.r * 255);
        const g = Math.round(color.g * 255);
        const b = Math.round(color.b * 255);
        ctx.fillStyle = `rgba(${r},${g},${b},0.6)`;
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, w - 4, h - 4);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 56px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, w / 2, h / 2);
        dyn.update(false);

        const mat = new StandardMaterial(`standing-label-mat-${name}`, this.scene);
        mat.diffuseTexture = dyn;
        mat.opacityTexture = dyn;
        mat.useAlphaFromDiffuseTexture = true;
        mat.emissiveColor = new Color3(1, 1, 1);
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.depthFunction = DEPTH_ALWAYS;

        const plane = MeshBuilder.CreatePlane(name, {
            width: ICON_SIZE * 1.5, height: ICON_SIZE * 0.6,
            sideOrientation: Mesh.DOUBLESIDE,
        }, this.scene);
        plane.material = mat;
        plane.position.set(x, this.groundY(x, y, z) + ICON_SIZE * 0.9, z);
        plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        plane.renderingGroupId = 3;
        plane.isPickable = false;
        return plane;
    }

    private clearOverlays(): void {
        for (const m of this.overlays) {
            const mat = m.material;
            // Material is owned by the renderer (cached by team or glyph
            // for re-use). Only dispose mesh-specific materials — keyed
            // by `<prefix>-mat` and not in our caches.
            m.dispose();
            if (mat && !this.isCachedMat(mat)) {
                const tex = (mat as StandardMaterial).diffuseTexture;
                tex?.dispose();
                mat.dispose();
            }
        }
        this.overlays = [];
    }

    private isCachedMat(mat: { name: string }): boolean {
        if (!mat || !mat.name) return false;
        for (const m of this.iconMats.values()) if (m === mat) return true;
        for (const m of this.ringMats.values()) if (m === mat) return true;
        return false;
    }

    clear(): void {
        this.clearOverlays();
        this.lastFingerprint = '';
    }

    dispose(): void {
        this.clearOverlays();
        for (const mat of this.iconMats.values()) {
            const tex = mat.diffuseTexture;
            tex?.dispose();
            mat.dispose();
        }
        for (const mat of this.ringMats.values()) mat.dispose();
        this.iconMats.clear();
        this.ringMats.clear();
        this.lastOrders = [];
    }
}
