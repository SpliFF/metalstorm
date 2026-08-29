// @vitest-environment happy-dom
/**
 * camera-travel.test.ts — "go there" (DESIGN-DRILLDOWN.md §5)
 *
 * The property that matters is which OP the travel rides. The worker camera
 * exposes several ways to move, and only `cameraSnapToGround` samples the
 * heightmap for its look-at — `focusOn` pans to sea level and `setCameraPose`
 * is a raw pose the test rig deliberately ignores. A travel that quietly
 * regressed onto `focusOn` would still look fine on a flat map and be wrong on
 * every real one, so the op name is asserted by name in every case below.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    travelTo, canTravelTo, createGoThereButton, TRAVEL_DURATION_MS,
} from './camera-travel.js';
import { cameraPortHolder } from './camera-port.js';
import type { FocusRef } from './focus-model.js';

let calls: Array<{ method: string; args: unknown[] }>;

function install() {
    calls = [];
    cameraPortHolder.install({
        call: (method, args) => calls.push({ method, args: args ?? [] }),
        pose: () => null,
    });
}

beforeEach(() => { document.body.replaceChildren(); install(); });
afterEach(() => cameraPortHolder.clear());

describe('resolution', () => {
    it('a bare ground position travels on the ground-anchored op', () => {
        expect(travelTo({ x: 900, z: 1200 })).toEqual({ ok: true });
        expect(calls[0].method).toBe('cameraSnapToGround');
        expect(calls[0].args.slice(0, 2)).toEqual([900, 1200]);
        expect(calls[0].args[2]).toEqual({ durationMs: TRAVEL_DURATION_MS });
    });

    it('a ref with a position prefers it over its members', () => {
        // A known ground position is stable; a member id can be a unit that
        // died between render and click.
        const ref: FocusRef = {
            kind: 'squad', id: 7, label: '3rd Tanks',
            unitIds: [10], position: { x: 5, z: 6 },
        };
        travelTo(ref);
        expect(calls[0].method).toBe('cameraSnapToGround');
    });

    it('a ref with only members frames one worker-side', () => {
        // This is what makes a squad travellable the instant it is selected,
        // before any census snapshot has arrived.
        const ref: FocusRef = { kind: 'squad', id: 7, label: '3rd Tanks', unitIds: [42, 43] };
        travelTo(ref);
        expect(calls[0].method).toBe('cameraSnapToUnit');
        expect(calls[0].args[0]).toBe(42);
    });

    it('an explicit unit id travels by unit', () => {
        travelTo({ unitId: 99 });
        expect(calls[0].method).toBe('cameraSnapToUnit');
    });

    it('a NaN position is not a position', () => {
        const ref: FocusRef = {
            kind: 'area', id: 'ghost', label: 'Ghost', position: { x: NaN, z: 0 },
        };
        expect(canTravelTo(ref)).toBe(false);
        expect(travelTo(ref)).toEqual({ ok: false, reason: 'no-target' });
        expect(calls).toEqual([]);
    });
});

describe('refusing out loud', () => {
    it('a ref with nowhere to go refuses by reason', () => {
        const ref: FocusRef = { kind: 'area', id: 'nowhere', label: 'Nowhere' };
        expect(travelTo(ref)).toEqual({ ok: false, reason: 'no-target' });
    });

    it('no camera port yet refuses distinctly from no target', () => {
        // The two are different problems — one is "the session isn't up", the
        // other is "we don't know where that is" — and a caller that wanted to
        // report either could not, if they collapsed into one boolean.
        cameraPortHolder.clear();
        expect(travelTo({ x: 1, z: 2 })).toEqual({ ok: false, reason: 'no-camera' });
    });
});

describe('the affordance', () => {
    it('renders enabled and travels on click', () => {
        const btn = createGoThereButton({ x: 300, z: 400 });
        document.body.append(btn);
        expect(btn.disabled).toBe(false);
        btn.click();
        expect(calls[0].method).toBe('cameraSnapToGround');
    });

    it('renders disabled WITH a reason for an untravellable ref', () => {
        const btn = createGoThereButton({ kind: 'area', id: 'x', label: 'X' } as FocusRef);
        expect(btn.disabled).toBe(true);
        expect(btn.title).toBeTruthy();
    });

    it('reports the result to its caller', () => {
        const seen: unknown[] = [];
        const btn = createGoThereButton({ x: 1, z: 2 }, { onTravel: (r) => seen.push(r) });
        document.body.append(btn);
        btn.click();
        expect(seen).toEqual([{ ok: true }]);
    });

    it('stops the click from reaching the row it sits in', () => {
        const row = document.createElement('div');
        let rowClicks = 0;
        row.addEventListener('click', () => { rowClicks++; });
        const btn = createGoThereButton({ x: 1, z: 2 });
        row.append(btn);
        document.body.append(row);
        btn.click();
        expect(rowClicks).toBe(0);
    });
});
