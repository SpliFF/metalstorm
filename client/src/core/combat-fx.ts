/**
 * CombatFX — client-side combat visual effects.
 *
 * Renders transient effects (tracers, impacts, muzzle flashes) in
 * response to CombatEvent messages from the server. Effects are
 * time-limited particle-like meshes that auto-dispose.
 *
 * Phase 3 implementation: simple geometric effects.
 * Later phases will add proper particle systems, shaders, etc.
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    StandardMaterial,
    Color3,
    Vector3,
} from '@babylonjs/core';
import type { CombatEventInfo, ProjectileImpactInfo } from './connection.js';
import { AudioManager } from './audio.js';

/// Mirrors SpringWeb::ProjectileImpactKind in protocol.fbs.
const enum ImpactKind {
    Terrain = 0,
    Unit = 1,
    Feature = 2,
    Shield = 3,
    SelfDetonate = 4,
    Intercepted = 5,
    Other = 6,
}

/** An active visual effect with a remaining lifetime. */
interface ActiveEffect {
    mesh: Mesh;
    lifetime: number;    // seconds remaining
    velocity?: Vector3;  // for moving effects (tracers)
}

export class CombatFX {
    private scene: Scene;
    private audio: AudioManager | null;
    private effects: ActiveEffect[] = [];

    // Shared materials
    private impactMat: StandardMaterial;
    private tracerMat: StandardMaterial;
    private killMat: StandardMaterial;
    private shieldMat: StandardMaterial;
    private dirtMat: StandardMaterial;

    /// Once-per-kind warning gate so we don't spam the console every
    /// frame for unwired sound categories.
    private warnedKinds = new Set<string>();

    constructor(scene: Scene, audio?: AudioManager) {
        this.scene = scene;
        this.audio = audio ?? null;

        this.impactMat = new StandardMaterial('impactFxMat', scene);
        this.impactMat.diffuseColor = new Color3(1.0, 0.6, 0.1);
        this.impactMat.emissiveColor = new Color3(0.8, 0.4, 0.0);

        this.tracerMat = new StandardMaterial('tracerFxMat', scene);
        this.tracerMat.diffuseColor = new Color3(1.0, 1.0, 0.5);
        this.tracerMat.emissiveColor = new Color3(1.0, 0.9, 0.3);

        this.killMat = new StandardMaterial('killFxMat', scene);
        this.killMat.diffuseColor = new Color3(1.0, 0.2, 0.0);
        this.killMat.emissiveColor = new Color3(1.0, 0.3, 0.0);

        this.shieldMat = new StandardMaterial('shieldFxMat', scene);
        this.shieldMat.diffuseColor = new Color3(0.4, 0.6, 1.0);
        this.shieldMat.emissiveColor = new Color3(0.4, 0.7, 1.0);
        this.shieldMat.alpha = 0.6;

        this.dirtMat = new StandardMaterial('dirtFxMat', scene);
        this.dirtMat.diffuseColor = new Color3(0.45, 0.35, 0.25);
        this.dirtMat.emissiveColor = new Color3(0.0, 0.0, 0.0);
    }

    /// React to a projectile lifecycle Impact event. Combat-fx already
    /// fires explosions for hits/kills via CombatEvent (which carries
    /// damage info), so this only fires VFX for impacts the combat path
    /// doesn't cover: terrain hits, feature hits, shield blocks, self-
    /// detonations. Unit hits are skipped here — the matching CombatEvent
    /// arrives in the same batch and drives a more informative explosion.
    onProjectileImpacts(events: ProjectileImpactInfo[]): void {
        for (const e of events) {
            const { x, y, z } = e.pos;
            switch (e.impactKind as ImpactKind) {
                case ImpactKind.Terrain:
                    this.spawnTerrainImpact(x, y, z);
                    break;
                case ImpactKind.Feature:
                    this.spawnTerrainImpact(x, y, z);
                    break;
                case ImpactKind.Shield:
                    this.spawnShieldRipple(x, y, z);
                    break;
                case ImpactKind.SelfDetonate:
                case ImpactKind.Other:
                    this.spawnAirburst(x, y, z);
                    break;
                case ImpactKind.Intercepted:
                    this.spawnAirburst(x, y, z);
                    break;
                case ImpactKind.Unit:
                    // CombatEvent will spawn the explosion with damage info.
                    break;
            }
        }
    }

    private spawnTerrainImpact(x: number, y: number, z: number): void {
        const mesh = MeshBuilder.CreateSphere(
            'dirt', { diameter: 8, segments: 4 }, this.scene);
        mesh.position.set(x, y + 1, z);
        mesh.material = this.dirtMat;
        this.effects.push({ mesh, lifetime: 0.25 });
        // Audio for terrain/feature impacts is emitted server-side as
        // the weapon's soundHitDry/soundHitWet SoundEvent
        // (WeaponProjectile::Explode). No client-side sound needed.
    }

    private spawnShieldRipple(x: number, y: number, z: number): void {
        const mesh = MeshBuilder.CreateSphere(
            'shieldHit', { diameter: 16, segments: 8 }, this.scene);
        mesh.position.set(x, y, z);
        mesh.material = this.shieldMat;
        this.effects.push({ mesh, lifetime: 0.4 });
        this.reportMissingSound('shield-hit');
    }

    private spawnAirburst(x: number, y: number, z: number): void {
        const mesh = MeshBuilder.CreateSphere(
            'airburst', { diameter: 12, segments: 6 }, this.scene);
        mesh.position.set(x, y, z);
        mesh.material = this.impactMat;
        this.effects.push({ mesh, lifetime: 0.3 });
        this.reportMissingSound('airburst');
    }

    /**
     * Process a batch of combat events from the server.
     * Creates visual effects for each event.
     */
    onCombatEvents(events: CombatEventInfo[]): void {
        for (const evt of events) {
            switch (evt.result) {
                case 0: // Hit
                    this.spawnImpact(evt.x, evt.y, evt.z, evt.damage);
                    break;
                case 3: // Kill
                    this.spawnExplosion(evt.x, evt.y, evt.z);
                    break;
                // Miss (1) and Blocked (2) — no visual for now
            }
        }
    }

    /** Spawn an impact flash at a position. */
    private spawnImpact(x: number, y: number, z: number, damage: number): void {
        const size = Math.min(4 + damage * 0.02, 20);
        const mesh = MeshBuilder.CreateSphere(
            'impact', { diameter: size, segments: 4 }, this.scene);
        mesh.position.set(x, y + 2, z);
        mesh.material = this.impactMat;

        this.effects.push({ mesh, lifetime: 0.15 });
        // Hit audio is the weapon's soundHitDry/soundHitWet SoundEvent
        // emitted by Unit::DoDamage. Nothing to play here.
    }

    /** Spawn an explosion effect (for kills). */
    private spawnExplosion(x: number, y: number, z: number): void {
        const mesh = MeshBuilder.CreateSphere(
            'explosion', { diameter: 30, segments: 6 }, this.scene);
        mesh.position.set(x, y + 5, z);
        mesh.material = this.killMat;

        this.effects.push({ mesh, lifetime: 0.5 });
        // Kill audio is the same weapon soundHit SoundEvent that the
        // hit case uses, emitted by Unit::DoDamage with priority 192
        // (vs 128 for non-fatal hits). Nothing to play here.
    }

    /// Log once per impact kind that has no server SoundEvent wired.
    /// Used for Shield / SelfDetonate / Intercepted / Other — the
    /// server's projectile-impact path doesn't currently emit a sound
    /// for these. Hit / Kill / Terrain / Feature impacts already get
    /// the weapon's soundHit through the regular SoundEvent stream.
    private reportMissingSound(kind: string): void {
        if (this.warnedKinds.has(kind)) return;
        this.warnedKinds.add(kind);
        console.error(
            `[combat-fx] no server SoundEvent for '${kind}'; ` +
            'wire the emission server-side (Sim/Projectiles impact path).');
    }

    /**
     * Update all active effects. Call every frame with delta time.
     * @param dt Delta time in seconds
     */
    tick(dt: number): void {
        for (let i = this.effects.length - 1; i >= 0; i--) {
            const fx = this.effects[i];
            fx.lifetime -= dt;

            if (fx.lifetime <= 0) {
                fx.mesh.dispose();
                this.effects.splice(i, 1);
                continue;
            }

            // Fade out by scaling down
            const t = Math.max(fx.lifetime * 4, 0); // 0.25s → scale 0..1
            const scale = Math.min(t, 1);
            fx.mesh.scaling.setAll(scale);

            // Move if it has velocity
            if (fx.velocity) {
                fx.mesh.position.addInPlace(fx.velocity.scale(dt));
            }
        }
    }

    get activeCount(): number {
        return this.effects.length;
    }

    dispose(): void {
        for (const fx of this.effects) {
            fx.mesh.dispose();
        }
        this.effects = [];
        this.impactMat.dispose();
        this.tracerMat.dispose();
        this.killMat.dispose();
        this.shieldMat.dispose();
        this.dirtMat.dispose();
    }
}
