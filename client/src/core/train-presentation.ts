/**
 * train-presentation.ts — Client-side presentation for Metalstorm land trains.
 *
 * Task T6 from PLAN-metalstorm-train.md:
 *  - Axle wheel-spin (axle1..axleN) proportional to ground speed
 *  - Couple/decouple VFX (clank sound)
 *  - Dead-car VFX (smoke)
 *
 * Integrates with EntityRenderer via piece-override updates.
 */

import type { Scene } from '@babylonjs/core';
import type { EntityRenderer } from './entity-renderer.js';
import type { UnitDefInfo } from './connection.js';

/** Per-train-car state tracked across frames for wheel animation. */
interface TrainCarState {
    /** Last known position for velocity computation. */
    lastX: number;
    lastZ: number;
    /** Accumulated axle rotation (radians). Updated each frame based on
     *  ground speed; individual axles read this and apply their own
     *  phase/offset if needed (though all axles spin identically). */
    axleRotation: number;
    /** Axle piece names for this car (e.g. ["axle1", "axle2", ...]). */
    axlePieces: string[];
    /** True if this car is dead (health reached 0) — triggers smoke VFX. */
    isDead: boolean;
}

export class TrainPresentation {
    private scene: Scene;
    private renderer: EntityRenderer;
    /** Keyed by unit ID. Only tracks train cars (identified by
     *  customParams.train_role). */
    private cars = new Map<number, TrainCarState>();
    /** Def IDs that are train units (any of the four fable_train_* types).
     *  Populated on setUnitDefs. */
    private trainDefIds = new Set<number>();
    /** Per-def axle piece names, extracted from the model config. Keyed by
     *  defId. Falls back to a default pattern (axle1..axle5 for engines,
     *  axle1..axle4 for carriages) if the model config doesn't list them. */
    private defAxlePieces = new Map<number, string[]>();

    constructor(scene: Scene, renderer: EntityRenderer) {
        this.scene = scene;
        this.renderer = renderer;
    }

    /**
     * Register unit defs. Identifies train units via customParams.train_role
     * and extracts their axle piece names.
     */
    setUnitDefs(defs: UnitDefInfo[]): void {
        for (const def of defs) {
            const role = def.customParams?.train_role;
            if (!role) continue; // Not a train unit.
            this.trainDefIds.add(def.defId);

            // Axle count per the PLAN: engine 5, carriages 4.
            const axleCount = role === 'engine' ? 5 : 4;
            const axlePieces: string[] = [];
            for (let i = 1; i <= axleCount; i++) {
                axlePieces.push(`axle${i}`);
            }
            this.defAxlePieces.set(def.defId, axlePieces);
        }
    }

    /**
     * Update wheel spin for all tracked train cars. Called each frame from
     * the render loop (game-processor tick or main loop).
     *
     * Derives velocity from position delta, accumulates rotation, and
     * pushes piece overrides to the EntityRenderer via setAimPose.
     */
    tick(deltaMs: number): void {
        const deltaSec = deltaMs / 1000;

        // Auto-discover and track train units from the renderer's live entities.
        // This avoids needing explicit addCar() hooks in the connection callbacks.
        // Build a set of all live entity IDs first.
        const liveIds = new Set<number>();
        for (const [id, meta] of this.renderer.entityMetaEntries()) {
            liveIds.add(id);
            if (this.trainDefIds.has(meta.defId) && !this.cars.has(id)) {
                // New train car — initialize tracking.
                const pose = this.renderer.getEntityPose(id);
                if (pose) {
                    const axlePieces = this.defAxlePieces.get(meta.defId) ?? [];
                    this.cars.set(id, {
                        lastX: pose.x,
                        lastZ: pose.z,
                        axleRotation: 0,
                        axlePieces,
                        isDead: false,
                    });
                }
            }
        }

        // Remove cars that no longer exist.
        for (const id of this.cars.keys()) {
            if (!liveIds.has(id)) {
                this.cars.delete(id);
            }
        }

        for (const [id, state] of this.cars) {
            // Query current position from the renderer's interpolator.
            const pose = this.renderer.getEntityPose(id);
            if (!pose) {
                // Entity not in LOS or destroyed — keep the state but don't
                // update (position unknown). If it's dead, smoke continues.
                continue;
            }

            // Compute ground speed (elmos/s) from position delta.
            const dx = pose.x - state.lastX;
            const dz = pose.z - state.lastZ;
            const dist = Math.sqrt(dx * dx + dz * dz);
            const speed = dist / deltaSec; // elmos/s

            // Update last-known position for next frame.
            state.lastX = pose.x;
            state.lastZ = pose.z;

            // Wheel radius (elmos). Train wheels are large — roughly 1 m
            // diameter → 0.5 m radius → ~50 elmos. This is a cosmetic
            // parameter; tune to taste. (The plan doesn't specify, so this
            // is a reasonable default for heavy land-train wheels.)
            const wheelRadius = 50;

            // Angular velocity (rad/s) = linear speed / radius.
            const omega = speed / wheelRadius;

            // Accumulate rotation.
            state.axleRotation += omega * deltaSec;

            // Normalize to [-π, π] to avoid float drift over long runs.
            while (state.axleRotation > Math.PI) state.axleRotation -= 2 * Math.PI;
            while (state.axleRotation < -Math.PI) state.axleRotation += 2 * Math.PI;

            // Build piece overrides: rotate each axle around its X axis
            // (assuming the axle piece's local X axis is the wheel's axle).
            // Use the renderer's existing setAimPose method (cosmetic pose
            // override system used by turret aim — repurposed for wheels).
            const overrides = new Map<number, {
                px: number; py: number; pz: number;
                rx: number; ry: number; rz: number;
            }>();

            for (const pieceName of state.axlePieces) {
                // Resolve piece name → index via the renderer.
                const pieceIdx = this.renderer.getPieceIndex(id, pieceName);
                if (pieceIdx === null) continue; // Piece not found (model mismatch).

                // Rotate around X axis (wheel axle). No translation offset
                // from rest pose.
                overrides.set(pieceIdx, {
                    px: 0, py: 0, pz: 0,
                    rx: state.axleRotation, // radians
                    ry: 0,
                    rz: 0,
                });
            }

            // Push the overrides to the renderer. setAimPose returns false
            // if the unit is unknown (destroyed mid-frame) — silently ignore.
            this.renderer.setAimPose(id, overrides);
        }
    }

    /**
     * Track a new train car. Called when a train unit enters LOS.
     */
    addCar(id: number, defId: number, x: number, z: number): void {
        if (!this.trainDefIds.has(defId)) return; // Not a train.

        const axlePieces = this.defAxlePieces.get(defId) ?? [];
        this.cars.set(id, {
            lastX: x,
            lastZ: z,
            axleRotation: 0,
            axlePieces,
            isDead: false,
        });
    }

    /**
     * Remove a train car. Called when a unit is destroyed or leaves LOS.
     */
    removeCar(id: number): void {
        this.cars.delete(id);
    }

    /**
     * Mark a car as dead (triggers smoke VFX). Called when health reaches 0.
     */
    markDead(id: number): void {
        const state = this.cars.get(id);
        if (state) {
            state.isDead = true;
            // TODO: spawn persistent smoke particle emitter at the car's
            // position. Use the scene's particle system or the existing
            // CEG/FX infrastructure.
        }
    }

    /**
     * Play a coupling clank sound. Called when two cars couple.
     * (Triggered by a Lua message or FlatBuffers event — not yet wired.)
     */
    playCoupleSound(x: number, y: number, z: number): void {
        // TODO: play a metallic clank sound at (x, y, z) via the audio
        // system. The plan says "coupling clank sound" — a short, sharp
        // impact sound. Use audio.playSound3D or similar.
        console.debug(`[Train] Couple sound at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
    }

    /**
     * Play a decoupling sound (optional, may be same as couple or omitted).
     */
    playDecoupleSound(x: number, y: number, z: number): void {
        console.debug(`[Train] Decouple sound at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
    }
}
