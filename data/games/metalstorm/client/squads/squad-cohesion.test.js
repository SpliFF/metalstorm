// squad-cohesion.test.js — headless coverage for PLAN-metalstorm-squad-cohesion.md
// tasks 1-8: soft-leash pull, the centroid teleport-guard, movement-profile
// steerer selection, air loiter/turn-cap, and naval column compaction at a
// chokepoint. No Babylon/DOM — pure logic against NullRenderBackend, matching
// squad-sync.test.js's headless pattern.

import { describe, it, expect } from 'vitest';
import { Squad } from './squad.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { softLeashPull, wrapAngle, capTurnRate } from './steering.js';
import { createPassability } from './passability.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

function makeDef(overrides = {}) {
  return {
    defId: 'unit_test',
    squadSize: 6,
    formationType: 'blob',
    formationRadius: 20,
    maxSpeed: 5,
    customParams: {},
    ...overrides,
  };
}

describe('soft-leash pull (steering.js, §1)', () => {
  it('is zero inside the soft radius and centripetal beyond it, scaling with overshoot', () => {
    const out = { x: 0, z: 0 };
    softLeashPull(50, 0, 0, 0, 40, 2, out); // px=50 (dist 50), centroid at origin, soft radius 40
    expect(out.x).toBeLessThan(0); // pulled toward centroid (negative x)
    expect(out.z).toBeCloseTo(0, 5);
    const nearMag = Math.hypot(out.x, out.z);

    softLeashPull(0, 0, 0, 0, 40, 2, out);
    expect(out.x).toBe(0); expect(out.z).toBe(0); // inside radius: no pull

    softLeashPull(90, 0, 0, 0, 40, 2, out); // further over -> stronger pull
    const farMag = Math.hypot(out.x, out.z);
    expect(farMag).toBeGreaterThan(nearMag);
  });
});

describe('straggler reels in via the layered leash (§1, squad-level)', () => {
  it('a member displaced beyond softLeash but within the hard clamp closes in monotonically, never needing the hard clamp', () => {
    const backend = new NullRenderBackend();
    const cfg = makeCfg();
    const def = makeDef({ formationType: 'blob', formationRadius: 20 }); // slot 0 is {0,0} for blob
    const sq = new Squad(1, def, backend, cfg);
    sq.setPose(0, 0, 0, 0);

    // Member 0's slot is the centroid itself (blob's first ring point).
    // Displace it to just inside the hard leash (1.6x formationRadius = 32)
    // but well beyond the soft leash (soldiers profile softLeash = 1.0x = 20).
    const m = sq.members[0];
    m.x = 28; m.z = 0;
    const hardLeash = def.formationRadius * cfg.maxMemberDistance;
    expect(Math.hypot(m.x - sq.cx, m.z - sq.cz)).toBeLessThan(hardLeash);

    let prevDist = Math.hypot(m.x - sq.cx, m.z - sq.cz);
    for (let i = 0; i < 40; i++) {
      sq.update(0.05, i * 0.05, () => []);
      const dist = Math.hypot(m.x - sq.cx, m.z - sq.cz);
      expect(dist).toBeLessThanOrEqual(prevDist + 1e-6); // monotonic reel-in
      expect(dist).toBeLessThan(hardLeash - 1e-6);        // never hits the hard clamp
      prevDist = dist;
    }
    expect(prevDist).toBeLessThan(20); // real progress made reeling the straggler in
  });
});

describe('centroid teleport-guard (§3)', () => {
  it('rigid-translates members and reseeds the trail on a large centroid jump', () => {
    const backend = new NullRenderBackend();
    const cfg = makeCfg();
    const sq = new Squad(2, makeDef(), backend, cfg);
    sq.setPose(0, 0, 0, 0);
    sq.update(0.05, 0, () => []);
    const before = sq.members.map((m) => ({ x: m.x, z: m.z }));

    // Jump well beyond cfg.teleportThreshold (200 elmos).
    sq.setPose(1000, 0, 1000, 0);

    for (let i = 0; i < sq.members.length; i++) {
      expect(sq.members[i].x).toBeCloseTo(before[i].x + 1000, 5);
      expect(sq.members[i].z).toBeCloseTo(before[i].z + 1000, 5);
    }
    // Trail reseeded at the new centroid, not a stale corridor from the old position.
    expect(sq._trail.length).toBe(1);
    expect(sq._trail[0]).toEqual({ x: 1000, z: 1000 });
  });

  it('does NOT rigid-translate on ordinary sub-threshold motion — steering handles it', () => {
    const backend = new NullRenderBackend();
    const cfg = makeCfg();
    const sq = new Squad(3, makeDef(), backend, cfg);
    sq.setPose(0, 0, 0, 0);
    sq.update(0.05, 0, () => []);
    const before = sq.members.map((m) => ({ x: m.x, z: m.z }));

    sq.setPose(5, 0, 5, 0); // well under the 200-elmo threshold

    for (let i = 0; i < sq.members.length; i++) {
      expect(sq.members[i].x).toBeCloseTo(before[i].x, 5);
      expect(sq.members[i].z).toBeCloseTo(before[i].z, 5);
    }
  });
});

describe('movement-profile steerer selection (§8)', () => {
  it('routes fighters/bombers to air, ships/subs to naval, everything else to ground', () => {
    const backend = new NullRenderBackend();
    const cfg = makeCfg();
    const air = new Squad(4, makeDef({ customParams: { ms_class: 'fighters' } }), backend, cfg);
    const naval = new Squad(5, makeDef({ customParams: { ms_class: 'ships' } }), backend, cfg);
    const ground = new Squad(6, makeDef({ customParams: { ms_class: 'tanks' } }), backend, cfg);
    expect(air.profile.steerer).toBe('air');
    expect(naval.profile.steerer).toBe('naval');
    expect(ground.profile.steerer).toBe('ground');
    expect(ground.profile.moveClass).toBe('VEH');
  });
});

describe('air cohesion: loiter + turn-rate cap + altitude bands (§6)', () => {
  it('a holding air squad orbits its centroid at ~formation_radius, never stalling, with distinct member altitudes', () => {
    const backend = new NullRenderBackend();
    const cfg = makeCfg();
    const def = makeDef({
      squadSize: 4, formationType: 'line', formationRadius: 60, maxSpeed: 8,
      customParams: { ms_class: 'fighters' },
    });
    const sq = new Squad(7, def, backend, cfg);
    sq.setPose(0, 100, 0, 0); // stationary centroid — squad is "holding"

    let nowSec = 0;
    const distances = [];
    for (let i = 0; i < 200; i++) {
      nowSec += 1 / 30;
      sq.update(1 / 30, nowSec, () => []);
      for (const m of sq.members) {
        const speed = Math.hypot(m.vx, m.vz);
        expect(speed).toBeGreaterThan(0.5); // constant forward motion — never stalls
        if (i > 60) distances.push(Math.hypot(m.x - sq.cx, m.z - sq.cz));
      }
    }
    const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
    expect(avgDist).toBeGreaterThan(def.formationRadius * 0.5);
    expect(avgDist).toBeLessThan(def.formationRadius * 1.5);

    // Altitude bands: members don't co-locate vertically.
    const altOffsets = new Set(sq.members.map((m) => m.altitudeOffset));
    expect(altOffsets.size).toBe(sq.members.length);
  });

  it('capTurnRate never turns faster than maxRate*dt', () => {
    const newH = capTurnRate(0, Math.PI, 1, 0.1); // huge desired turn, capped rate
    expect(Math.abs(wrapAngle(newH - 0))).toBeCloseTo(0.1, 5);
  });
});

describe('naval cohesion: column compaction at a chokepoint (§7)', () => {
  it('a wide ship squad forced through a strait compresses its lateral (line-astern) spread', () => {
    // Sampler: deep water everywhere except two land strips leaving a narrow
    // water channel (a strait) along Z, centred on x=0, flanking the squad's
    // line formation (heading 0 => local-X lateral spread maps to world X).
    const sampler = {
      bounds: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 },
      waterLevel: 0,
      heightAt(x, z) {
        if (Math.abs(x) < 12) return -50; // deep water channel
        return 50; // land either side
      },
    };
    const cfg = makeCfg();
    const passability = createPassability(sampler, cfg);
    const backend = new NullRenderBackend();
    const def = makeDef({
      squadSize: 5, formationType: 'line', formationRadius: 60, maxSpeed: 4,
      customParams: { ms_class: 'ships' },
    });
    const sq = new Squad(8, def, backend, cfg);
    sq.setPose(0, 0, 0, 0); // wide line formation straddling the strait

    const initialSpread = spreadX(sq);

    let nowSec = 0;
    for (let i = 0; i < cfg.modeHysteresisFrames + 90; i++) {
      nowSec += 1 / 30;
      sq.update(1 / 30, nowSec, () => [], passability);
    }

    const columned = sq.members.some((m) => m.mode === 'COLUMN');
    expect(columned).toBe(true);
    expect(spreadX(sq)).toBeLessThan(initialSpread);
  });
});

function spreadX(sq) {
  const xs = sq.members.map((m) => m.x);
  return Math.max(...xs) - Math.min(...xs);
}
