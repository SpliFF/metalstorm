// squad-soa-parity.test.js — OO vs SoA engine parity
// (PLAN-metalstorm-squad-performance.md §14 S6).
//
// ONE scripted sequence, run twice through `SquadManager` — once on
// `engine:'oo'` (Squad/Member), once on `engine:'soa'` (SquadRec + store +
// kernel) — and the two runs compared field by field. Everything that decides
// what a player sees is in the comparison: the exact backend call sequence
// (create/destroy/release/wreck/icon, in order, with the squad+member identity
// each call carries), per-frame alive counts and tiers, and every member's
// world transform to 1e-3 elmo.
//
// The tight tolerance is the point (§14 S6): the SoA kernel is a line-for-line
// port of the OO steppers, so the two engines run the SAME arithmetic in the
// SAME order. Any drift at all means the port diverged — this is not a
// "close enough visually" bar.
//
// Determinism, and why the suite needs it (§10f):
//   * `cfg.random` is seeded here, so the death-stagger draw is identical in
//     both engines. Both draw from `cfg.random`, one draw per stagger batch,
//     in the same place — see config.js's `random` note.
//   * `pseudoRandom(id)` (the fallback victim tie-break) is already
//     deterministic and shares one formula across the two files.
//   * `governorEscalateFrames` is pinned absurdly high so the frame-time
//     governor can never leave ladder level 0. Without that pin the schedule
//     (which squads step, which coast) would depend on how busy the machine
//     running CI happens to be, and a parity failure would mean nothing. The
//     final assertion checks the pin actually held.
//   * `groundHeight` is a pure function of (x, z), so terrain sampling is
//     reproducible without a heightmap.
//
// Sensitivity (S6 acceptance): breaking one kernel stage must break this
// suite. Verified by neutralising `soa-kernel.js`'s separation deadband
// (`if (r - d < deadband) continue` → `if (r - d < 0) continue`), which fails
// the position comparison at frame 0 of the first stepped frame; and by
// reverting the `cfg.random` threading in `soa-squad.js`, which fails the
// call-sequence comparison on the stagger drip.
//
// ⚠ TWO THINGS THIS SUITE MEASURED THAT THE MILESTONE DID NOT PREDICT — both
// are in the plan file (§14 S6 field notes) and one is an open design call:
//
//  1. The engines DO NOT agree once the neighbour cap truncates. `cfg.
//     neighbourCap` (shipped 8) is applied by the broad-phase in ENUMERATION
//     order, before the distance filter, and the OO Map grid and the SoA CSR
//     grid enumerate differently — so each keeps a different eight candidates
//     and one engine's member gets a separation push the other's never sees.
//     Divergence is macroscopic (1.19 elmo by frame 109 on this script), and
//     it is not a port bug: neither order is more correct than the other,
//     because the cap is distance-blind in BOTH. Pinned by its own case at the
//     bottom of this file, with the design question in the plan. The parity
//     script therefore runs at a cap high enough never to truncate — that is
//     what makes it a test of the PORT rather than of two arbitrary orders.
//  2. With truncation out of the way, the residual is Float32 storage: the SoA
//     store holds positions in Float32Array and the OO engine in doubles, so
//     every member position is rounded at ~1.2e-4 elmo at map coordinates
//     ~2000. The drift is bounded, not exponential. §14 S6's stated 1e-3
//     tolerance is therefore unreachable at 120 frames BY CONSTRUCTION; the
//     bars below are 1e-3 over the first 30 frames (where a real divergence
//     shows immediately) and 3x the measured residual thereafter.
//
// ── RE-BASELINE 2026-08-29 (formation.js −Z-forward slot templates) ─────────
// The heading-convention sweep re-signed `column`/`wedge` slot z, so squad 2
// (`vehicleDef`, formationType 'wedge') now drives a mirrored formation. Its
// trajectory is more sensitive to the SAME f32 storage residual, and the late
// bars below moved with it. What was checked BEFORE touching a number, because
// re-baselining a parity bar is exactly how a real divergence gets waved
// through:
//
//   * Squads 1 and 3 (`groundDef`, formationType 'line') are BIT-IDENTICAL
//     across the change — same worst residual to the last digit (sq1 late
//     1.5830572287995892e-3 at f107 m0; sq3 1.4173818649396708e-3 at f100 m1),
//     same trajectories. `line` slots sit at z 0 and `blob` is a disc, so
//     neither template moved; only the wedge squad did. The drift is confined
//     to exactly the squads whose slots were mirrored.
//   * The residual is STILL pure f32 storage, not a port divergence. Verified
//     by widening every Float32Array in the SoA path (soa-store, soa-grid,
//     soa-kernel, soa-squad, squad-manager, governor, passability) to
//     Float64Array and re-running this script: the two engines then agree to
//     4.5e-13 — double round-off — on all three squads, with sq2's worst at
//     the SAME frame/member (f54 m3) it occupies at f32. Widening the store
//     alone already cut sq2's worst from 1.34e-2 to 9.3e-4. A genuine
//     divergence does not scale with storage width.
//   * The backend call SEQUENCE still matches between engines exactly. It did
//     change in absolute terms (83 -> 86 calls): squad 2's members physically
//     stand somewhere else now, so proximity-scored victim selection picks a
//     different one (destroy 2:0 where it used to pick 2:1, and a matching
//     shift in the icon-tier create/destroy drip). Both engines make the same
//     new choice, in the same order — that is behaviour following geometry,
//     not drift.
//   * The EARLY bars did NOT move and were not touched: worst position
//     residual over the first 30 frames is 5.8366e-4 (f27 sq3 m0) and worst
//     heading 2.9403e-4 (f1 sq3 m8), both unchanged. That is deliberate — the
//     early window is where a real divergence announces itself (the deadband
//     neutralisation lands at 3e-3 on frame 0), so it keeps its full
//     sensitivity and the re-baseline is confined to the late window.
//   * Sensitivity re-confirmed AFTER moving the bars, not assumed: the header's
//     deadband mutation still fails this suite at the new numbers.
//
// Measured worsts after the change (f32, the shipped path):
//     position  early 5.8366e-4 (f27 sq3 m0)   late 1.3404e-2 (f54 sq2 m3)
//     heading   early 2.9403e-4 (f1 sq3 m8)    late 2.6213e-3 (f52 sq2 m3)
//     gait      late 6.4454e-4 (f109 sq2 m3)
//     call nums 1.4810e-3 (destroy 1:0[2]) — unchanged, so its bar stays 5e-3

import { describe, it, expect } from 'vitest';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { isAlive, isReleased } from './soa-store.js';
import { queryInto } from './soa-grid.js';

// Deterministic LCG (numerical recipes constants) — the seeded `cfg.random`.
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Reproducible "terrain" — no heightmap in a headless test, but a flat plane
// would leave the ground-snap path untested on both engines at once.
function groundAt(x, z) {
  return 12 + Math.sin(x * 0.011) * 3 + Math.cos(z * 0.013) * 2;
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/** Records the backend call SEQUENCE in terms both engines can express: the
 *  owning squad id and the LOCAL member index, never the opaque handle (the
 *  two engines number handles from their own allocators, so comparing handles
 *  would compare bookkeeping rather than behaviour).
 *
 *  A call's discrete identity (`tag`) and its numeric payload (`nums`) are kept
 *  APART on purpose: the tag sequence must match exactly — that is the
 *  behaviour — while the numbers carry the f32 storage residual and are
 *  compared under the same tolerance as member positions. Baking a coordinate
 *  into the tag would turn every position assertion into an exact-equality one
 *  by the back door. */
class RecordingBackend extends NullRenderBackend {
  constructor() {
    super();
    this._next = 1;
    this._id = new Map();     // handle -> "squadId:memberId"
    this.calls = [];
  }
  createMember(squadId, memberId, visual) {
    const handle = this._next++;
    this._id.set(handle, `${squadId}:${memberId}`);
    this.calls.push({ tag: `create ${squadId}:${memberId} v${visual.variant}`, nums: [] });
    return handle;
  }
  destroyMember(handle, death) {
    this.calls.push({
      tag: `destroy ${this._id.get(handle)}`,
      nums: [death.x, death.y, death.z, death.dirX, death.dirZ],
    });
  }
  releaseMember(handle) {
    this.calls.push({ tag: `release ${this._id.get(handle)}`, nums: [] });
  }
  spawnWreck(x, y, z, headingY, visual) {
    const handle = this._next++;
    this.calls.push({ tag: `wreck ${visual.defId}:${visual.variant}`, nums: [x, y, z, headingY] });
    return handle;
  }
  despawnWreck() { this.calls.push({ tag: 'despawnWreck', nums: [] }); }
  groundHeight(x, z) { return groundAt(x, z); }
  setIcon(squadId, x, y, z, radius) {
    this.calls.push({ tag: `icon ${squadId}`, nums: [x, y, z, radius] });
  }
  clearIcon(squadId) { this.calls.push({ tag: `clearIcon ${squadId}`, nums: [] }); }
}

function groundDef() {
  return {
    defId: 'ms_rifles',
    squadSize: 10,
    formationType: 'line',
    formationRadius: 24,
    maxSpeed: 40,
    customParams: { ms_class: 'infantry', squad_size: '10' },
  };
}

function vehicleDef() {
  return {
    defId: 'ms_apc',
    squadSize: 6,
    formationType: 'wedge',
    formationRadius: 30,
    maxSpeed: 60,
    customParams: { ms_class: 'vehicle', squad_size: '6' },
  };
}

/** Uniform member reader — the ONE place the two engines' storage differs. */
function readMembers(mgr, sq) {
  const out = [];
  if (mgr.engine === 'soa') {
    const st = mgr.store;
    for (let i = 0; i < sq.size; i++) {
      const s = sq.base + i;
      out.push({
        x: st.mx[s], y: st.my[s], z: st.mz[s],
        heading: st.mHeading[s], gait: st.mGait[s],
        alive: isAlive(st, s), released: isReleased(st, s),
      });
    }
  } else {
    for (let i = 0; i < sq.size; i++) {
      const m = sq.members[i];
      out.push({
        x: m.x, y: m.y, z: m.z,
        heading: m.headingY, gait: m.gait,
        alive: m.alive, released: m.released,
      });
    }
  }
  return out;
}

function snapshot(mgr) {
  const squads = [];
  for (const [id, sq] of [...mgr.squads.entries()].sort((a, b) => a[0] - b[0])) {
    squads.push({
      id,
      lod: sq.lod,
      aliveCount: sq.aliveCount,
      transportState: sq.transportState,
      cx: sq.cx, cy: sq.cy, cz: sq.cz, heading: sq.heading,
      members: readMembers(mgr, sq),
    });
  }
  return squads;
}

const DT = 1 / 60;
const FRAMES = 120;

/** The scripted sequence, identical for both engines (§14 S6): construct via
 *  syncSquad, 120 frames of syncPose along a curved path + update(1/60),
 *  staged strength drops (one of them while the squad is at icon tier),
 *  impact/threat hints, a full→icon→full LOD round-trip, a transport
 *  load/unload, and a removeSquad cascade. */
function runScript(engine) {
  const backend = new RecordingBackend();
  const mgr = new SquadManager(backend, {
    engine,
    random: seededRandom(20260814),
    // See the header: the governor must not be allowed to react to the CI
    // machine's load, or the two runs schedule different work.
    governorEscalateFrames: 1e9,
    // Above every member's candidate count in this fixture, so the cap never
    // truncates and the two broad-phases return the same SET. See header note
    // 1 and `the neighbour cap truncates differently` at the bottom of the
    // file: at the shipped cap of 8 these two engines are not comparable, and
    // that is a filed design question, not something to hide inside a
    // tolerance here.
    neighbourCap: 32,
  });

  const p0 = { x: 2000, z: 2000 };
  mgr.syncSquad(1, {
    x: p0.x, y: groundAt(p0.x, p0.z), z: p0.z, heading: 0,
    health: 100, maxHealth: 100,
  }, groundDef());
  mgr.syncSquad(2, {
    x: p0.x + 90, y: groundAt(p0.x + 90, p0.z + 40), z: p0.z + 40, heading: 0.4,
    health: 100, maxHealth: 100,
  }, vehicleDef());
  // Squad 3 is the FOG squad: it is never told about an impact or a threat, so
  // its casualties take the third rung of squad-casualties §3.3 — the
  // edge/pseudoRandom fallback score — and the fog death-direction. Squads 1
  // and 2 cannot reach that rung: `reportThreat` sets a bearing that never
  // expires, so every later un-hinted drop on them scores by threat flank.
  // (Found by mutation: flipping the SoA fallback score's sign changed nothing
  // until this squad existed.) Parked far away so it neither steers against
  // the other two nor adds to their neighbour candidates.
  mgr.syncSquad(3, {
    x: p0.x + 1200, y: groundAt(p0.x + 1200, p0.z - 900), z: p0.z - 900, heading: 2.1,
    health: 100, maxHealth: 100,
  }, groundDef());

  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    const t = f * DT;
    // Curved path — a constant-radius arc, so heading changes every frame and
    // the slot-projection / trail / repack paths all stay live.
    const a = t * 0.9;
    const x1 = p0.x + 160 * Math.sin(a);
    const z1 = p0.z + 140 * (1 - Math.cos(a));
    const h1 = a;
    mgr.syncPose(1, { x: x1, y: groundAt(x1, z1), z: z1, heading: h1 });
    // Squad 2 runs a tighter arc that closes on squad 1 — inter-squad
    // separation (the deadband stage) is only exercised while they overlap.
    const x2 = p0.x + 70 + 90 * Math.sin(a * 1.3);
    const z2 = p0.z + 40 + 80 * (1 - Math.cos(a * 1.3));
    mgr.syncPose(2, { x: x2, y: groundAt(x2, z2), z: z2, heading: a * 1.3 + 0.4 });

    if (f === 20) {
      // Threat bearing then impact, then the strength drop they explain: the
      // burst (hinted) victim-selection path.
      mgr.reportThreat({ squadId: 1, x: x1 + 200, z: z1 - 150 });
      mgr.reportImpact({ squadId: 1, x: x1 + 12, z: z1 + 6, radius: 30 });
      mgr.syncStrength(1, 80, 100);
    }
    // Un-hinted drop a full impact-validity window later: the attrition
    // (staggered) path, which is the one that draws from cfg.random.
    if (f === 45) mgr.syncStrength(1, 52, 100);
    // Spatial (no squadId) fan-out — routes by centroid distance in both.
    if (f === 50) mgr.reportImpact({ x: x2, z: z2, radius: 120 });

    // LOD round-trip on squad 2, with a strength drop taken while iconised.
    if (f === 55) mgr.squads.get(2).lod = 'icon';
    if (f === 62) mgr.syncStrength(2, 61, 100);
    if (f === 70) mgr.squads.get(2).lod = 'full';

    // Transport: load squad 1 onto a carrier, unload it 15 frames later.
    if (f === 80) mgr.unitLoaded(1, 900, x1 + 60, groundAt(x1 + 60, z1 + 60), z1 + 60);
    if (f === 95) mgr.unitUnloaded(1, x1 + 120, groundAt(x1 + 120, z1 + 90), z1 + 90, false);

    // Squad 3 walks a straight line and loses members twice with no hint and
    // no bearing — the fallback rung (see its construction above).
    const x3 = p0.x + 1200 + f * 0.8, z3 = p0.z - 900 + f * 0.35;
    mgr.syncPose(3, { x: x3, y: groundAt(x3, z3), z: z3, heading: 2.1 });
    if (f === 35) mgr.syncStrength(3, 72, 100);
    if (f === 105) mgr.syncStrength(3, 41, 100);

    // Cascade a whole squad away, and keep driving so the removal's own
    // wreck/FX drip is inside the compared window.
    if (f === 110) mgr.removeSquad(2);

    mgr.update(DT);
    frames.push(snapshot(mgr));
  }

  mgr.removeSquad(1);
  return { calls: backend.calls, frames, ladderLevel: mgr._governor.ladderLevel };
}

// One run each, shared by every case below (the script is deterministic, so
// running it once per assertion would only cost time).
const oo = runScript('oo');
const soa = runScript('soa');

describe('§14 S6 — OO vs SoA engine parity over one scripted sequence', () => {
  it('the script itself is non-trivial (guards against a vacuous pass)', () => {
    // A parity suite that compares two empty traces passes forever. Pin the
    // shape of the script's own output so a future change that silently stops
    // spawning/killing/iconising fails HERE rather than reading as parity.
    expect(oo.frames.length).toBe(FRAMES);
    const kind = (k) => oo.calls.filter((c) => c.tag.startsWith(k)).length;
    expect(kind('create')).toBeGreaterThanOrEqual(16);
    expect(kind('destroy')).toBeGreaterThanOrEqual(8);
    expect(kind('release')).toBeGreaterThan(0);
    expect(kind('wreck')).toBeGreaterThan(0);
    // NOT asserted: `setIcon`/`clearIcon`. Neither engine calls them any more —
    // M23 gave the icon tier an art tier (keep `cfg.iconMemberCount` members)
    // instead of a marker, and the RenderBackend's icon seam is now unused by
    // squad logic. Recorded by the backend above so that if a producer comes
    // back (PLAN-macro-map §3's strategic glyphs), parity covers it the day it
    // lands rather than the day someone remembers this file.
    // Members really moved (the steppers ran), not just the centroid.
    const first = oo.frames[0][0].members[0];
    const last = oo.frames[FRAMES - 1][0].members[0];
    expect(Math.hypot(last.x - first.x, last.z - first.z)).toBeGreaterThan(10);
    // And the governor pin held on both engines — see the header.
    expect(oo.ladderLevel).toBe(0);
    expect(soa.ladderLevel).toBe(0);
  });

  it('drives the identical backend call sequence, in order', () => {
    expect(soa.calls.map((c) => c.tag)).toEqual(oo.calls.map((c) => c.tag));
  });

  it('passes the same numbers to each of those calls (death FX, wreck poses)', () => {
    // Re-measured at the 2026-08-29 re-baseline and left alone: the worst
    // residual here is 1.4810e-3, on squad 1, and squad 1 did not move. This
    // bar is NOT chained to the position bar below any more — the late
    // position bar widened for the wedge squad, and quietly dragging this one
    // along with it would relax an assertion nothing asked to relax.
    const TOL = 5e-3;
    for (let i = 0; i < oo.calls.length; i++) {
      const a = oo.calls[i], b = soa.calls[i];
      for (let k = 0; k < a.nums.length; k++) {
        const d = Math.abs(a.nums[k] - b.nums[k]);
        expect(`${a.tag}[${k}] ${d <= TOL ? 'within' : `OVER (${d})`}`).toBe(`${a.tag}[${k}] within`);
      }
    }
  });

  it('agrees on victim selection and alive counts every frame', () => {
    for (let f = 0; f < FRAMES; f++) {
      const a = oo.frames[f], b = soa.frames[f];
      expect(b.map((s) => s.id)).toEqual(a.map((s) => s.id));
      for (let i = 0; i < a.length; i++) {
        expect(`f${f} sq${a[i].id} alive=${b[i].aliveCount}`)
          .toBe(`f${f} sq${a[i].id} alive=${a[i].aliveCount}`);
        // Victim IDENTITY, not just the count: which local slots are dead.
        const deadOf = (s) => s.members.map((m, k) => (m.alive ? '' : k)).filter((k) => k !== '').join(',');
        expect(`f${f} sq${a[i].id} dead=${deadOf(b[i])}`)
          .toBe(`f${f} sq${a[i].id} dead=${deadOf(a[i])}`);
        expect(`f${f} sq${a[i].id} released=${b[i].members.map((m) => (m.released ? 1 : 0)).join('')}`)
          .toBe(`f${f} sq${a[i].id} released=${a[i].members.map((m) => (m.released ? 1 : 0)).join('')}`);
      }
    }
  });

  it('agrees on tier and transport state every frame', () => {
    for (let f = 0; f < FRAMES; f++) {
      const a = oo.frames[f], b = soa.frames[f];
      for (let i = 0; i < a.length; i++) {
        expect(`f${f} sq${a[i].id} ${b[i].lod}/${b[i].transportState}`)
          .toBe(`f${f} sq${a[i].id} ${a[i].lod}/${a[i].transportState}`);
      }
    }
  });

  it('places every member within the f32 residual every frame', () => {
    // Two bars, for the reason in header note 2: a genuine divergence shows up
    // in the first frames (the deadband neutralisation lands at 3e-3 on frame
    // 0), while the f32 storage residual only accumulates over a hundred
    // frames of closed-loop steering.
    //
    // EARLY_TOL is the sensitive one and is UNCHANGED by the slot re-baseline
    // (measured 5.8366e-4). TOL covers the wedge squad's amplified f32
    // residual, 1.3404e-2 at f54 — 3x it, the same margin rule the original
    // 5e-3 bar was set by. See the re-baseline block in the header for the
    // evidence that this is still storage precision and not divergence.
    const EARLY_TOL = 1e-3, EARLY_FRAMES = 30, TOL = 4e-2;
    let worst = 0, worstAt = '', worstEarly = 0, worstEarlyAt = '';
    for (let f = 0; f < FRAMES; f++) {
      const a = oo.frames[f], b = soa.frames[f];
      for (let i = 0; i < a.length; i++) {
        for (let k = 0; k < a[i].members.length; k++) {
          const m = a[i].members[k], n = b[i].members[k];
          if (!m.alive || m.released) continue;   // untracked storage, not a pose
          const d = Math.max(Math.abs(m.x - n.x), Math.abs(m.y - n.y), Math.abs(m.z - n.z));
          if (d > worst) { worst = d; worstAt = `f${f} sq${a[i].id} member ${k}`; }
          if (f < EARLY_FRAMES && d > worstEarly) { worstEarly = d; worstEarlyAt = `f${f} sq${a[i].id} member ${k}`; }
        }
      }
    }
    expect(`early ${worstEarlyAt} ${worstEarly <= EARLY_TOL ? 'within' : 'OVER'} ${EARLY_TOL}`)
      .toBe(`early ${worstEarlyAt} within ${EARLY_TOL}`);
    expect(`${worstAt} ${worst <= TOL ? 'within' : 'OVER'} ${TOL}`)
      .toBe(`${worstAt} within ${TOL}`);
  });

  it('agrees on member heading and gait (the animation channels) too', () => {
    // Heading gets the same early/late split as position, and for the same
    // reason. Before the slot re-baseline one flat 1e-3 bar covered the whole
    // run; the wedge squad's heading residual now reaches 2.6213e-3 late, so a
    // single bar would have had to be widened across the early window too and
    // would have thrown away the sensitivity there. Split instead: EARLY_TOL
    // is the pre-existing 1e-3 against a measured 2.9403e-4 (unchanged by this
    // change), TOL is 3x the measured 2.6213e-3.
    //
    // Gait keeps its flat 1e-3 — measured worst 6.4454e-4, still inside it.
    const EARLY_TOL = 1e-3, EARLY_FRAMES = 30, TOL = 8e-3, GAIT_TOL = 1e-3;
    for (let f = 0; f < FRAMES; f++) {
      const a = oo.frames[f], b = soa.frames[f];
      for (let i = 0; i < a.length; i++) {
        for (let k = 0; k < a[i].members.length; k++) {
          const m = a[i].members[k], n = b[i].members[k];
          if (!m.alive || m.released) continue;
          const dh = Math.abs(m.heading - n.heading);
          expect(`f${f} sq${a[i].id} m${k} heading ${dh <= TOL ? 'within' : `OVER (${dh})`}`)
            .toBe(`f${f} sq${a[i].id} m${k} heading within`);
          if (f < EARLY_FRAMES) {
            expect(`f${f} sq${a[i].id} m${k} early heading ${dh <= EARLY_TOL ? 'within' : `OVER (${dh})`}`)
              .toBe(`f${f} sq${a[i].id} m${k} early heading within`);
          }
          expect(Math.abs(m.gait - n.gait)).toBeLessThanOrEqual(GAIT_TOL);
        }
      }
    }
  });
});

describe('KNOWN DIVERGENCE — the neighbour cap truncates differently per engine', () => {
  // This case asserts a difference rather than an agreement, deliberately. It
  // is a tripwire: it is what stops the truncation problem being rediscovered
  // as "the SoA port drifted", and the day the design question in
  // PLAN-metalstorm-squad-performance.md §14 S6 is answered (nearest-K
  // selection being the obvious answer), this case must FAIL and be replaced
  // by an equality assertion. Do not relax it to a tolerance.
  //
  // Mechanism: `cfg.neighbourCap` is applied by the broad-phase in enumeration
  // order and BEFORE the `d < separationRadius` filter, so with more candidates
  // than the cap each engine keeps a different subset — and a dropped near
  // neighbour is a separation push that never happens. The OO Map grid and the
  // SoA CSR grid have no reason to enumerate alike.
  function tenInALine(engine) {
    const mgr = new SquadManager(new RecordingBackend(), {
      engine, random: seededRandom(1), governorEscalateFrames: 1e9,
      neighbourCap: 8,   // the SHIPPED value — the point of this case
    });
    mgr.syncSquad(1, { x: 2000, y: groundAt(2000, 2000), z: 2000, heading: 0, health: 100, maxHealth: 100 },
      groundDef());
    mgr.update(DT);      // builds the grid
    return mgr;
  }

  it('keeps a different neighbour SET for the same member at the shipped cap', () => {
    const a = tenInALine('oo'), b = tenInALine('soa');
    const sqa = a.squads.get(1), sqb = b.squads.get(1);

    // Member 6 of a 10-member line: 9 candidates, cap 8, so exactly one is
    // dropped — and the two engines drop a different one.
    const n = a._neighboursInto(sqa.members[6]);
    const ooSet = [];
    for (let k = 0; k < n; k++) ooSet.push(a._nbBuf[k].id);

    const cap = 8;
    const nSlot = new Int32Array(cap), nX = new Float32Array(cap), nZ = new Float32Array(cap), nR = new Float32Array(cap);
    const slot = sqb.base + 6;
    const found = queryInto(b._soaGrid, b.store, b.store.mx[slot], b.store.mz[slot], slot, cap,
      nSlot, nX, nZ, nR, 12345);
    const soaSet = [];
    for (let k = 0; k < found; k++) soaSet.push(nSlot[k] - sqb.base);

    expect(ooSet.length).toBe(cap);
    expect(found).toBe(cap);
    // OO keeps member 8 (within separationRadius, so it PUSHES); SoA keeps
    // member 9 (outside it, so it does not) — one engine's member 6 is being
    // separated and the other's is not.
    expect(ooSet.slice().sort((x, y) => x - y)).not.toEqual(soaSet.slice().sort((x, y) => x - y));
    expect(ooSet).toContain(8);
    expect(soaSet).not.toContain(8);
  });

  it('and that difference is macroscopic, not a rounding residual', () => {
    // Same 120-frame script, cap left at the shipped 8: the engines part by
    // more than an elmo — three orders of magnitude past the f32 residual the
    // uncapped run measures.
    const capped = (engine) => {
      const mgr = new SquadManager(new RecordingBackend(), {
        engine, random: seededRandom(20260814), governorEscalateFrames: 1e9, neighbourCap: 8,
      });
      mgr.syncSquad(1, { x: 2000, y: groundAt(2000, 2000), z: 2000, heading: 0, health: 100, maxHealth: 100 },
        groundDef());
      for (let f = 0; f < 60; f++) {
        const a = f * DT * 0.9;
        const x = 2000 + 160 * Math.sin(a), z = 2000 + 140 * (1 - Math.cos(a));
        mgr.syncPose(1, { x, y: groundAt(x, z), z, heading: a });
        mgr.update(DT);
      }
      return readMembers(mgr, mgr.squads.get(1));
    };
    const a = capped('oo'), b = capped('soa');
    let worst = 0;
    for (let k = 0; k < a.length; k++) {
      if (!a[k].alive || a[k].released) continue;
      worst = Math.max(worst, Math.abs(a[k].x - b[k].x), Math.abs(a[k].z - b[k].z));
    }
    expect(`capped divergence ${worst > 1e-2 ? 'macroscopic' : `only ${worst}`}`).toBe('capped divergence macroscopic');
  });
});

describe('§10f — the seeded RNG seam both engines draw from', () => {
  it('is threaded into the stagger draw on BOTH engines (not Math.random)', () => {
    // Direct, engine-agnostic check: with a cfg.random that counts its calls,
    // an attrition kill batch must draw from it. This is the prerequisite the
    // whole parity suite rests on, and it has been silently lost to a landing
    // merge twice (see config.js `random`), so assert it rather than trusting
    // that a parity pass implies it.
    for (const engine of ['oo', 'soa']) {
      let draws = 0;
      const mgr = new SquadManager(new RecordingBackend(), {
        engine,
        random: () => { draws++; return 0.5; },
        governorEscalateFrames: 1e9,
      });
      mgr.syncSquad(7, { x: 500, y: 0, z: 500, heading: 0, health: 100, maxHealth: 100 }, groundDef());
      mgr.update(DT);
      mgr.syncStrength(7, 40, 100);   // un-hinted → staggered deaths → one draw
      expect(`${engine}: ${draws > 0}`).toBe(`${engine}: true`);
    }
  });
});
