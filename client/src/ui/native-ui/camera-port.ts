/**
 * camera-port.ts — the camera, as a port a sentence can reach
 * (PLAN-metalstorm-command-language.md §6.2, milestone M3)
 *
 * "Zoom to sector B9" · "show me the whole map" · "follow Chimera Platoon".
 *
 * There is no main-thread camera any more: since the GW8 worker split the RTS
 * camera lives inside the game-processor worker, and the only way to move it
 * from main is the `workerCall` request channel (`gp:test` → `gpTestDispatch`)
 * that `test-harness.ts` drives. So this port is written over EXACTLY those ops
 * — `focusOn`, `cameraFitMap`, `cameraSnapToUnit`, `cameraOrbit`,
 * `cameraSaveSlot`/`cameraLoadSlot`, and the cached `cameraPose` feed. Nothing
 * here re-implements camera maths; the worker camera stays the single authority
 * on framing, clamping and animation.
 *
 * `client/src/core/camera-window-api.ts` is deliberately NOT revived. It is a
 * pre-GW8 `window.camera` surface that was never installed (it takes a live
 * `RTSCamera` instance, which no longer exists on this thread) — resurrecting it
 * would mean porting a dead file rather than writing the four calls the command
 * language actually needs.
 *
 * ── Why the methods are synchronous ──
 * `workerCall` returns a promise, but every op here is a fire-and-forget
 * instruction: the sentence is already acknowledged in the transcript, and the
 * animation completes in the worker whether or not main awaits it. Keeping the
 * port sync is what lets `nl-executor.ts` stay sync (see its header) — the one
 * place a worker answer genuinely matters is `snapToUnit`, whose reply says
 * whether the unit had a client-side position, and that is reported through
 * `onNote` rather than by making the whole command language async.
 *
 * ── Follow, and why it must be escapable ──
 * The worker has no follow mode (its tracking camera was deferred in GW8 —
 * `setTrackingCamera` no-ops), so `follow` is an interval loop here that
 * re-snaps to the target's live centroid. A follow the player cannot escape is
 * worse than no follow at all, so it cancels on ANY of:
 *   1. another camera action (focus / fitMap / zoom / loadView / a new follow),
 *   2. player camera input — `CameraInput` (main) is what forwards
 *      `gp:wheel` / `gp:pointerdown` / `gp:keydown` to the worker camera, so it
 *      is also where "the player just moved the camera" is observable; it calls
 *      the `onUserInput` listener this port registers,
 *   3. pose divergence — the camera's look-at drifting from where we last put
 *      it. This is the backstop that catches the input paths signal (2) cannot
 *      see: edge-scroll happens entirely inside the worker's per-frame tick off
 *      a pointer position we already forwarded, so no discrete event marks it.
 *      Divergence catches it within one tick, and would catch any future input
 *      path too, without this file having to know it exists.
 */

import type { NLCameraAction } from './nl-envelope.js';
import type { NamedEntity } from './named-entity-index.js';
import type { Resolution } from './nl-resolver.js';

/** The camera pose as the worker reports it (`cameraPose`). */
export interface CameraPose {
    pos: { x: number; y: number; z: number };
    lookAt: { x: number; y: number; z: number };
}

export interface CameraPortDeps {
    /**
     * Issue a worker op. Fire-and-forget: the port never awaits, but a rejected
     * call (no worker, torn-down session) must not become an unhandled
     * rejection, so the implementation passed in by `main.ts` swallows and logs.
     */
    call(method: string, args?: unknown[]): void;
    /** Current pose from the cached `gp:sceneState` feed. Null before the first. */
    pose(): CameraPose | null;
    /**
     * Register a "the player moved the camera" listener; returns an
     * unsubscribe. Optional: without it, follow still cancels on divergence,
     * one tick later.
     */
    onUserInput?(listener: () => void): () => void;
    /** Diagnostics the console can surface ("no position for that unit yet"). */
    onNote?(note: string): void;
    /**
     * Called once per follow tick (and once when a follow starts), so whoever
     * supplies the target's position can keep its source fresh.
     *
     * This exists because of a bug found live: the console's group-centroid
     * lookup reads the LOS-filtered census, and the census only refreshes when a
     * sentence is submitted. A follow therefore tracked a snapshot frozen at the
     * moment it was asked for — the camera snapped once and then sat still while
     * the squad drove 900 elmos away.
     *
     * A hook rather than a timer here: the refresh happens only while a follow is
     * actually running, and there is no polling lifecycle to leak. It is
     * fire-and-forget, so the fresh data lands in time for the NEXT tick — a
     * 400 ms lag behind a squad moving at RTS speeds, which is invisible.
     */
    onFollowTick?(): void;
}

/** Something to keep the camera on. `position()` is re-read every tick, so a
 *  moving squad is tracked rather than a stale centroid re-visited. */
export interface FollowTarget {
    label: string;
    position(): { x: number; z: number } | null;
}

/** How often follow re-frames. 400 ms is under the ~600 ms the eye reads as a
 *  jump but well above the 100 ms sceneState cadence, so the pose we compare
 *  against for divergence is never the one we just wrote. */
export const FOLLOW_INTERVAL_MS = 400;

/** Ground-distance the look-at may drift from where we last put it before
 *  follow concludes the player took the camera back (elmos). Above the jitter
 *  from the worker's own `clampToBounds` / terrain-clearance corrections, well
 *  below one screen of deliberate panning. */
export const FOLLOW_DIVERGENCE_ELMOS = 96;

/** Default framing animation for a named focus — long enough to read as a
 *  camera move rather than a cut, short enough not to feel slow when a sentence
 *  asked for it. */
export const FOCUS_DURATION_MS = 500;

/** Instant re-snap while following: an animated one would still be in flight
 *  when the next tick fired, and the transition would fight the re-frame. */
const FOLLOW_SNAP_MS = 0;

/** One zoom step, as a multiplier on the camera-to-target distance. */
const ZOOM_STEP = 0.6;

export type FollowEndReason = 'user-input' | 'camera-action' | 'target-lost' | 'stopped';

export class CameraPort {
    private followTarget: FollowTarget | null = null;
    private followTimer: ReturnType<typeof setInterval> | null = null;
    private unsubscribeInput: (() => void) | null = null;
    /** Where we last told the camera to look — the divergence baseline. */
    private commandedLookAt: { x: number; z: number } | null = null;
    private onFollowEnd: ((reason: FollowEndReason, label: string) => void) | null = null;

    constructor(private readonly deps: CameraPortDeps) {}

    /** Notified whenever a follow ends, with why. The console renders it, so
     *  the player is told the camera was released rather than discovering it. */
    setFollowEndHandler(handler: (reason: FollowEndReason, label: string) => void): void {
        this.onFollowEnd = handler;
    }

    // ─────────────────────────── framing ───────────────────────────

    /** Look at a ground position. */
    focusOn(x: number, z: number, durationMs = FOCUS_DURATION_MS): void {
        this.stopFollow('camera-action');
        this.deps.call('focusOn', [x, z, durationMs]);
        this.commandedLookAt = { x, z };
    }

    /** Top-down view of the whole map. */
    fitMap(): void {
        this.stopFollow('camera-action');
        this.deps.call('cameraFitMap', [{ durationMs: FOCUS_DURATION_MS }]);
        this.commandedLookAt = null;   // the worker chooses the centre
    }

    /**
     * Frame one unit by id, resolving its interpolated position worker-side
     * (one round trip instead of a position query followed by a framing call).
     * The op answers `false` when the unit has no client-side position — that is
     * surfaced as a note rather than swallowed.
     */
    snapToUnit(unitId: number, opts: { durationMs?: number } = {}): void {
        this.stopFollow('camera-action');
        this.deps.call('cameraSnapToUnit', [unitId, { durationMs: opts.durationMs ?? FOCUS_DURATION_MS }]);
        this.commandedLookAt = null;   // the worker resolved the position, not us
    }

    /**
     * One zoom step in or out.
     *
     * The worker exposes an ABSOLUTE orbit distance, not a relative step, so the
     * current distance is read from the cached pose and scaled. With no pose yet
     * (before the first `gp:sceneState`) there is nothing to scale and the op is
     * skipped rather than sent with a made-up distance.
     */
    zoom(dir: 'in' | 'out'): boolean {
        this.stopFollow('camera-action');
        const pose = this.deps.pose();
        if (!pose) {
            this.deps.onNote?.('the camera hasn\'t reported a position yet');
            return false;
        }
        const dx = pose.pos.x - pose.lookAt.x;
        const dy = pose.pos.y - pose.lookAt.y;
        const dz = pose.pos.z - pose.lookAt.z;
        const distance = Math.hypot(dx, dy, dz);
        if (!(distance > 0)) return false;
        const wanted = dir === 'in' ? distance * ZOOM_STEP : distance / ZOOM_STEP;
        // The worker clamps to its own min/max distance, so an over-eager step
        // saturates rather than putting the camera inside the terrain.
        this.deps.call('cameraOrbit', [{ distance: wanted }]);
        return true;
    }

    /** Save / restore a numbered view slot (the worker owns the slot table). */
    saveView(slot: number): void {
        this.deps.call('cameraSaveSlot', [slot]);
    }

    loadView(slot: number): void {
        this.stopFollow('camera-action');
        this.deps.call('cameraLoadSlot', [slot, FOCUS_DURATION_MS]);
        this.commandedLookAt = null;
    }

    /** The current pose, for callers that want to report or compare it. */
    pose(): CameraPose | null {
        return this.deps.pose();
    }

    // ─────────────────────────── follow ───────────────────────────

    /**
     * Keep the camera on `target` until the player takes it back.
     *
     * Returns false when the target has no position to start from — a follow
     * that begins by not moving the camera is indistinguishable from a broken
     * one, so the caller refuses out loud instead.
     */
    follow(target: FollowTarget): boolean {
        const start = target.position();
        if (!start) return false;

        // A new follow replaces the old one; `stopFollow` first so the outgoing
        // target's end-handler fires with the honest reason.
        this.stopFollow('camera-action');

        this.followTarget = target;
        this.snapFollow(start);
        // Kick the position source immediately so the FIRST tick already has
        // fresh data rather than re-reading whatever the start position came from.
        this.deps.onFollowTick?.();

        this.followTimer = setInterval(() => this.tickFollow(), FOLLOW_INTERVAL_MS);
        this.unsubscribeInput = this.deps.onUserInput?.(() => this.stopFollow('user-input')) ?? null;
        return true;
    }

    /** Is a follow running, and on what? */
    followingLabel(): string | null {
        return this.followTarget?.label ?? null;
    }

    /** End any active follow. Idempotent; only notifies when one was running. */
    stopFollow(reason: FollowEndReason = 'stopped'): void {
        const target = this.followTarget;
        if (this.followTimer !== null) {
            clearInterval(this.followTimer);
            this.followTimer = null;
        }
        this.unsubscribeInput?.();
        this.unsubscribeInput = null;
        this.followTarget = null;
        if (target) this.onFollowEnd?.(reason, target.label);
    }

    /** Release timers + listeners. The camera itself is the worker's, and is
     *  deliberately left wherever the player last saw it. */
    dispose(): void {
        this.stopFollow('stopped');
        this.onFollowEnd = null;
    }

    private tickFollow(): void {
        const target = this.followTarget;
        if (!target) return;

        // Divergence check FIRST: if the player has moved the camera, the next
        // thing that must happen is nothing.
        if (this.userTookTheCamera()) {
            this.stopFollow('user-input');
            return;
        }

        // Refresh the position source for the next tick before reading this one:
        // the read is synchronous and the refresh is not, so ordering them the
        // other way round would gain nothing.
        this.deps.onFollowTick?.();

        const position = target.position();
        if (!position) {
            // The squad was destroyed, disbanded, or left the LOS-filtered
            // mirror. Ending is the honest response — parking the camera on the
            // last known position would be a wallhack that survives its target.
            this.stopFollow('target-lost');
            return;
        }
        this.snapFollow(position);
    }

    private snapFollow(position: { x: number; z: number }): void {
        this.deps.call('focusOn', [position.x, position.z, FOLLOW_SNAP_MS]);
        this.commandedLookAt = { x: position.x, z: position.z };
    }

    /** Has the look-at drifted from where we last put it? See the file header
     *  for why this exists alongside the input signal. */
    private userTookTheCamera(): boolean {
        const commanded = this.commandedLookAt;
        if (!commanded) return false;
        const pose = this.deps.pose();
        if (!pose) return false;                       // no feed ⇒ no evidence
        const dx = pose.lookAt.x - commanded.x;
        const dz = pose.lookAt.z - commanded.z;
        return Math.hypot(dx, dz) > FOLLOW_DIVERGENCE_ELMOS;
    }
}

// ───────────────────── the NL-facing adapter ─────────────────────

/** Place types a camera action may be aimed at. Wider than the order path's:
 *  looking at somewhere is not acting on it, so an `enemy-force` sighting or a
 *  landmark is a legitimate camera target even where an order would refuse. */
const CAMERA_PLACE_TYPES = ['region', 'district', 'city', 'objective', 'landmark', 'enemy-force'] as const;
const CAMERA_FORCE_TYPES = ['group', 'platoon', 'army'] as const;

/** The resolver slice the adapter needs — the same `resolveEntity` the order
 *  path uses, so "Sector B9" means one place in both. */
export interface CameraRefResolver {
    resolveEntity(
        name: string,
        opts?: { types?: NamedEntity['type'][]; strict?: boolean; noun?: string },
    ): Resolution<NamedEntity>;
}

export interface NLCameraPortDeps {
    port: CameraPort;
    resolver: CameraRefResolver;
    /**
     * Live centroid of an org group, from the client's LOS-filtered mirror.
     * Groups sit in the name index with x/z 0 (`gp:orgGroups` carries no
     * centroid), so a group reference has to get its position from here or not
     * at all — an unresolvable one refuses rather than framing the map origin.
     */
    groupPosition(groupId: number): { x: number; z: number } | null;
}

const ok = (text: string): Resolution<string> => ({ kind: 'ok', value: text });
const refuse = (reason: string): Resolution<string> => ({ kind: 'refuse', reason });

/**
 * Wrap a `CameraPort` as the executor's camera port: names in, transcript line
 * out, refusal when the name resolves to nothing.
 *
 * Reference resolution is NON-strict (score dominance is enough), unlike the
 * order path's strict force matching. That is a deliberate asymmetry: moving the
 * camera to the wrong hill costs a second and a keystroke, while moving the
 * wrong squad can lose the line. A genuine tie still asks.
 */
export function createNLCameraPort(deps: NLCameraPortDeps): { apply(action: NLCameraAction): Resolution<string> } {
    const { port, resolver } = deps;

    const resolveRef = (name: string): Resolution<NamedEntity> => resolver.resolveEntity(name, {
        types: [...CAMERA_PLACE_TYPES, ...CAMERA_FORCE_TYPES],
        noun: 'place or force',
    });

    const isForce = (entity: NamedEntity): boolean =>
        (CAMERA_FORCE_TYPES as readonly string[]).includes(entity.type);

    /** Where the camera should point for this entity, now. */
    const positionOf = (entity: NamedEntity): { x: number; z: number } | null => {
        if (!isForce(entity)) return { x: entity.x, z: entity.z };
        const groupId = Number(entity.id);
        if (!Number.isFinite(groupId)) return null;
        return deps.groupPosition(groupId);
    };

    return {
        apply(action: NLCameraAction): Resolution<string> {
            switch (action.op) {
                case 'focus': {
                    const found = resolveRef(action.targetRef);
                    if (found.kind !== 'ok') return found as Resolution<string>;
                    const position = positionOf(found.value);
                    if (!position) {
                        return refuse(
                            `I can't see where ${found.value.name} is right now — nothing of theirs ` +
                            `is in the mirror, so there's nowhere to point the camera.`);
                    }
                    port.focusOn(position.x, position.z);
                    return ok(`camera on ${found.value.name}`);
                }

                case 'follow': {
                    const found = resolveRef(action.targetRef);
                    if (found.kind !== 'ok') return found as Resolution<string>;
                    const entity = found.value;

                    if (!isForce(entity)) {
                        // A region doesn't move. Framing it is what the player
                        // wanted; saying "following" would be a small lie that
                        // makes the camera look broken when it never moves again.
                        port.focusOn(entity.x, entity.z);
                        return ok(`${entity.name} doesn't move — showing it instead of following it`);
                    }

                    const groupId = Number(entity.id);
                    const started = port.follow({
                        label: entity.name,
                        position: () => deps.groupPosition(groupId),
                    });
                    if (!started) {
                        return refuse(
                            `I can't see ${entity.name} right now, so there's nothing to follow.`);
                    }
                    return ok(`following ${entity.name} — move the camera yourself to stop`);
                }

                case 'fitMap':
                    port.fitMap();
                    return ok('showing the whole map');

                case 'zoom':
                    if (!port.zoom(action.dir)) {
                        return refuse(`I can't zoom ${action.dir} yet — the camera hasn't reported a position.`);
                    }
                    return ok(`zoomed ${action.dir}`);

                case 'saveView':
                    port.saveView(action.slot);
                    return ok(`view saved to slot ${action.slot}`);

                case 'loadView':
                    port.loadView(action.slot);
                    return ok(`view ${action.slot} restored`);
            }
        },
    };
}

// ───────────────────────── the live instance ─────────────────────────

/**
 * The session's camera port, installed by `main.ts` once the game worker exists
 * and cleared on teardown.
 *
 * A holder rather than an eagerly-constructed singleton for the same reason
 * `class-vocabulary.ts` uses one: the port needs the worker call channel, which
 * only `main.ts` has, and a widget must be able to ask "is there a camera?" and
 * get an honest no rather than a stub that swallows every call.
 */
class CameraPortHolder {
    private port: CameraPort | null = null;

    install(deps: CameraPortDeps): CameraPort {
        this.port?.dispose();
        this.port = new CameraPort(deps);
        return this.port;
    }

    get current(): CameraPort | null {
        return this.port;
    }

    clear(): void {
        this.port?.dispose();
        this.port = null;
    }
}

export const cameraPortHolder = new CameraPortHolder();
