// turn-slew.bench.ts — the perf arm for unit-motion M1 (bounded visual turn).
//
// `npx vitest bench src/core/turn-slew.bench.ts`. NOT part of the gate and NOT
// part of tsc's project: vitest's benchmark include is `*.bench.ts`, which
// `vitest run` does not pick up. Same reasoning as squad-flush.bench.ts — a
// perf assertion inside a unit suite goes red on a loaded machine and then gets
// muted, which is worse than no assertion at all.
//
// WHY THIS FILE EXISTS. The `entity` phase (client squad JS) is the binding
// perf lever for the whole game — PLAN-perf M9 — and it is CONCAVE in member
// count (M25), so per-member per-frame work is precisely the thing that must
// not grow carelessly. M1 adds per-member per-frame work. This measures how
// much.
//
// THE NULL CONTROL is what makes the comparison mean anything. The "uncapped"
// arm is not old code: it is the SHIPPED code path with `turnRateCap` set to
// Infinity, which `turnToward` treats as the identity (it returns the uncapped
// heading and copies the velocity straight through — pinned by
// turn-slew.test.js's first case). So the delta between arm 1 and arms 2/3 is
// the cost of the SLEW, with the call, the branch and the hoists all present in
// both. A "before" arm built by deleting the call would have measured the
// inlining decision instead.
//
// LOAD, stated: 200 squads x 25 members = 5 000 members, every squad at
// STEP_FULL every frame, on the SoA engine (the shipped default). This is the
// same rung squad-flush.bench.ts uses, so the two are readable side by side.
// The squads' formation heading is rotated ~34 deg/s and translated at the same
// time, so members chase a slot that is both turning and moving. That is a
// deliberately hostile shape, and it was verified hostile rather than assumed:
// instrumenting `turnToward` under exactly this load put **86.7 %** of calls
// (260 200 of 300 000 over 60 measured frames) on the rate-limited branch — the
// one that pays sin+cos. A real battle is far kinder, because a member running
// straight takes the cheap path (a subtract, a wrapAngle, two compares) and
// never touches trig at all.
//
// MEASURED 2026-08-29, darwin/arm64, vitest 4.1.2, NullEngine, mean ms/frame:
//
//   entity phase, 5 000 members     mean     vs control
//     null control (cap Infinity)   1.5724      —
//     tanks   cap 1.0  coupling 1   1.5663    -0.4 %   (inside the +/-0.44 % rme)
//     infantry cap 3.0 coupling 0   1.6024    +1.9 %
//
//   turnToward alone, 5 000 calls   mean     per call
//     null control                  0.1245    24.9 ns
//     rate-limited, coupling 1      0.1246    24.9 ns
//     rate-limited, coupling 0      0.1251    25.0 ns
//
// READING: the slew is free to within this bench's noise floor. It is not a
// surprise once measured — `atan2` was ALREADY being paid on this line before
// M1 (that is what `headingFromVelocity` is), and it dominates the sin+cos the
// coupling adds. The cost M1 could have had, and does not, is a per-member
// profile property lookup; that is why the caps are hoisted per squad in
// `stepGroundSquad` rather than read off `sq.profile` inside the loop.

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
// eslint-disable-next-line import/no-relative-packages
import { profileFor } from '../../../data/games/metalstorm/client/squads/movement-profiles.js';

const ATLAS: ImpostorAtlas = { diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 12, height: 12 };

const SQUADS = 200;
const SIZE = 25;                 // 200 x 25 = 5 000 members
const DT = 1 / 60;
const HEADING_RATE = 0.6;        // rad/s of formation rotation — keeps the turn hot

interface Arm { step: () => void }

/**
 * One bench arm. `turnRateCap`/`arcCoupling` are written onto every squad's
 * profile AFTER construction, so all arms share one identical stack shape and
 * differ only in the two numbers the slew reads.
 */
function arm(msClass: string, turnRateCap: number, arcCoupling: number): Arm {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.activeCamera = new FreeCamera('cam', new Vector3(0, 800, -800), scene);
    const backend = new SquadRenderBackend(scene, {
        getGroundHeight: () => 0,
        getTeamColor: () => new Color3(1, 0, 0),
        getImpostorAtlas: () => ATLAS,
    });
    const mgr = new SquadManager(backend, { engine: 'soa' });
    const def = {
        defId: 7, squadSize: SIZE, formationType: 'wedge', formationRadius: 24,
        maxSpeed: 75, customParams: { ms_class: msClass },
    };
    const cols = Math.ceil(Math.sqrt(SQUADS));
    for (let i = 0; i < SQUADS; i++) {
        mgr.syncSquad(i + 1, {
            x: (i % cols) * 140, y: 0, z: Math.floor(i / cols) * 140,
            heading: 0, health: 100, maxHealth: 100,
        }, def);
    }

    const m = mgr as unknown as { squads: Map<number, Record<string, unknown>>; store: unknown };
    const list = [...m.squads.values()];
    for (const sq of list) {
        sq.profile = { ...(profileFor(msClass) as object), turnRateCap, arcCoupling };
    }

    const schedule = scheduleReset(createSchedule(), list.length);
    for (let i = 0; i < list.length; i++) schedulePush(schedule, i, STEP_FULL, DT);

    let f = 0;
    const step = (): void => {
        f++;
        // Rotate every formation and walk it forward: members chase a slot that
        // is both translating and rotating, which is the hard case for the slew.
        for (let i = 0; i < list.length; i++) {
            const sq = list[i] as unknown as { setPose: (x: number, y: number, z: number, h: number) => void };
            sq.setPose((i % cols) * 140 + f * 1.5, 0, Math.floor(i / cols) * 140, f * HEADING_RATE * DT);
        }
        stepMembers(m.store, list, null, null, [], backend, DT, f * DT, schedule);
    };
    for (let w = 0; w < 60; w++) step();        // warm the JIT on this shape
    return { step };
}

describe('entity phase, 5 000 members, every squad stepping, formations rotating', () => {
    // Arm 1 is the null control: identical code, infinite cap.
    const control = arm('tanks', Infinity, 1);
    const tanks = arm('tanks', profileFor('tanks').turnRateCap, profileFor('tanks').arcCoupling);
    const infantry = arm('soldiers', profileFor('soldiers').turnRateCap, profileFor('soldiers').arcCoupling);

    bench('null control — slew compiled in, turnRateCap = Infinity', () => { control.step(); });
    bench('tanks — cap 1.0 rad/s, arcCoupling 1 (re-points velocity)', () => { tanks.step(); });
    bench('infantry — cap 3.0 rad/s, arcCoupling 0 (heading only)', () => { infantry.step(); });
});

describe('turnToward alone, 5 000 calls — the primitive, no stack around it', () => {
    // The stack arms above include grid rebuild, separation, passability and the
    // backend write, so the slew is a small slice of a big number. This arm is
    // the slew on its own, to make the per-call cost legible.
    const N = 5000;
    const vx = new Float32Array(N), vz = new Float32Array(N), h = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        vx[i] = Math.cos(a) * 90; vz[i] = Math.sin(a) * 90;
        h[i] = a * 0.5;           // deliberately NOT the heading of v: every call turns
    }
    const out = { x: 0, z: 0 };
    const run = (maxDelta: number, coupling: number) => (): void => {
        for (let i = 0; i < N; i++) {
            h[i] = turnToward(h[i], vx[i], vz[i], 90, maxDelta, coupling, out);
        }
    };
    bench('null control — maxDelta = Infinity', run(Infinity, 1));
    bench('rate-limited, arcCoupling 1 (pays sin+cos)', run(1.0 * DT, 1));
    bench('rate-limited, arcCoupling 0 (heading only)', run(3.0 * DT, 0));
});

// eslint-disable-next-line import/no-relative-packages, import/first
import { turnToward } from '../../../data/games/metalstorm/client/squads/steering.js';
