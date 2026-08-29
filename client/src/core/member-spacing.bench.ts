// member-spacing.bench.ts — the perf arm for unit-motion M2 (member spacing).
//
// `npx vitest bench src/core/member-spacing.bench.ts`. NOT part of the gate and
// NOT part of tsc's project — same reasoning as turn-slew.bench.ts and
// squad-flush.bench.ts: a perf assertion inside a unit suite goes red on a
// loaded machine and then gets muted, which is worse than no assertion at all.
//
// WHY THIS FILE EXISTS. `entity` (the client squad JS) is the binding perf lever
// for the whole game (PLAN-perf M9) and is CONCAVE in member count (M25), so
// anything that touches per-member per-frame work has to be priced. M2 touches
// two things inside `separateFromGrid`, the per-member neighbour loop:
//
//   1. the separation RADIUS is now per-squad and sized to the hull, so more
//      neighbours pass the `d2 < r*r` test and reach the body of the loop;
//   2. the falloff is `(r/d - 1) * w / d` instead of `w / d` — one extra
//      multiply and subtract per neighbour that passes.
//
// It also moves the formation radius, which is NOT per-frame work (it is solved
// once per def in the squad constructor) but changes member DENSITY, and density
// is what decides how many neighbours the loop actually visits. That is the
// dominant term and this bench is arranged to separate it out.
//
// THE NULL CONTROL is the shipped code with a def that declares no
// `member_clearance` — a real, reachable configuration (every def outside the
// ten classes `_builder.lua` now sizes), not deleted code. It takes the pre-M2
// numbers exactly: formation radius 24, separation radius 14. Arms 3 and 4 then
// switch ONE of the two consequences on at a time:
//
//   arm 1  control     r  24   sep 14.0   pre-M2 geometry, M2 code compiled in
//   arm 2  M2          r 117   sep 39.6   what a tanks-s1 squad actually ships
//   arm 3  radius only r 117   sep 14.0   the spread, at the old radius
//   arm 4  radius kept r  24   sep 39.6   the wider radius, at the old density
//
// LOAD, stated: 200 squads x 25 members = 5 000 members, every squad at
// STEP_FULL every frame, SoA engine (the shipped default), squad centroids on a
// 300-elmo grid, formations translating and rotating so the neighbour set
// churns. 25 members in a wedge packs out to radius 366, so in the M2 arms a
// squad is more than twice its own centroid pitch across and every squad
// overlaps its four neighbours heavily. That is deliberately worse than
// anything that ships — the widest real squad is tanks-s1 at 8 wedge members,
// radius 117 — and it is what makes this an UPPER bound. The 25/5 000 rung is
// also what turn-slew.bench.ts and squad-flush.bench.ts use, so the three read
// side by side.
//
// The layout is IDENTICAL in every arm. The control's tight formations
// therefore leave more empty ground between squads, so it visits fewer
// neighbours per member: the control is favourable by construction.
//
// MEASURED 2026-08-30, darwin/arm64, vitest 4.1.2, NullEngine, mean ms/frame
// (two runs):
//
//   arm                                       run 1     run 2   vs control
//   1  null control   r  24  sep 14.0         6.2500    6.1453      —
//   2  M2            r 366  sep 39.6         6.4109    6.7258   +2.6 % / +9.4 %
//   3  spread only   r 366  sep 14.0         5.8655    5.9077   -6.2 % / -3.9 %
//   4  sep radius    r  24  sep 39.6         6.2439    6.3012   -0.1 % / +2.5 %
//
// READING. The two halves are not additive, and the reason is density, not
// arithmetic. Arm 3 is FASTER than the control: spreading members thins the
// spatial hash's buckets, so the 3x3 scan finds fewer candidates per member.
// Arm 4 is a wash: a wider radius at unchanged density mostly re-tests
// neighbours the query already had to look at. Put together (arm 2) the wider
// radius reaches across the now-larger formations and admits neighbours that
// neither change alone would have, so more candidates reach the body of the
// loop — a few per cent of the `entity` phase, at a load where every squad is
// sitting on top of four others.
//
// What M2 does NOT add is per-member per-frame arithmetic worth measuring: the
// falloff change is one multiply and one subtract on a neighbour that already
// passed the distance test, and the formation radius is solved ONCE per def in
// the squad constructor (`packedFormationRadius`, memoised per formation shape)
// — never in a frame. There is no allocation on the stepping path; the one Map
// this adds is read at construction time and hit thereafter.

import { bench, describe } from 'vitest';
import { NullEngine, Scene, FreeCamera, Vector3, Color3 } from '@babylonjs/core';
import { SquadRenderBackend } from './squad-render-backend.js';
import type { ImpostorAtlas } from './impostor-renderer.js';
// eslint-disable-next-line import/no-relative-packages
import { SquadManager } from '../../../data/games/metalstorm/client/squads/squad-manager.js';
import {
    createSchedule, scheduleReset, schedulePush, stepMembers, STEP_FULL,
// eslint-disable-next-line import/no-relative-packages
} from '../../../data/games/metalstorm/client/squads/soa-kernel.js';

const ATLAS: ImpostorAtlas = { diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 12, height: 12 };

const SQUADS = 200;
const SIZE = 25;                 // 200 x 25 = 5 000 members
const DT = 1 / 60;
const PITCH = 300;               // elmos between squad centroids
/** tanks-s1: a 4.5 m hull at 8 elmos = 1 m, halved — what _builder.lua emits. */
const CLEARANCE = 18;

interface Arm { step: () => void; radius: number; sep: number }

/**
 * One bench arm. Every arm builds the identical stack and drives the identical
 * squad layout; they differ only in the def's `member_clearance` and in the two
 * config multipliers that decide what the squad constructor does with it.
 * `memberSpacingMul: 0` disables the radius floor while leaving the separation
 * radius sized (arm 3's inverse), and `separationClearanceMul` scaled to
 * 14/CLEARANCE pins the separation radius back at its pre-M2 value.
 */
function arm(clearance: number, cfgOverrides: Record<string, number>): Arm {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.activeCamera = new FreeCamera('cam', new Vector3(0, 800, -800), scene);
    const backend = new SquadRenderBackend(scene, {
        getGroundHeight: () => 0,
        getTeamColor: () => new Color3(1, 0, 0),
        getImpostorAtlas: () => ATLAS,
    });
    const mgr = new SquadManager(backend, { engine: 'soa', ...cfgOverrides });
    const customParams: Record<string, string> = { ms_class: 'tanks' };
    if (clearance > 0) customParams.member_clearance = String(clearance);
    const def = {
        defId: 7, squadSize: SIZE, formationType: 'wedge', formationRadius: 24,
        maxSpeed: 75, customParams,
    };
    const cols = Math.ceil(Math.sqrt(SQUADS));
    for (let i = 0; i < SQUADS; i++) {
        mgr.syncSquad(i + 1, {
            x: (i % cols) * PITCH, y: 0, z: Math.floor(i / cols) * PITCH,
            heading: 0, health: 100, maxHealth: 100,
        }, def);
    }

    const m = mgr as unknown as {
        squads: Map<number, Record<string, unknown>>; store: unknown;
        _grid?: unknown; update: (dt: number) => void;
    };
    const list = [...m.squads.values()];
    const schedule = scheduleReset(createSchedule(), list.length);
    for (let i = 0; i < list.length; i++) schedulePush(schedule, i, STEP_FULL, DT);

    let f = 0;
    const step = (): void => {
        f++;
        // Walk every formation forward and rotate it, so members are always
        // chasing a moving slot and the neighbour set actually churns.
        for (let i = 0; i < list.length; i++) {
            const sq = list[i] as unknown as { setPose: (x: number, y: number, z: number, h: number) => void };
            sq.setPose((i % cols) * PITCH + f * 1.5, 0, Math.floor(i / cols) * PITCH, f * 0.6 * DT);
        }
        // The manager's own update rebuilds the spatial grid the kernel queries;
        // the grid IS the thing a wider separation radius leans on, so it has to
        // be inside the measured region.
        m.update(DT);
        stepMembers(m.store, list, (m as unknown as { _soaGrid: unknown })._soaGrid ?? null,
            null, [], backend, DT, f * DT, schedule);
    };
    for (let w = 0; w < 60; w++) step();        // warm the JIT on this shape
    const first = list[0] as unknown as { formationRadius: number; separationRadius: number };
    return { step, radius: first.formationRadius, sep: first.separationRadius };
}

const control = arm(0, {});
const m2 = arm(CLEARANCE, {});
const spreadOnly = arm(CLEARANCE, { separationClearanceMul: 14 / CLEARANCE });
const radiusOnly = arm(CLEARANCE, { memberSpacingMul: 0 });

describe(`entity phase, ${SQUADS} x ${SIZE} = ${SQUADS * SIZE} members, all stepping`, () => {
    bench(`null control — no member_clearance (r ${control.radius.toFixed(0)}, sep ${control.sep.toFixed(1)})`,
        () => { control.step(); });
    bench(`M2 — clearance ${CLEARANCE} (r ${m2.radius.toFixed(0)}, sep ${m2.sep.toFixed(1)})`,
        () => { m2.step(); });
    bench(`spread only — packed slots, pre-M2 separation radius (r ${spreadOnly.radius.toFixed(0)}, sep ${spreadOnly.sep.toFixed(1)})`,
        () => { spreadOnly.step(); });
    bench(`separation radius only — pre-M2 slots (r ${radiusOnly.radius.toFixed(0)}, sep ${radiusOnly.sep.toFixed(1)})`,
        () => { radiusOnly.step(); });
});
