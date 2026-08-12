/**
 * camera-port.test.ts — the worker ops, and the escapable follow
 * (PLAN-metalstorm-command-language.md §6.2, milestone M3)
 *
 * Two things worth testing here, and they are not the framing maths (that lives
 * in the worker camera and has its own tests):
 *
 *  1. the port issues the ops `test-harness.ts` proved out, with the arguments
 *     the worker expects — a typo in a method name is a silently dead camera;
 *  2. a follow can ALWAYS be escaped. Three independent cancel paths, each
 *     covered separately, because a follow that only stops on the one signal we
 *     happened to test is the failure the file header warns about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    CameraPort, createNLCameraPort,
    FOLLOW_INTERVAL_MS, FOLLOW_DIVERGENCE_ELMOS, FOCUS_DURATION_MS,
    type CameraPose, type FollowEndReason,
} from './camera-port.js';
import { NLResolver } from './nl-resolver.js';
import { NamedEntityIndex } from './named-entity-index.js';
import { ClassVocabulary } from './class-vocabulary.js';

interface Recorded { method: string; args: unknown[] }

function makePort(opts: { pose?: CameraPose | null } = {}) {
    const calls: Recorded[] = [];
    // `in`, not `??`: an explicit `pose: null` is the "no sceneState yet" case
    // and must not be coalesced back to a default pose.
    let pose: CameraPose | null = 'pose' in opts
        ? opts.pose ?? null
        : { pos: { x: 0, y: 1000, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } };
    const inputListeners = new Set<() => void>();
    const ended: Array<{ reason: FollowEndReason; label: string }> = [];
    const notes: string[] = [];

    const port = new CameraPort({
        call: (method, args) => calls.push({ method, args: args ?? [] }),
        pose: () => pose,
        onUserInput: (listener) => {
            inputListeners.add(listener);
            return () => inputListeners.delete(listener);
        },
        onNote: (note) => notes.push(note),
    });
    port.setFollowEndHandler((reason, label) => ended.push({ reason, label }));

    return {
        port, calls, ended, notes,
        setPose: (next: CameraPose | null) => { pose = next; },
        fireUserInput: () => { for (const l of [...inputListeners]) l(); },
        inputListenerCount: () => inputListeners.size,
    };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the worker ops', () => {
    it('focusOn forwards x, z and a duration', () => {
        const h = makePort();
        h.port.focusOn(1234, 5678);
        expect(h.calls).toEqual([{ method: 'focusOn', args: [1234, 5678, FOCUS_DURATION_MS] }]);
    });

    it('fitMap and snapToUnit use the harness-proven op names', () => {
        const h = makePort();
        h.port.fitMap();
        h.port.snapToUnit(42);
        expect(h.calls.map((c) => c.method)).toEqual(['cameraFitMap', 'cameraSnapToUnit']);
        expect(h.calls[1].args[0]).toBe(42);
    });

    it('zoom scales the live camera-to-target distance', () => {
        // 3-4-5: a pose 500 elmos out. One step in is 0.6× that; out is /0.6.
        const h = makePort({ pose: { pos: { x: 300, y: 400, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } } });
        expect(h.port.zoom('in')).toBe(true);
        expect(h.port.zoom('out')).toBe(true);
        const distances = h.calls.map((c) => Math.round((c.args[0] as { distance: number }).distance));
        expect(distances).toEqual([300, 833]);
    });

    it('zoom with no pose yet refuses rather than inventing a distance', () => {
        const h = makePort({ pose: null });
        expect(h.port.zoom('in')).toBe(false);
        expect(h.calls).toEqual([]);
        expect(h.notes[0]).toContain('position');
    });

    it('saveView / loadView reach the worker slot table', () => {
        const h = makePort();
        h.port.saveView(3);
        h.port.loadView(3);
        expect(h.calls.map((c) => c.method)).toEqual(['cameraSaveSlot', 'cameraLoadSlot']);
    });
});

describe('follow', () => {
    const target = (position: () => { x: number; z: number } | null) =>
        ({ label: 'Hammerfall', position });

    it('frames immediately and then on every tick', () => {
        const h = makePort();
        let x = 100;
        expect(h.port.follow(target(() => ({ x, z: 200 })))).toBe(true);
        expect(h.calls).toHaveLength(1);          // no waiting for the first frame

        x = 300;
        h.setPose({ pos: { x: 100, y: 900, z: 200 }, lookAt: { x: 100, y: 0, z: 200 } });
        vi.advanceTimersByTime(FOLLOW_INTERVAL_MS);

        expect(h.calls).toHaveLength(2);
        expect(h.calls[1].args.slice(0, 2)).toEqual([300, 200]);
        expect(h.port.followingLabel()).toBe('Hammerfall');
    });

    it('re-snaps INSTANTLY, so a transition is never mid-flight when the next tick lands', () => {
        const h = makePort();
        h.port.follow(target(() => ({ x: 10, z: 20 })));
        expect(h.calls[0].args[2]).toBe(0);
    });

    it('refuses to start when the target has no position', () => {
        const h = makePort();
        expect(h.port.follow(target(() => null))).toBe(false);
        expect(h.calls).toEqual([]);
        expect(h.port.followingLabel()).toBeNull();
    });

    // ── the three cancel paths ──

    it('cancels on player camera input', () => {
        const h = makePort();
        h.port.follow(target(() => ({ x: 10, z: 20 })));
        h.fireUserInput();

        expect(h.port.followingLabel()).toBeNull();
        expect(h.ended).toEqual([{ reason: 'user-input', label: 'Hammerfall' }]);

        // And the loop really stopped, not just the flag.
        const before = h.calls.length;
        vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 3);
        expect(h.calls).toHaveLength(before);
    });

    it('cancels on pose divergence — the edge-scroll backstop', () => {
        const h = makePort();
        h.port.follow(target(() => ({ x: 1000, z: 1000 })));
        // The player edge-scrolls: no discrete input event exists for it, but the
        // look-at has moved away from where we last put it.
        h.setPose({
            pos: { x: 1000, y: 900, z: 1000 },
            lookAt: { x: 1000 + FOLLOW_DIVERGENCE_ELMOS + 1, y: 0, z: 1000 },
        });
        vi.advanceTimersByTime(FOLLOW_INTERVAL_MS);

        expect(h.port.followingLabel()).toBeNull();
        expect(h.ended[0].reason).toBe('user-input');
    });

    it('does NOT cancel on drift inside the tolerance', () => {
        const h = makePort();
        h.port.follow(target(() => ({ x: 1000, z: 1000 })));
        // The worker's own terrain-clearance / bounds clamping nudges the pose;
        // treating that as player input would make follow uselessly fragile.
        h.setPose({
            pos: { x: 1000, y: 900, z: 1000 },
            lookAt: { x: 1000 + FOLLOW_DIVERGENCE_ELMOS - 1, y: 0, z: 1000 },
        });
        vi.advanceTimersByTime(FOLLOW_INTERVAL_MS);
        expect(h.port.followingLabel()).toBe('Hammerfall');
    });

    it('cancels when another camera action runs', () => {
        const h = makePort();
        h.port.follow(target(() => ({ x: 10, z: 20 })));
        h.port.fitMap();
        expect(h.port.followingLabel()).toBeNull();
        expect(h.ended[0].reason).toBe('camera-action');
    });

    it('ends when the target leaves the mirror instead of parking on its last position', () => {
        const h = makePort();
        let alive = true;
        h.port.follow(target(() => (alive ? { x: 10, z: 20 } : null)));
        alive = false;
        h.setPose({ pos: { x: 10, y: 900, z: 20 }, lookAt: { x: 10, y: 0, z: 20 } });
        vi.advanceTimersByTime(FOLLOW_INTERVAL_MS);

        expect(h.port.followingLabel()).toBeNull();
        expect(h.ended[0].reason).toBe('target-lost');
        // A camera parked on a destroyed squad's last position would be intel the
        // player is no longer entitled to.
        expect(h.calls).toHaveLength(1);
    });

    it('drops its input subscription when it ends, so nothing leaks per follow', () => {
        const h = makePort();
        h.port.follow(target(() => ({ x: 1, z: 1 })));
        expect(h.inputListenerCount()).toBe(1);
        h.port.stopFollow();
        expect(h.inputListenerCount()).toBe(0);

        h.port.follow(target(() => ({ x: 1, z: 1 })));
        h.port.follow(target(() => ({ x: 2, z: 2 })));
        expect(h.inputListenerCount()).toBe(1);      // replaced, not accumulated
    });

    it('kicks the position source on start and on every tick', () => {
        // The live bug this closes: the console's centroid lookup reads a census
        // that only refreshes when a sentence is submitted, so a follow tracked a
        // photograph — the camera snapped once and then sat still while the squad
        // drove away. The hook is what keeps the source moving, and only while a
        // follow is running.
        const ticks: number[] = [];
        const calls: Recorded[] = [];
        const port = new CameraPort({
            call: (method, args) => calls.push({ method, args: args ?? [] }),
            pose: () => ({ pos: { x: 0, y: 900, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } }),
            onFollowTick: () => ticks.push(calls.length),
        });

        port.focusOn(1, 1);
        expect(ticks, 'a plain focus is not a follow').toEqual([]);

        port.follow({ label: 'X', position: () => ({ x: 0, z: 0 }) });
        expect(ticks).toHaveLength(1);
        vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 2);
        expect(ticks).toHaveLength(3);

        port.stopFollow();
        vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 3);
        expect(ticks, 'nothing polls once the follow ends').toHaveLength(3);
    });

    it('dispose stops the loop', () => {
        const h = makePort();
        h.port.follow(target(() => ({ x: 1, z: 1 })));
        h.port.dispose();
        const before = h.calls.length;
        vi.advanceTimersByTime(FOLLOW_INTERVAL_MS * 5);
        expect(h.calls).toHaveLength(before);
    });
});

describe('the NL adapter', () => {
    const vocabulary = ClassVocabulary.fromData({ classes: {} });

    function build(opts: { groupPosition?: { x: number; z: number } | null } = {}) {
        const index = new NamedEntityIndex();
        index.replaceAll([
            { id: 'north_gate', type: 'region', name: 'Northgate', x: 2000, z: 500 },
            { id: 1, type: 'group', name: 'Chimera Squad', x: 0, z: 0 },
        ]);
        const resolver = new NLResolver({ index, vocabulary, groups: [] });
        const h = makePort();
        const adapter = createNLCameraPort({
            port: h.port,
            resolver,
            groupPosition: () => opts.groupPosition ?? null,
        });
        return { ...h, adapter };
    }

    it('resolves a place name to coordinates before the worker ever sees it', () => {
        const h = build();
        const result = h.adapter.apply({ op: 'focus', targetRef: 'Northgate' });
        expect(result).toEqual({ kind: 'ok', value: 'camera on Northgate' });
        expect(h.calls[0].args.slice(0, 2)).toEqual([2000, 500]);
    });

    it('refuses a name nothing resolves — it does NOT report success', () => {
        const h = build();
        const result = h.adapter.apply({ op: 'focus', targetRef: 'Atlantis' });
        expect(result.kind).toBe('refuse');
        expect(h.calls).toEqual([]);
    });

    it('a group with nothing in the mirror refuses rather than framing the origin', () => {
        // The index stores groups at x/z 0 (gp:orgGroups carries no centroid), so
        // a port that trusted the index would frame the map corner.
        const h = build({ groupPosition: null });
        const result = h.adapter.apply({ op: 'focus', targetRef: 'Chimera Squad' });
        expect(result.kind).toBe('refuse');
        expect(h.calls).toEqual([]);
    });

    it('a group WITH a centroid is framed at the centroid, not the index position', () => {
        const h = build({ groupPosition: { x: 900, z: 1100 } });
        h.adapter.apply({ op: 'focus', targetRef: 'Chimera Squad' });
        expect(h.calls[0].args.slice(0, 2)).toEqual([900, 1100]);
    });
});
