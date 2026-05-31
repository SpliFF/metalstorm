/**
 * BuildingPlateRenderer — static under-building ground decals (PLAN-decals.md
 * D5). Buildings paint an authored AO/scorch plate under their footprint while
 * they exist (Recoil's `CGroundDecalHandler::AddSolidObject`), driven by the
 * unitdef `buildingGroundDecalType` / `groundDecalType` fields. The plate is
 * removed when the building dies.
 *
 * This is a distinct lifecycle from scars + tracks (the D7 baked overlay,
 * which is write-once-and-decay): building plates need explicit add-on-create /
 * remove-on-death, so they render as individual alpha-blended ground quads —
 * one per building, keyed by entity id. Building counts are low (tens), so a
 * mesh-per-plate with a shared per-texture material is fine.
 *
 * Faithful to Recoil's sizing: the plate's world half-extent is
 * `groundDecalSize * SQUARE_SIZE`, so the full quad is `2 * size * SQUARE_SIZE`
 * elmos (`GroundDecalHandler.cpp:874` `sizex = groundDecalSizeX * SQUARE_SIZE`,
 * quad spans `midPoint ± (sizex, sizey)`). The plate is centred on the
 * building, rotated to its heading, and pinned to the building's authoritative
 * ground height (the entity's streamed Y).
 *
 * **Deviations from Recoil (documented):**
 * - The quad is flat at the building's centre height — it does not follow
 *   terrain undulation across its footprint. Buildings sit on flattened ground,
 *   so this reads correctly; a heightmap-following quad is a v2 upgrade (same
 *   call the scar pool deferred).
 * - No decay-on-death fade yet — the plate is removed outright when the
 *   building is destroyed (Recoil fades it out over `groundDecalDecaySpeed`).
 */

import {
    Scene,
    Mesh,
    MeshBuilder,
    StandardMaterial,
    Texture,
    Color3,
} from '@babylonjs/core';
import { stampUrl } from '../config.js';
import type { UnitDefInfo } from './connection.js';
import type { EntityStateSnapshot } from './entity-state.js';

const SQUARE_SIZE = 8;

interface PlateDef {
    stem: string; // texture stem, resolved to <stem>.ktx2 under unittextures/
    sx: number;   // half-size in map squares (X)
    sy: number;   // half-size in map squares (Z)
}

export class BuildingPlateRenderer {
    private baseUrl = ''; // `${lobby}/api/games/data/<gameId>/unittextures`
    /** defId → decal definition, for building defs that author a plate. */
    private plateDefs = new Map<number, PlateDef>();
    /** texture stem → shared material (one per distinct decal texture). */
    private materials = new Map<string, StandardMaterial>();
    /** entityId → live plate mesh. */
    private plates = new Map<number, Mesh>();
    /** entityIds we've already handled (placed or knowingly skipped a defless
     *  delta for), so we don't re-place every snapshot. */
    private seen = new Set<number>();

    constructor(private scene: Scene) {}

    /** Point texture resolution at the current game's unittextures route. */
    setGame(gameId: string, lobbyHttpUrl = ''): void {
        if (!gameId) return;
        this.baseUrl = `${lobbyHttpUrl}/api/games/data/${gameId}/unittextures`;
    }

    /** Register building defs that author a ground decal. Additive — called as
     *  defs stream in. */
    setUnitDefs(defs: UnitDefInfo[]): void {
        for (const d of defs) {
            if (d.groundDecal && (d.groundDecalSizeX > 0 || d.groundDecalSizeY > 0)) {
                this.plateDefs.set(d.defId, {
                    stem: d.groundDecal,
                    sx: d.groundDecalSizeX,
                    sy: d.groundDecalSizeY,
                });
            }
        }
    }

    /** Place plates for any newly-seen buildings in this entity-state snapshot.
     *  Uses the entity's streamed Y as the authoritative ground height — no
     *  separate terrain sampler needed. */
    update(snap: EntityStateSnapshot): void {
        const { count, entityIds, positionsX, positionsY, positionsZ, headings, defIds } = snap;
        // defIds is null on position-only delta frames — can't classify those,
        // so skip; the building will be placed on the next full snapshot.
        if (!entityIds || !defIds || !positionsX || !positionsY || !positionsZ) return;

        for (let i = 0; i < count; i++) {
            const id = entityIds[i];
            if (this.seen.has(id)) continue;
            const def = this.plateDefs.get(defIds[i]);
            if (!def) continue; // not a decal building (or def not yet known)
            this.seen.add(id);
            this.placePlate(
                id, positionsX[i], positionsY[i], positionsZ[i],
                headings ? headings[i] : 0, def);
        }
    }

    /** Remove a building's plate (on death). No-op if it had none. */
    remove(entityId: number): void {
        const plate = this.plates.get(entityId);
        if (plate) {
            plate.dispose();
            this.plates.delete(entityId);
        }
        this.seen.delete(entityId);
    }

    private placePlate(
        id: number, x: number, y: number, z: number,
        heading: number, def: PlateDef,
    ): void {
        // Recoil full extent = 2 * size * SQUARE_SIZE (half-extent = size*SS).
        const width = 2 * def.sx * SQUARE_SIZE;
        const depth = 2 * def.sy * SQUARE_SIZE;
        if (width <= 0 || depth <= 0) return;

        const plate = MeshBuilder.CreateGround(
            `bplate_${id}`, { width, height: depth }, this.scene);
        plate.material = this.getMaterial(def.stem);
        // +0.3 elmo lift + material zOffset together keep the flat quad above
        // the terrain without visible z-fighting at far zoom.
        plate.position.set(x, y + 0.3, z);
        plate.rotation.y = (heading / 65535) * Math.PI * 2;
        plate.isPickable = false;
        plate.receiveShadows = false;
        // Render after terrain (group 0), before units (group 2). Low
        // alphaIndex puts it ahead of the LOS fog overlay (alphaIndex 100).
        plate.renderingGroupId = 1;
        plate.alphaIndex = 10;
        this.plates.set(id, plate);
    }

    private getMaterial(stem: string): StandardMaterial {
        const existing = this.materials.get(stem);
        if (existing) return existing;

        const mat = new StandardMaterial(`bplateMat_${stem}`, this.scene);
        const tex = new Texture(
            stampUrl(`${this.baseUrl}/${stem}.ktx2`), this.scene,
            false /* noMipmap */, false /* invertY: ground UVs already top-down */,
            Texture.TRILINEAR_SAMPLINGMODE);
        tex.hasAlpha = true;
        tex.wrapU = Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = Texture.CLAMP_ADDRESSMODE;
        mat.diffuseTexture = tex;
        // AO/scorch planes are RGBA — alpha is the coverage mask. Drive opacity
        // from the same texture's alpha so the plate blends over terrain rather
        // than drawing an opaque square.
        mat.opacityTexture = tex;
        mat.specularColor = new Color3(0, 0, 0);
        mat.backFaceCulling = false;
        // Don't write depth — units/effects behind the plate must read the
        // terrain depth, and overlapping plates shouldn't fight each other.
        mat.disableDepthWrite = true;
        // Pull slightly toward the camera in the depth test to beat z-fight
        // against the terrain it sits on.
        mat.zOffset = -2;
        this.materials.set(stem, mat);
        return mat;
    }

    /** Tear everything down (game end / restart). */
    dispose(): void {
        for (const p of this.plates.values()) p.dispose();
        this.plates.clear();
        for (const m of this.materials.values()) {
            m.diffuseTexture?.dispose();
            m.dispose();
        }
        this.materials.clear();
        this.plateDefs.clear();
        this.seen.clear();
    }
}
