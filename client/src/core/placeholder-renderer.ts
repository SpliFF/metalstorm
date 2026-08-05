/**
 * PlaceholderRenderer — wireframe "materialising" box shown for an entity
 * whose real model is still loading (PLAN-lazy-loading.md).
 *
 * Distinct from EntityRenderer's permanent procedural-shape fallback
 * (Box/Cylinder/Cone/Sphere, used for defs that have no model at all): this
 * one is transient, swapped out for the real mesh the instant the def's
 * template resolves. Two thin-instanced meshes per team share one
 * instance-matrix buffer each frame — a wireframe box for the edges and a
 * near-invisible filled box for a sense of mass without occluding terrain
 * — so a loading unit reads as "incoming", not as a solid colored block
 * that later "snaps" into its model.
 */
import { Scene, Mesh, MeshBuilder, StandardMaterial, Color3 } from '@babylonjs/core';

const BOX_SIZE = 16;

export interface PlaceholderMeshes {
    /** Wireframe edges, team-tinted, alpha ~0.6. */
    wire: Mesh;
    /** Translucent fill, team-tinted, alpha ~0.15. */
    fill: Mesh;
}

export class PlaceholderRenderer {
    private scene: Scene;
    private meshes = new Map<number, PlaceholderMeshes>();

    constructor(scene: Scene) {
        this.scene = scene;
    }

    /** Get (creating lazily) the wire+fill mesh pair for `team`. Both start
     *  hidden with zero thin instances — the caller drives visibility and
     *  instance buffers per tick. */
    getMeshes(team: number, teamColor: Color3): PlaceholderMeshes {
        let entry = this.meshes.get(team);
        if (entry) return entry;

        const wire = MeshBuilder.CreateBox(`placeholder_wire_t${team}`, { size: BOX_SIZE }, this.scene);
        wire.position.y = BOX_SIZE / 2;
        wire.bakeCurrentTransformIntoVertices();
        const wireMat = new StandardMaterial(`placeholder_wire_mat_t${team}`, this.scene);
        wireMat.emissiveColor = teamColor;
        wireMat.disableLighting = true;
        wireMat.alpha = 0.6;
        wireMat.wireframe = true;
        wire.material = wireMat;
        wire.isVisible = false;
        wire.isPickable = false;
        wire.thinInstanceEnablePicking = false;
        wire.alwaysSelectAsActiveMesh = true;
        wire.renderingGroupId = 2;

        const fill = MeshBuilder.CreateBox(`placeholder_fill_t${team}`, { size: BOX_SIZE }, this.scene);
        fill.position.y = BOX_SIZE / 2;
        fill.bakeCurrentTransformIntoVertices();
        const fillMat = new StandardMaterial(`placeholder_fill_mat_t${team}`, this.scene);
        fillMat.diffuseColor = Color3.Black();
        fillMat.emissiveColor = teamColor;
        fillMat.disableLighting = true;
        fillMat.alpha = 0.15;
        fillMat.backFaceCulling = false;
        fill.material = fillMat;
        fill.isVisible = false;
        fill.isPickable = false;
        fill.thinInstanceEnablePicking = false;
        fill.alwaysSelectAsActiveMesh = true;
        fill.renderingGroupId = 2;

        entry = { wire, fill };
        this.meshes.set(team, entry);
        return entry;
    }

    dispose(): void {
        for (const { wire, fill } of this.meshes.values()) {
            wire.dispose();
            wire.material?.dispose();
            fill.dispose();
            fill.material?.dispose();
        }
        this.meshes.clear();
    }
}
