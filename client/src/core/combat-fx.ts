/**
 * CombatFX — client-side combat visual effects.
 *
 * Renders transient effects (impacts, kills, shields) in response to
 * CombatEvent and ProjectileImpact messages from the server.
 *
 * The fast path dispatches into `CegRuntime` keyed by the weapon def's
 * authored `explosionGenerator` (or an archetype fallback). When no
 * CEG can be resolved we fall back to a coloured procedural sphere so
 * something is still visible — the user can grep the console for
 * `[combat-fx] CEG fallback` to find weapon defs missing CEG coverage.
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
import type { CegRuntime } from './ceg-runtime.js';
import type { DefCache } from './def-cache.js';
import type { FxLightPool } from './fx-light-pool.js';
import {
    ImpactKind,
    effectForImpact,
    impactContextFlags,
} from './weapon-fx-dispatch.js';

/** An active visual effect with a remaining lifetime. */
interface ActiveEffect {
    mesh: Mesh;
    lifetime: number;    // seconds remaining
    velocity?: Vector3;  // for moving effects (tracers)
}

export class CombatFX {
    private scene: Scene;
    private audio: AudioManager | null;
    private cegRuntime: CegRuntime | null;
    private defCache: DefCache | null;
    private lightPool: FxLightPool | null = null;
    private effects: ActiveEffect[] = [];

    // Procedural fallback materials. Used only when CEG dispatch
    // can't resolve a name for the weapon def — keeps something on
    // screen rather than dropping silently.
    private impactMat: StandardMaterial;
    private killMat: StandardMaterial;
    private shieldMat: StandardMaterial;
    private dirtMat: StandardMaterial;

    /// One-shot warning state per weapon def so a single missing CEG
    /// doesn't flood the console every frame the weapon fires.
    private warnedFallback = new Set<number>();
    /// Once-per-kind warning gate for unwired sound categories.
    private warnedKinds = new Set<string>();

    constructor(
        scene: Scene,
        audio?: AudioManager,
        cegRuntime?: CegRuntime | null,
        defCache?: DefCache | null,
    ) {
        this.scene = scene;
        this.audio = audio ?? null;
        this.cegRuntime = cegRuntime ?? null;
        this.defCache = defCache ?? null;

        this.impactMat = new StandardMaterial('impactFxMat', scene);
        this.impactMat.diffuseColor = new Color3(1.0, 0.6, 0.1);
        this.impactMat.emissiveColor = new Color3(0.8, 0.4, 0.0);

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

    /// Set / replace the CEG runtime reference. Used when the runtime
    /// is created after CombatFX (init order in main.ts) or rebuilt
    /// for a new game session.
    setCegRuntime(runtime: CegRuntime | null): void {
        this.cegRuntime = runtime;
    }

    setDefCache(defCache: DefCache | null): void {
        this.defCache = defCache;
    }

    setLightPool(pool: FxLightPool | null): void {
        this.lightPool = pool;
    }

    /// Pick a dynamic-light colour for a weapon's explosion. Uses the
    /// weapon def's authored projectile colour when it has one; otherwise
    /// a warm blast orange. Explosions read warm regardless, so even a
    /// blue-bolt weapon gets a colour biased toward its hue but never
    /// fully desaturated.
    private weaponLightColor(weaponDefId: number): [number, number, number] {
        const def = (weaponDefId && this.defCache)
            ? this.defCache.getWeaponDef(weaponDefId) : undefined;
        if (def && (def.colorR > 0 || def.colorG > 0 || def.colorB > 0)) {
            return [def.colorR, def.colorG, def.colorB];
        }
        return [1.0, 0.7, 0.35];
    }

    /// React to a projectile lifecycle Impact event. The projectile
    /// renderer also fires impact CEGs through its own dispatcher
    /// (for impacts not associated with a unit kill / damage event);
    /// combat-fx covers the cases that bypass that path — shield
    /// deflections and self-detonate / interception bursts.
    onProjectileImpacts(events: ProjectileImpactInfo[]): void {
        for (const e of events) {
            const { x, y, z } = e.pos;
            switch (e.impactKind as ImpactKind) {
                case ImpactKind.Shield:
                    if (!this.spawnCegImpact(e.impactKind, e.weaponDefId, x, y, z, true)) {
                        this.spawnFallbackShield(x, y, z);
                    }
                    this.reportMissingSound('shield-hit');
                    break;
                case ImpactKind.SelfDetonate:
                case ImpactKind.Intercepted:
                case ImpactKind.Other:
                    if (!this.spawnCegImpact(e.impactKind, e.weaponDefId, x, y, z, true)) {
                        this.spawnFallbackAirburst(x, y, z);
                    }
                    this.lightPool?.emitExplosion(x, y, z,
                        this.weaponLightColor(e.weaponDefId), 60);
                    this.reportMissingSound('airburst');
                    break;
                // Terrain/Feature/Unit impacts are handled by the
                // projectile renderer's own onImpact hook — see
                // projectile-renderer.ts spawn-impact dispatch.
                case ImpactKind.Terrain:
                case ImpactKind.Feature:
                case ImpactKind.Unit:
                    break;
            }
        }
    }

    /**
     * Process a batch of CombatEvents from the server. Damage / kill
     * events drive the explosion CEG keyed by the firing weapon def.
     */
    onCombatEvents(events: CombatEventInfo[]): void {
        for (const evt of events) {
            switch (evt.result) {
                case 0: // Hit (damage applied, target survives)
                    // Light "impact" CEG on top of the unit. CEG dispatch
                    // is forced (forceWeaponDispatch=true) since the
                    // impact kind is Unit and the default behaviour is
                    // to skip Unit impacts in the projectile renderer.
                    if (!this.spawnCegImpact(ImpactKind.Unit, evt.weaponDefId,
                        evt.x, evt.y, evt.z, true, evt.damage)) {
                        this.spawnFallbackImpact(evt.x, evt.y, evt.z, evt.damage);
                    }
                    // Small impact light, radius scaled by damage.
                    this.lightPool?.emitExplosion(evt.x, evt.y, evt.z,
                        this.weaponLightColor(evt.weaponDefId),
                        Math.min(40 + evt.damage * 0.3, 120));
                    break;
                case 3: // Kill
                    if (!this.spawnCegImpact(ImpactKind.Unit, evt.weaponDefId,
                        evt.x, evt.y, evt.z, true, evt.damage)) {
                        this.spawnFallbackExplosion(evt.x, evt.y, evt.z);
                    }
                    // Bigger kill burst.
                    this.lightPool?.emitExplosion(evt.x, evt.y, evt.z,
                        this.weaponLightColor(evt.weaponDefId), 160);
                    break;
                // Miss (1) and Blocked (2) — no visual.
            }
        }
    }

    /// Resolve the weapon-def CEG and spawn through the runtime.
    /// Returns true if a CEG was dispatched, false if the caller
    /// should fall back to a procedural mesh.
    private spawnCegImpact(
        impactKind: number,
        weaponDefId: number,
        x: number, y: number, z: number,
        forceWeaponDispatch: boolean,
        damage: number = 0,
    ): boolean {
        if (!this.cegRuntime) return false;
        const def = (weaponDefId && this.defCache)
            ? this.defCache.getWeaponDef(weaponDefId) : undefined;
        const name = effectForImpact(impactKind, def, forceWeaponDispatch);
        if (!name) return false;

        const flags = impactContextFlags(impactKind, y);
        // Direction: explosions ascend (0,1,0). The CEG translator's
        // particle direction maths multiplies by velocity so the
        // upward bias gives plausible debris arcs without a real
        // surface normal.
        this.cegRuntime.spawn(name, x, y + 1, z, 0, 1, 0, damage, flags);

        // First time we successfully dispatch for a weaponDef remove
        // it from the warned-fallback set so a later regression flags
        // again cleanly. Cheap; happens once per def.
        this.warnedFallback.delete(weaponDefId);
        return true;
    }

    private spawnFallbackImpact(x: number, y: number, z: number, damage: number): void {
        const size = Math.min(4 + damage * 0.02, 20);
        const mesh = MeshBuilder.CreateSphere(
            'impact', { diameter: size, segments: 4 }, this.scene);
        mesh.position.set(x, y + 2, z);
        mesh.material = this.impactMat;
        this.effects.push({ mesh, lifetime: 0.15 });
    }

    private spawnFallbackExplosion(x: number, y: number, z: number): void {
        const mesh = MeshBuilder.CreateSphere(
            'explosion', { diameter: 30, segments: 6 }, this.scene);
        mesh.position.set(x, y + 5, z);
        mesh.material = this.killMat;
        this.effects.push({ mesh, lifetime: 0.5 });
    }

    private spawnFallbackShield(x: number, y: number, z: number): void {
        const mesh = MeshBuilder.CreateSphere(
            'shieldHit', { diameter: 16, segments: 8 }, this.scene);
        mesh.position.set(x, y, z);
        mesh.material = this.shieldMat;
        this.effects.push({ mesh, lifetime: 0.4 });
    }

    private spawnFallbackAirburst(x: number, y: number, z: number): void {
        const mesh = MeshBuilder.CreateSphere(
            'airburst', { diameter: 12, segments: 6 }, this.scene);
        mesh.position.set(x, y, z);
        mesh.material = this.impactMat;
        this.effects.push({ mesh, lifetime: 0.3 });
    }

    /// Log once per impact kind that has no server SoundEvent wired.
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
        this.killMat.dispose();
        this.shieldMat.dispose();
        this.dirtMat.dispose();
    }
}
