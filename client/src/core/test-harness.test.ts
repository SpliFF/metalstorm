/**
 * P5: the parts of the test harness that are testable without a worker —
 * the widget-list parser, the readiness aggregation (which must never throw)
 * and the camera drift guard (which must always unlock).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestHarness, parseWidgetList, type TestHarnessDeps } from './test-harness.js';

const POSE = { pos: { x: 0, y: 100, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } };

function makeHarness(overrides: Partial<TestHarnessDeps> = {}): {
    h: TestHarness; calls: { method: string; args: unknown[] }[];
} {
    const calls: { method: string; args: unknown[] }[] = [];
    const deps: TestHarnessDeps = {
        gameHttpUrl: 'http://localhost:9100',
        token: 't',
        workerCall: async (method, args = []) => {
            calls.push({ method, args });
            if (method === 'cameraPose') return POSE;
            if (method === 'readyProbe') {
                return {
                    authenticated: true, authFailed: null, receivedState: true,
                    frameId: 42, meshCount: 10, terrainMeshCount: 4,
                };
            }
            return null;
        },
        getSelection: () => [],
        getCameraPose: () => POSE,
        getSceneFrame: () => ({ gameFrame: 1200, ageMs: 80 }),
        getTiming: () => ({ anchored: true, newestFrame: 1210 }),
        getMinimap: () => null,
        ...overrides,
    };
    return { h: new TestHarness(deps), calls };
}

describe('parseWidgetList', () => {
    it('returns [] before the LuaUI runtime boots (empty list)', () => {
        expect(parseWidgetList('')).toEqual([]);
    });

    it('maps the documented pipe-delimited fields onto a row', () => {
        const line = 'active|Unit Ghost|jK|unit_ghost|||2024|GPL|0.5|true|handler';
        const [row] = parseWidgetList(line);
        expect(row).toEqual({
            status: 'active', name: 'Unit Ghost', author: 'jK',
            basename: 'unit_ghost', error: '', desc: '',
            layer: '0.5', enabled: 'true',
        });
    });

    it('keeps the escaped pipe (the host rewrites | as /) inside a field', () => {
        const [row] = parseWidgetList('active|A/B chat|me|gui_chat|||||1|true|h');
        expect(row.name).toBe('A/B chat');
    });

    it('skips blank lines', () => {
        expect(parseWidgetList('active|a|||||||1|true|h\n\n')).toHaveLength(1);
    });
});

describe('readyState', () => {
    it('aggregates the worker probe with the main-thread caches', async () => {
        const { h } = makeHarness();
        const r = await h.readyState();
        expect(r.worker.alive).toBe(true);
        expect(r.worker.sceneStateAgeMs).toBe(80);
        expect(r.connection.authenticated).toBe(true);
        expect(r.frame).toEqual({ gameFrame: 1200, anchored: true, newestBaseFrame: 1210 });
        expect(r.render).toEqual({ frameId: 42, meshCount: 10, terrainMeshCount: 4 });
    });

    it('reports a dead worker instead of throwing', async () => {
        const { h } = makeHarness({
            workerCall: () => Promise.reject(new Error('no game worker running')),
        });
        const r = await h.readyState();
        expect(r.worker.alive).toBe(false);
        expect(r.render.frameId).toBe(-1);
        // The cached frame survives a dead worker — it is main-thread state.
        expect(r.frame.gameFrame).toBe(1200);
    });

    it('nulls the frame before the first sceneState feed', async () => {
        const { h } = makeHarness({ getSceneFrame: () => null, getTiming: () => null });
        const r = await h.readyState();
        expect(r.frame).toEqual({ gameFrame: null, anchored: false, newestBaseFrame: 0 });
        expect(r.worker.sceneStateAgeMs).toBeNull();
    });

    it('clientFrame is -1 before the feed and the cached frame after', () => {
        expect(makeHarness({ getSceneFrame: () => null }).h.clientFrame()).toBe(-1);
        expect(makeHarness().h.clientFrame()).toBe(1200);
    });
});

describe('withStableCamera', () => {
    beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('locks, settles, runs, and unlocks', async () => {
        const { h, calls } = makeHarness();
        const { result, drift } = await h.withStableCamera(() => 'done');
        expect(result).toBe('done');
        expect(drift.posDriftElmos).toBe(0);
        expect(drift.withinTolerance).toBe(true);
        const seq = calls.map((c) => c.method);
        expect(seq[0]).toBe('lockInput');
        expect(calls[0].args).toEqual([true]);
        expect(seq).toContain('cameraSettle');
        expect(calls.filter((c) => c.method === 'lockInput').at(-1)?.args).toEqual([false]);
    });

    it('unlocks even when fn throws', async () => {
        const { h, calls } = makeHarness();
        await expect(h.withStableCamera(() => { throw new Error('boom'); }))
            .rejects.toThrow('boom');
        expect(calls.filter((c) => c.method === 'lockInput').at(-1)?.args).toEqual([false]);
    });

    it('reports drift beyond the tolerance and warns', async () => {
        let n = 0;
        const { h } = makeHarness({
            workerCall: async (method) => {
                if (method === 'cameraPose') {
                    n++;
                    return n === 1 ? POSE
                        : { pos: { x: 30, y: 100, z: 40 }, lookAt: { x: 0, y: 0, z: 0 } };
                }
                return null;
            },
        });
        const { drift } = await h.withStableCamera(() => null, { toleranceElmos: 1 });
        expect(drift.posDriftElmos).toBeCloseTo(50, 6);   // hypot(30, 0, 40)
        expect(drift.lookAtDriftElmos).toBe(0);
        expect(drift.withinTolerance).toBe(false);
        expect(console.warn).toHaveBeenCalled();
    });
});

describe('serverJson (P6 structured server verbs)', () => {
    function stubExec(reply: { success: boolean; output: string }) {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(reply),
            json: async () => reply,
        }));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    afterEach(() => { vi.unstubAllGlobals(); });

    it('prefixes the verb with `json ` and returns the parsed object', async () => {
        const fetchMock = stubExec({
            success: true,
            output: '{"total":2,"returned":2,"units":[{"id":7},{"id":8}]}',
        });
        const { h } = makeHarness();
        const state = await h.serverJson('units', 0);

        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).code).toBe('json units 0');
        expect(state).toEqual({ total: 2, returned: 2, units: [{ id: 7 }, { id: 8 }] });
    });

    it('throws a legible error when the game server predates the prefix', async () => {
        stubExec({ success: false, output: 'unknown command: json state' });
        const { h } = makeHarness();
        await expect(h.serverJson('state')).rejects.toThrow(/predates the json prefix/);
    });

    it('throws rather than returning half-parsed output for an unconverted verb', async () => {
        stubExec({ success: true, output: 'paused' });
        const { h } = makeHarness();
        await expect(h.serverJson('pause')).rejects.toThrow(/not JSON/);
    });

    it('surfaces a converted verb error object to the caller (request "succeeded")', async () => {
        stubExec({ success: true, output: '{"error":"no such unit"}' });
        const { h } = makeHarness();
        expect(await h.serverJson('unit_state', 999999)).toEqual({ error: 'no such unit' });
    });
});
