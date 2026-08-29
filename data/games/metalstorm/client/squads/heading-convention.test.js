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

import { describe, it, expect } from 'vitest';
import { headingFromVelocity, velocityFromHeading, capTurnRate } from './steering.js';
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
