/**
 * ImpostorUvPlugin — vertex-stage impostor card support for stock Babylon
 * materials: per-instance atlas-cell UV remap plus a shared screen-aligned
 * billboard rotation.
 *
 * Two jobs, both in the vertex shader, both chosen so the thin-instance MATRIX
 * buffer can stay static (built once, uploaded once, never touched again —
 * the single biggest thin-instance perf lever):
 *
 * 1. CELL SELECT (`IMPOSTOR_CELL`). A per-instance `impostorCell` float picks
 *    one cell of the sprite atlas; the quad's 0..1 UVs are scaled/offset into
 *    it. The cell index convention is `impostor-atlas.ts` — the ONE place the
 *    baker and the runtime agree on the grid. Only 1 float per instance has to
 *    be re-uploaded when the camera moves enough to change which view is
 *    facing it, versus 16 floats for a matrix rebuild.
 *
 * 2. BILLBOARD (`IMPOSTOR_BILLBOARD`). Per PLAN-metalstorm-impostors.md the
 *    card orientation is SCREEN-ALIGNED and shared by every instance in a
 *    frame (directionality comes from cell select, not from twisting each card
 *    toward the camera position — twisting is what produced the radial fan-out
 *    on nearby squad members). Shared rotation = a single mat4 uniform applied
 *    to the local vertex position, so the instance matrix carries only
 *    translation + uniform scale and never changes. The ground anchor lift is
 *    applied BEFORE the rotation so it rotates WITH the card, keeping a pitched
 *    card's base pinned to its placement point instead of hovering above the
 *    terrain.
 *
 *    Whether a card tilts at all is a property of its ATLAS, not a global
 *    choice — see `cardTiltsWithPitch()` in impostor-atlas.ts; callers drive
 *    `billboard` from it.
 *
 * Uniform scale is required on the instance matrix for (2) to be exact:
 * T * S * R == T * R * S only while S is uniform. Feature placements scale
 * uniformly (`relativeSize`), so this holds.
 */

import { MaterialPluginBase, Material, Matrix } from '@babylonjs/core';
import { type AtlasLayout, atlasRowCount } from './impostor-atlas.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefines = any;

export class ImpostorUvPlugin extends MaterialPluginBase {
    private _enabled = false;
    private _cellSelect = false;
    private _billboard = false;

    /** Atlas grid the `impostorCell` attribute indexes into. */
    layout: AtlasLayout = { yawBins: 1, pitchBins: 1, frames: 1 };
    /** Row 0 is the TOP row of the atlas image (the baker's convention). The
     *  card's UVs are top-down too (`createImpostorCard`), so this needs no
     *  flip — see `atlasCellUv`, which this shader mirrors exactly. */
    topDown = true;
    /** Shared card rotation — the camera's world rotation, so the quad's local
     *  +X/+Y/+Z map to screen right / up / toward-viewer. */
    billboardRotation: Matrix = Matrix.Identity();
    /** Ground-anchor lift in LOCAL units, applied after the rotation. Normally
     *  half the card height so the sprite's base sits on the placement point. */
    lift = 0;

    constructor(material: Material) {
        // priority 110: vertex-stage only; ordering against the fragment
        // plugins (TeamColor 100, DitherFade 120) is immaterial.
        super(material, 'ImpostorUv', 110,
            { IMPOSTOR_CELL: false, IMPOSTOR_BILLBOARD: false });
    }

    get isEnabled(): boolean { return this._enabled; }
    set isEnabled(v: boolean) {
        if (this._enabled === v) return;
        this._enabled = v;
        this.markAllDefinesAsDirty();
        this._enable(v);
    }

    /** Per-instance atlas cell select (needs an `impostorCell` buffer). */
    get cellSelect(): boolean { return this._cellSelect; }
    set cellSelect(v: boolean) {
        if (this._cellSelect === v) return;
        this._cellSelect = v;
        this.markAllDefinesAsDirty();
    }

    /** Shared screen-aligned card rotation. */
    get billboard(): boolean { return this._billboard; }
    set billboard(v: boolean) {
        if (this._billboard === v) return;
        this._billboard = v;
        this.markAllDefinesAsDirty();
    }

    getClassName(): string { return 'ImpostorUvPlugin'; }

    prepareDefines(defines: AnyDefines): void {
        defines.IMPOSTOR_CELL = this._enabled && this._cellSelect;
        defines.IMPOSTOR_BILLBOARD = this._enabled && this._billboard;
    }

    getAttributes(attributes: string[]): void {
        if (this._enabled && this._cellSelect) attributes.push('impostorCell');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; vertex: string } {
        return {
            ubo: [
                { name: 'uImpostorGrid', size: 2, type: 'vec2' },
                { name: 'uImpostorCols', size: 1, type: 'float' },
                { name: 'uImpostorTopDown', size: 1, type: 'float' },
                { name: 'uImpostorLift', size: 1, type: 'float' },
                { name: 'uBillboardRot', size: 16, type: 'mat4' },
            ],
            vertex: `#if defined(IMPOSTOR_CELL) || defined(IMPOSTOR_BILLBOARD)
                uniform vec2 uImpostorGrid;
                uniform float uImpostorCols;
                uniform float uImpostorTopDown;
                uniform float uImpostorLift;
                uniform mat4 uBillboardRot;
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        if (!this._enabled) return;
        const cols = Math.max(1, this.layout.yawBins);
        const rows = Math.max(1, atlasRowCount(this.layout));
        uniformBuffer.updateFloat2('uImpostorGrid', 1 / cols, 1 / rows);
        uniformBuffer.updateFloat('uImpostorCols', cols);
        uniformBuffer.updateFloat('uImpostorTopDown', this.topDown ? 1.0 : 0.0);
        uniformBuffer.updateFloat('uImpostorLift', this.lift);
        uniformBuffer.updateMatrix('uBillboardRot', this.billboardRotation);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType !== 'vertex') return null;
        return {
            CUSTOM_VERTEX_DEFINITIONS: `#ifdef IMPOSTOR_CELL
                attribute float impostorCell;
            #endif`,
            // Runs before instancesVertex, so positionUpdated / normalUpdated /
            // uvUpdated are all still in LOCAL space here.
            CUSTOM_VERTEX_UPDATE_POSITION: `#ifdef IMPOSTOR_BILLBOARD
                // Lift BEFORE the rotation, so it rotates WITH the card (the
                // card's own local up) rather than along world up. The quad is
                // modelled centred on its origin; shifting it up by half its
                // height first puts its base edge on the origin, and the base
                // then stays pinned to the placement point at every tilt.
                // Lifting after the rotation instead would translate a pitched
                // (near-horizontal) card straight up in world space and leave
                // it hovering one lift above the terrain.
                positionUpdated.y += uImpostorLift;
                positionUpdated = (uBillboardRot * vec4(positionUpdated, 0.0)).xyz;
                #ifdef NORMAL
                    normalUpdated = (uBillboardRot * vec4(normalUpdated, 0.0)).xyz;
                #endif
            #endif
            #if defined(IMPOSTOR_CELL) && defined(UV1)
                float _impCol = mod(impostorCell, uImpostorCols);
                float _impRow = floor(impostorCell / uImpostorCols);
                // Card UVs and atlas rows are BOTH top-down image space (see
                // atlasCellUv + createImpostorCard), so a top-down atlas needs
                // no flip — offset straight by the row. The 1-(row+1) form is
                // the bottom-up-source case only.
                float _impOffV = 1.0 - (_impRow + 1.0) * uImpostorGrid.y;
                if (uImpostorTopDown > 0.5) {
                    _impOffV = _impRow * uImpostorGrid.y;
                }
                uvUpdated = uvUpdated * uImpostorGrid
                          + vec2(_impCol * uImpostorGrid.x, _impOffV);
            #endif`,
        };
    }
}
