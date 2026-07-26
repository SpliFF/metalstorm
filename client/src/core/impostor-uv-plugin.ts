/**
 * ImpostorUvPlugin — remaps a billboard quad's UVs into one directional-atlas
 * cell, in the VERTEX shader, from a per-instance `cellIndex` attribute
 * (PLAN-metalstorm-impostors.md §"Frame selection", M3). Sibling of
 * TeamColorPlugin; the two coexist on the impostor material.
 *
 * Why the vertex stage / vMainUV1: PBRMaterial samples the albedo (diffuse +
 * alpha) from `vMainUV1`, and TeamColorPlugin samples the team mask from the
 * SAME varying. Rewriting `vMainUV1` at CUSTOM_VERTEX_MAIN_END therefore
 * remaps every sampler at once — the alpha-test silhouette, the colour, and
 * the team tint all read the selected cell with no per-sampler duplication.
 *
 * The grid (yawBins × atlasRows, atlasRows = pitchBins·frames) rides the
 * material UBO (`uImpYawBins` / `uImpAtlasRows`), bound per render — the same
 * pattern TeamColorPlugin uses. (Baking them as shader literals in
 * getCustomCode is unsafe: Babylon calls getCustomCode during the plugin's
 * super() constructor for injection-point discovery, before the class fields
 * initialise, so the values aren't set yet.) The packed index convention
 * matches impostor-atlas.ts `packCellIndex`: `col = mod(idx, yawBins)`,
 * `row = floor(idx / yawBins)`.
 *
 * FIDELITY note (recorded per the lane directive): this remap runs in the
 * material's own vertex shader, which drives the colour pass. It does NOT
 * reach Babylon's separate shadow-map depth shader, so a directional impostor
 * added as a shadow caster would cast the whole-atlas silhouette (all cells
 * overlaid), not the selected cell. The renderers therefore do not register
 * directional-atlas impostors as shadow casters — a soldier sprite only shows
 * at ≳900 elmos (≲20 px), where its cast shadow is sub-pixel and the loss is
 * imperceptible. Legacy single-cell (1×1) atlases are unaffected and still
 * cast normally.
 */

import { MaterialPluginBase, Material } from '@babylonjs/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefines = any;

export class ImpostorUvPlugin extends MaterialPluginBase {
    /** Atlas columns (yaw bins). */
    yawBins = 1;
    /** Atlas rows = pitchBins · frames (frames stack downward). */
    atlasRows = 1;

    constructor(material: Material) {
        // priority 95: before TeamColor (100); stages don't overlap anyway.
        super(material, 'ImpostorUv', 95, { IMPOSTOR_UV: false });
        this._enable(true);
    }

    prepareDefines(defines: AnyDefines): void {
        defines.IMPOSTOR_UV = this.yawBins * this.atlasRows > 1;
    }

    getClassName(): string { return 'ImpostorUvPlugin'; }

    getAttributes(attributes: string[]): void {
        // The per-instance cell selector, uploaded via
        // thinInstanceSetBuffer('cellIndex', …, 1).
        attributes.push('cellIndex');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; vertex: string } {
        return {
            ubo: [
                { name: 'uImpYawBins', size: 1, type: 'float' },
                { name: 'uImpAtlasRows', size: 1, type: 'float' },
            ],
            vertex: `#ifdef IMPOSTOR_UV
                uniform float uImpYawBins;
                uniform float uImpAtlasRows;
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        uniformBuffer.updateFloat('uImpYawBins', this.yawBins);
        uniformBuffer.updateFloat('uImpAtlasRows', this.atlasRows);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType !== 'vertex') return null;
        return {
            CUSTOM_VERTEX_DEFINITIONS: `#ifdef IMPOSTOR_UV
                attribute float cellIndex;
            #endif`,
            // vMainUV1 holds the quad's raw 0..1 UV here (identity texture
            // matrix). Shift it into the (col,row) cell, then scale to cell
            // size. Same top-origin row order as impostor_convention.cell_origin.
            // `idx + 0.5` is a precision-safe integer round before mod/floor
            // (cellIndex is an integer carried as a float attribute).
            CUSTOM_VERTEX_MAIN_END: `#ifdef IMPOSTOR_UV
                float _impIdx = cellIndex + 0.5;
                float _impCol = floor(mod(_impIdx, uImpYawBins));
                float _impRow = floor(_impIdx / uImpYawBins);
                vMainUV1 = (vec2(_impCol, _impRow) + vMainUV1) * vec2(1.0 / uImpYawBins, 1.0 / uImpAtlasRows);
            #endif`,
        };
    }
}
