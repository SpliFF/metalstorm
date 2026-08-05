// perf-probe.test.js — the per-term attribution probe must be observationally
// inert (PLAN-perf M12).
//
// The probe sizes one term of the per-member steering path by repeating it k
// extra times per member and reading the slope of the `entity` phase against k.
// That only measures what it claims if the extra evaluations change nothing:
// the terms that mutate member state snapshot and restore the fields they
// touch, so the real call still runs last from the state it would have seen
// with the probe off. These tests pin exactly that, term by term, because a
// probe that quietly perturbs the sim would produce numbers that look fine and
// mean nothing.

import { describe, it, expect, afterEach } from 'vitest';
import { Squad, setPerfProbe, getPerfProbe, PROBE_TERMS } from './squad.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { createPassability } from './passability.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

function makeDef(overrides = {}) {
  return {
    defId: 'probe_test',
    squadSize: 8,
    formationType: 'blob',
    formationRadius: 20,
    maxSpeed: 5,
    moveClass: 'INFANTRY',
    customParams: {},
    ...overrides,
  };
}

// A ramp so passability actually has impassable cells to project away from and
// a non-uniform cost field — otherwise the pathfinding terms are no-ops and the
// test would pass without exercising them.
function makePassability() {
  return createPassability({
    bounds: { minX: 0, minZ: 0, maxX: 1024, maxZ: 1024 },
    heightAt: (x, z) => (z > 500 ? (z - 500) * 0.9 : 0) + Math.sin(x / 60) * 3,
    waterLevel: 0,
  }, makeCfg());
}

/** Drive a squad `frames` steps and return a deep snapshot of every member's
 *  observable state, plus the transforms pushed at the render backend. */
function run(frames, { probeTerm = 'off', probeRepeat = 0 } = {}) {
  const cfg = makeCfg();
  const writes = [];
  const backend = new NullRenderBackend();
  backend.updateMember = (handle, x, y, z, headingY, gait) =>
    writes.push([handle, x, y, z, headingY, gait]);

  const squad = new Squad(1, makeDef(), backend, cfg);
  squad.setPose(200, 0, 300, 0);
  const passability = makePassability();

  // A neighbour query with real content, so `separate` has work to do.
  const others = squad.members.map(m => ({ x: m.x + 3, z: m.z + 3, squadId: 99, radius: 8 }));
  const query = () => others;

  setPerfProbe(probeTerm, probeRepeat);
  for (let f = 0; f < frames; f++) {
    // Move the squad so trails accumulate and COLUMN/turn bias engages.
    // Steps stay well under cfg.teleportThreshold so this is ordinary motion,
    // not the rigid-translate path.
    squad.setPose(200 + f * 6, 0, 300 + f * 5, f * 0.03);
    squad.update(1 / 30, f / 30, query, passability);
  }
  setPerfProbe('off', 0);

  return {
    members: squad.members.map(m => ({
      x: m.x, y: m.y, z: m.z, vx: m.vx, vz: m.vz,
      headingY: m.headingY, gait: m.gait, mode: m.mode,
      recoveryLevel: m.recoveryLevel, stuck: m._stuckFrames,
      lastDist: m._lastTargetDistSq, modeStreak: m._modeStreak,
    })),
    writes,
  };
}

afterEach(() => setPerfProbe('off', 0));

describe('per-term attribution probe (PLAN-perf M12)', () => {
  it('is off by default, so no shipping frame pays for it', () => {
    expect(getPerfProbe()).toEqual({ term: 'off', repeat: 0 });
  });

  it('rejects an unknown term rather than silently measuring nothing', () => {
    expect(() => setPerfProbe('nosuchterm', 4)).toThrow(/unknown probe term/);
    expect(getPerfProbe().term).toBe('off');
  });

  it('pins repeat to 0 when off, so "off" can never repeat anything', () => {
    expect(setPerfProbe('off', 9)).toEqual({ term: 'off', repeat: 0 });
  });

  // The load-bearing one: every term, at a repeat count high enough that any
  // leaked mutation would compound visibly, must leave the simulation bit-for-
  // bit identical to the un-probed run.
  const terms = PROBE_TERMS.filter(t => t !== 'off');
  for (const term of terms) {
    it(`leaves the sim bit-identical when repeating '${term}'`, () => {
      const base = run(40);
      const probed = run(40, { probeTerm: term, probeRepeat: 5 });

      // Member state is the contract for every term without exception: the
      // steering result must not depend on whether the probe ran.
      expect(probed.members).toEqual(base.members);

      if (term === 'updateMember') {
        // The one term whose repeats are visible outside the sim, by
        // construction — the backend really does receive the extra calls.
        // They must carry identical transforms (the probe re-sends the same
        // pose; it does not re-derive it), so the rendered result is the same.
        expect(probed.writes.length).toBe(base.writes.length * 6);
        const dedup = w => w.filter((_, i) => i % 6 === 0);
        expect(dedup(probed.writes)).toEqual(base.writes);
      } else {
        expect(probed.writes).toEqual(base.writes);
      }
    });
  }

  it('actually re-runs the term — a no-op probe would prove nothing', () => {
    // Guard against the tests above passing because the probe never fired.
    // `updateMember` is the one term whose repeats are externally visible: the
    // backend genuinely receives the extra calls (they write the same
    // transform, which is why the sim is unaffected).
    let calls = 0;
    const cfg = makeCfg();
    const backend = new NullRenderBackend();
    backend.updateMember = () => { calls++; };
    const squad = new Squad(1, makeDef(), backend, cfg);
    squad.setPose(200, 0, 300, 0);
    const query = () => [];

    setPerfProbe('off', 0);
    squad.update(1 / 30, 0, query, makePassability());
    const off = calls;

    calls = 0;
    setPerfProbe('updateMember', 4);
    squad.update(1 / 30, 1 / 30, query, makePassability());
    const on = calls;

    expect(off).toBeGreaterThan(0);
    expect(on).toBe(off * 5);   // the real call + 4 repeats
  });
});
