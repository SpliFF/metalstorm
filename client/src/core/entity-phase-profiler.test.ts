import { describe, it, expect } from 'vitest';
import {
    createEntityPhaseAccumulator, resetEntityPhaseAccumulator,
    buildEntityPhaseReport,
} from './entity-phase-profiler.js';

/** A two-frame window whose slices deliberately do NOT sum to the total, so
 *  the residual is a real number rather than a rounding artefact. */
function window2() {
    const a = createEntityPhaseAccumulator();
    a.frames = 2;
    a.interp = 1.0; a.squadPose = 0.4; a.squadUpdate = 0.6;
    a.squadFlush = 0.2; a.impostor = 0.1; a.events = 0.1;
    a.total = 3.0;                     // named = 2.4 → residual 0.6 over 2 frames
    a.squadSum = 2000; a.entitySum = 240;
    return a;
}

describe('buildEntityPhaseReport', () => {
    it('reports per-frame means and the window bands', () => {
        const r = buildEntityPhaseReport(window2());
        expect(r.frames).toBe(2);
        expect(r.squads).toBe(1000);
        expect(r.entities).toBe(120);
        expect(r.ms.interp).toBeCloseTo(0.5, 10);
        expect(r.ms.total).toBeCloseTo(1.5, 10);
    });

    it('makes `other` the residual so nothing in the phase can hide', () => {
        const r = buildEntityPhaseReport(window2());
        expect(r.ms.other).toBeCloseTo(0.3, 10);
        const summed = r.ms.interp + r.ms.squadPose + r.ms.squadUpdate
            + r.ms.squadFlush + r.ms.impostor + r.ms.events + r.ms.other;
        expect(summed).toBeCloseTo(r.ms.total, 10);
    });

    it('divides only the per-squad slices by the squad count', () => {
        const r = buildEntityPhaseReport(window2());
        // 0.2 ms/frame over 1000 squads = 0.2 µs/squad.
        expect(r.usPerSquad?.squadPose).toBeCloseTo(0.2, 10);
        expect(r.usPerSquad?.squadUpdate).toBeCloseTo(0.3, 10);
        // interp/impostor/events walk entities or a queue, not squads — a
        // µs/squad for them is the average-as-marginal error M25 cost us.
        expect(r.usPerSquad?.interp).toBeUndefined();
        expect(r.usPerSquad?.impostor).toBeUndefined();
        expect(r.usPerSquad?.other).toBeUndefined();
    });

    it('refuses a per-squad figure when the window held no squads', () => {
        const a = window2();
        a.squadSum = 0;
        expect(buildEntityPhaseReport(a).usPerSquad).toBeNull();
    });

    it('reports an unsampled window as empty rather than dividing by one', () => {
        const r = buildEntityPhaseReport(createEntityPhaseAccumulator());
        expect(r.frames).toBe(0);
        expect(r.ms.total).toBe(0);
        expect(r.usPerSquad).toBeNull();
        expect(r.table).toContain('no frames sampled');
    });

    it('reset zeroes every field, so arming starts a fresh window', () => {
        const a = window2();
        resetEntityPhaseAccumulator(a);
        for (const v of Object.values(a)) expect(v).toBe(0);
    });
});
