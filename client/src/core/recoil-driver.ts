/**
 * RecoilDriver — per-slot weapon recoil kick (PLAN-beta-presentation.md
 * L-ANIM). Rides the same `AimFiredEvent`/`AimVolleyEvent` channel
 * `TurretAimController` already consumes: no new wire, no new renderer API.
 * `TurretAimController` owns one instance privately and adds its output to
 * the barrel's (or, absent a barrel, the turret's) `pz` in the SAME
 * Spring-euler pose merge the aim slew already produces.
 *
 * ## Why a velocity impulse, not a step displacement
 *
 * A shot doesn't teleport the barrel back and ease it forward — it gives it
 * a backward *velocity* that a stiff spring immediately fights. Modelled as
 * the impulse response of a critically damped spring toward rest (0):
 *
 *     x(t) = v0 · t · e^(-ωt)
 *
 * which rises to a peak at t = 1/ω then eases back to exactly 0 — a kick,
 * not a snap. Solving for the v0 that gives a desired peak displacement
 * `peak` at t = 1/ω: v0 = peak · ω · e. `ω` is picked from the desired
 * settle time (`recoilReturnMs`) via `SETTLE_OMEGA_T`, the point on the
 * impulse-response envelope (ωt·e^-ωt) that has decayed to <1% of peak —
 * past that the recoil reads as done regardless of the 300ms test window.
 *
 * Advancing the spring uses the EXACT analytic solution for the interval,
 * not iterative Euler integration — stable for any `dtSec` including 0 (an
 * identity, not a division), and immune to the blow-up a naive spring
 * integrator suffers at a large frame gap.
 */

const SIM_FPS = 30;

/** Kick-displacement clamp (elmos) along the barrel's local axis — a
 *  readable nudge on a gun-sized piece, never a caricature punch. */
const MIN_KICK_ELMOS = 0.12;
const MAX_KICK_ELMOS = 1.6;

/** Settle-time clamp (ms), per the brief. */
const MIN_RETURN_MS = 60;
const MAX_RETURN_MS = 140;

/** ωt at which the impulse-response envelope ωt·e^-ωt has decayed to ~0.7%
 *  of its peak — "settled" for `recoilReturnMs`'s purposes. */
const SETTLE_OMEGA_T = 8;

/** Below this the spring is dropped rather than kept ticking forever on an
 *  exponential tail that never quite reaches exact 0. */
const REST_EPS = 1e-4;

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/** Peak recoil displacement (elmos) for a shot, from the fired weapon's
 *  `aoe` (elmos) and `projectileSpeed` (elmos/sim-frame) — both crude but
 *  available proxies for the round's momentum. Pure, so weapon-fx-resolver-
 *  style tests can assert on it directly. */
export function recoilKickElmos(aoe: number, projectileSpeedPerFrame: number): number {
    const velocityPerSec = Math.max(0, projectileSpeedPerFrame) * SIM_FPS;
    const raw = Math.sqrt(Math.max(0, aoe)) * 0.06 + velocityPerSec * 0.0006;
    return clamp(raw, MIN_KICK_ELMOS, MAX_KICK_ELMOS);
}

/** Settle time (ms) for a given peak kick — bigger kicks return slightly
 *  slower, within the brief's 60–140ms band. */
export function recoilReturnMs(peakElmos: number): number {
    const t = clamp((peakElmos - MIN_KICK_ELMOS) / (MAX_KICK_ELMOS - MIN_KICK_ELMOS), 0, 1);
    return MIN_RETURN_MS + t * (MAX_RETURN_MS - MIN_RETURN_MS);
}

interface Spring {
    /** Displacement along the kick axis (elmos); positive = pushed back. */
    x: number;
    v: number;
    /** Natural frequency (rad/s) in force for this spring, set by the most
     *  recent kick — re-kicking mid-recoil keeps the spring's current x/v
     *  (a fast-firing weapon's kicks stack) but adopts the new ω. */
    omega: number;
}

export class RecoilDriver {
    private springs = new Map<string, Spring>();

    /** Impart a recoil kick, keyed by caller (`TurretAimController` uses
     *  `unitId:slot`). `aoe`/`projectileSpeedPerFrame` come straight off the
     *  fired weapon's def. */
    kick(key: string, aoe: number, projectileSpeedPerFrame: number): void {
        const peak = recoilKickElmos(aoe, projectileSpeedPerFrame);
        const omega = SETTLE_OMEGA_T / (recoilReturnMs(peak) / 1000);
        const v0 = peak * omega * Math.E;
        const s = this.springs.get(key);
        if (s) { s.v += v0; s.omega = omega; }
        else this.springs.set(key, { x: 0, v: v0, omega });
    }

    /** Advance every tracked spring by `dtSec` (0 is a no-op identity — never
     *  NaN, never a division) using the exact per-interval analytic solution,
     *  and drop springs that have settled back to rest. */
    tick(dtSec: number): void {
        if (dtSec <= 0) return;
        for (const [key, s] of this.springs) {
            const decay = Math.exp(-s.omega * dtSec);
            const c1 = s.x;
            const c2 = s.v + s.omega * s.x;
            const nx = (c1 + c2 * dtSec) * decay;
            const nv = (c2 - s.omega * c1 - s.omega * c2 * dtSec) * decay;
            if (Math.abs(nx) < REST_EPS && Math.abs(nv) < REST_EPS) {
                this.springs.delete(key);
                continue;
            }
            s.x = nx;
            s.v = nv;
        }
    }

    /** Current displacement (elmos) along the kick axis for `key`, 0 if
     *  nothing is tracked (never kicked, or already settled). */
    offset(key: string): number {
        return this.springs.get(key)?.x ?? 0;
    }

    clear(key: string): void {
        this.springs.delete(key);
    }

    reset(): void {
        this.springs.clear();
    }

    /** Live spring count — debug/test view. */
    get size(): number {
        return this.springs.size;
    }
}
