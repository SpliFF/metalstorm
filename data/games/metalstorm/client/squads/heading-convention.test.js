// heading-convention.test.js — pins squad-member facing to the ONE convention
// the engine and the renderer already share (docs/coordinate-system.md).
//
// Regression for "tanks drive backwards" (USER-REPORTED 2026-08-29, measured
// on `crossing_standoff`): every velocity-steered member derived its heading
// with `Math.atan2(vx, vz)` — the legacy left-handed +Z-forward reading —
// while the render matrix and the wire both put model forward on −Z. The sim
// was innocent (engine velocity·frontdir = +0.9995); members simply drew
// exactly 180° reversed, so hulls read as reversing.
//
// The whole suite passed through that bug, because nothing asserted which way
// a moving member FACES. That is what this file does.
//
// SECOND HALF (2026-08-29): the same convention, applied to WHERE members
// stand rather than which way they point. Fixing facing left `formation.js`'s
// slot templates still authored +Z-forward, so a column's lead slot sat at the
// REAR — the squad drove correctly-facing but back-to-front. Nothing asserted
// slot geometry against the heading either, so that bug also passed the suite.
// `formation slot geometry` below closes it: the templates and the facing they
// are rotated by are now pinned to the SAME −Z-forward reading, in one file, so
// they cannot drift apart again.

import { describe, it, expect } from 'vitest';
import { headingFromVelocity, velocityFromHeading, capTurnRate } from './steering.js';
import { buildSlots, slotToWorld } from './formation.js';
import { Member } from './member.js';

/** The rotation `SquadRenderBackend.writeYawMatrix` writes, applied to the
 *  model's forward axis. Kept as literal arithmetic (not an import) because
 *  the renderer lives in client/src TypeScript, outside this suite's reach —
 *  mirror any change to writeYawMatrix here.
 *
 *  writeYawMatrix rows (row-vector convention, v' = v·M):
 *      [ c 0 -s ]   [ 0 1 0 ]   [ s 0 c ]
 *  Model forward is −Z = (0, 0, −1), so v' = (−s, 0, −c). */
function renderedForward(headingY) {
  return { x: -Math.sin(headingY), z: -Math.cos(headingY) };
}

/** The engine's GetVectorFromHeading (rts/System/SpringMath.inl): heading 0
 *  faces −Z, and `frontdir = (−sin θ, 0, −cos θ)`. Identical by construction
 *  to renderedForward — that identity is the whole convention. */
const engineFrontdir = renderedForward;

const backend = { groundHeight: () => 0 };

describe('heading convention', () => {
  it('renders a member facing the way it travels', () => {
    // Cardinal + oblique travel directions.
    const dirs = [
      { x: 0, z: 1 }, { x: 0, z: -1 }, { x: 1, z: 0 }, { x: -1, z: 0 },
      { x: 0.6, z: 0.8 }, { x: -0.6, z: -0.8 }, { x: 0.28, z: -0.96 },
    ];
    for (const d of dirs) {
      const fwd = renderedForward(headingFromVelocity(d.x, d.z));
      expect(fwd.x).toBeCloseTo(d.x, 9);
      expect(fwd.z).toBeCloseTo(d.z, 9);
    }
  });

  it('agrees with the engine/wire heading for the same facing', () => {
    // sq.heading arrives off the wire as the engine's heading. A member
    // travelling along that unit's frontdir must land on the SAME angle —
    // this is the equality the bug broke (member 0 vs squad π).
    for (let h = -Math.PI; h < Math.PI; h += Math.PI / 8) {
      const f = engineFrontdir(h);
      const memberHeading = headingFromVelocity(f.x, f.z);
      // Compare as directions, so ±2π wrapping can't produce a false failure.
      expect(Math.cos(memberHeading)).toBeCloseTo(Math.cos(h), 9);
      expect(Math.sin(memberHeading)).toBeCloseTo(Math.sin(h), 9);
    }
  });

  it('a member driving +Z faces +Z, not −Z', () => {
    // The reported symptom, at its smallest: drive due +Z and check the hull
    // points +Z. Pre-fix this produced headingY 0 → rendered forward (0, −1).
    const m = new Member(1, {});
    for (let i = 0; i < 200; i++) m.integrate(0, 2.5, 1 / 30, backend);
    expect(m.vz).toBeGreaterThan(2);
    const fwd = renderedForward(m.headingY);
    expect(fwd.z).toBeCloseTo(1, 3);
    expect(fwd.x).toBeCloseTo(0, 3);
  });

  it('faces travel from the air integrator too', () => {
    const m = new Member(2, {});
    m.integrateAir(-3, 0, 0, 1 / 30);
    const fwd = renderedForward(m.headingY);
    expect(fwd.x).toBeCloseTo(-1, 6);
    expect(fwd.z).toBeCloseTo(0, 6);
  });

  it('round-trips heading through velocity unchanged', () => {
    // headingFromVelocity / velocityFromHeading are a matched pair: the
    // air + naval steerers reconstruct a velocity from the capped heading,
    // so a sign flip applied to only one of them would turn a cosmetic bug
    // into aircraft physically flying backwards.
    const out = { x: 0, y: 7, z: 0 };
    for (const v of [{ x: 3, z: 4 }, { x: -5, z: 12 }, { x: 0, z: -2 }]) {
      const speed = Math.hypot(v.x, v.z);
      velocityFromHeading(headingFromVelocity(v.x, v.z), speed, out);
      expect(out.x).toBeCloseTo(v.x, 9);
      expect(out.z).toBeCloseTo(v.z, 9);
      expect(out.y).toBe(7); // y is the caller's; the helper must not touch it
    }
  });

  it('is turn-rate-cap safe (the π offset is not a special case)', () => {
    // capTurnRate works on wrapped differences, so re-basing every heading by
    // π must not change how far a member turns in one step.
    const cur = headingFromVelocity(0, 1);      // facing +Z
    const want = headingFromVelocity(1, 0);     // wants +X (a 90° turn)
    const stepped = capTurnRate(cur, want, 0.5, 1 / 30);
    const turned = Math.abs(Math.atan2(
      Math.sin(stepped - cur), Math.cos(stepped - cur)));
    expect(turned).toBeCloseTo(0.5 / 30, 9);
  });
});

describe('formation slot geometry (§9) — the same −Z-forward convention', () => {
  /** Project each slot's WORLD offset from the squad centroid onto the squad's
   *  travel direction. Positive = ahead of the centroid. Everything goes
   *  through the real `slotToWorld` and the real `renderedForward`, so this
   *  measures what a viewer sees, not what the template literal says. */
  function alongTravel(type, count, radius, headingY) {
    const d = renderedForward(headingY);
    const cx = 1700, cz = -430;           // arbitrary, non-zero: catches a
    const out = { x: 0, z: 0 };           // centroid term leaking into the dot
    return buildSlots(type, count, radius).map((slot) => {
      slotToWorld(slot, cx, cz, headingY, out);
      return (out.x - cx) * d.x + (out.z - cz) * d.z;
    });
  }

  // Headings deliberately including the cardinals, where a sign error is
  // invisible on one axis, and obliques, where it is not.
  const HEADINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, -2.4, 2.95];

  it('puts a column\'s lead slot at the FRONT, whatever direction it moves', () => {
    // The regression, at its smallest. Pre-fix, member 0 sat at local z = +r,
    // which `slotToWorld` places directly BEHIND the centroid — so the "lead"
    // vehicle of a moving column trailed the whole formation.
    for (const h of HEADINGS) {
      const along = alongTravel('column', 8, 24, h);
      const lead = along[0];
      for (let i = 1; i < along.length; i++) {
        expect(`h=${h.toFixed(2)} slot ${i} behind lead: ${lead > along[i]}`)
          .toBe(`h=${h.toFixed(2)} slot ${i} behind lead: true`);
      }
      expect(lead).toBeCloseTo(24, 6);    // exactly +radius ahead
    }
  });

  it('files a column back from the lead in member order', () => {
    // Not just "0 is furthest forward" — the whole file is ordered, so a
    // template that merely moved the lead to the front while leaving the tail
    // scrambled still fails.
    for (const h of HEADINGS) {
      const along = alongTravel('column', 8, 24, h);
      for (let i = 1; i < along.length; i++) {
        expect(`h=${h.toFixed(2)} ${i - 1} ahead of ${i}: ${along[i - 1] > along[i]}`)
          .toBe(`h=${h.toFixed(2)} ${i - 1} ahead of ${i}: true`);
      }
    }
  });

  it('points a wedge\'s apex forward and trails its wings behind', () => {
    for (const h of HEADINGS) {
      const along = alongTravel('wedge', 7, 30, h);
      expect(along[0]).toBeCloseTo(30, 6);
      for (let i = 1; i < along.length; i++) {
        expect(`h=${h.toFixed(2)} wing ${i} behind apex: ${along[0] > along[i]}`)
          .toBe(`h=${h.toFixed(2)} wing ${i} behind apex: true`);
      }
      // A wedge is an arrowhead, not a column: the wings straddle the axis.
      const d = renderedForward(h);
      const lateral = buildSlots('wedge', 7, 30).map((s) => {
        const o = { x: 0, z: 0 };
        slotToWorld(s, 0, 0, h, o);
        return o.x * -d.z + o.z * d.x;     // perpendicular component
      });
      expect(Math.min(...lateral)).toBeLessThan(-1);
      expect(Math.max(...lateral)).toBeGreaterThan(1);
    }
  });

  it('keeps the formations that have no forward axis unbiased', () => {
    // `line` abreast and `blob` as a disc: the fix must not have quietly
    // pushed either off-centre. These two are also the reason the parity
    // re-baseline is scoped — they are bit-identical across the change.
    for (const h of HEADINGS) {
      const line = alongTravel('line', 6, 24, h);
      for (const v of line) expect(v).toBeCloseTo(0, 9);
      const blob = alongTravel('blob', 12, 24, h);
      const mean = blob.reduce((a, b) => a + b, 0) / blob.length;
      expect(Math.abs(mean)).toBeLessThan(24 * 0.5);
    }
  });

  it('agrees with a member that is actually driving that way', () => {
    // Ties the two halves of this file together: the direction a member FACES
    // after steering, and the direction its formation calls "ahead", must be
    // the same vector. This is the assertion that would have caught the
    // original defect from either side.
    const m = new Member(3, {});
    for (let i = 0; i < 200; i++) m.integrate(1.8, -1.4, 1 / 30, backend);
    const travel = { x: m.vx, z: m.vz };
    const len = Math.hypot(travel.x, travel.z);
    const along = alongTravel('column', 5, 20, m.headingY);
    expect(len).toBeGreaterThan(1);
    expect(along[0]).toBeGreaterThan(along[along.length - 1]);
    // And the lead slot's world offset points the same way the hull does.
    const d = renderedForward(m.headingY);
    expect(d.x).toBeCloseTo(travel.x / len, 3);
    expect(d.z).toBeCloseTo(travel.z / len, 3);
  });
});
