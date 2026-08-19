// soa-bench.mjs — the S4 acceptance rung: marginal per-squad step cost, OO vs
// SoA. PLAN-metalstorm-squad-performance.md §14 S4 ("synthetic 5k-forced-full
// ladder rung shows per-squad marginal cost <= 1/3 of §0c's ~15 us").
//
// MEASUREMENT ONLY — not a test, never in the gate. Perf assertions in a unit
// suite go red on a loaded machine and get muted, which is worse than no
// assertion at all.
//
// Marginal, not total: cost is measured at N and at 2N squads and differenced,
// so the fixed per-frame overhead (grid rebuild bounds, schedule build, wreck
// tick) cancels and what is left is what one more squad costs. Arms are
// interleaved round by round and the MEDIAN is reported, because this machine
// is shared — a mean would be dominated by whichever arm caught a stall.
//
//   node soa-bench.mjs [membersPerSquad] [rounds]

import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';

const SQUAD_SIZE = Number(process.argv[2] ?? 25);
const ROUNDS = Number(process.argv[3] ?? 7);
const FRAMES = 60;
const DT = 1 / 60;

class Backend extends NullRenderBackend {
  createMember() { return 1; }
  groundHeight() { return 0; }
}

function makeDef() {
  return {
    defId: 'bench', squadSize: SQUAD_SIZE, formationType: 'blob',
    formationRadius: 24, maxSpeed: 30, customParams: {},
  };
}

/** Total ms for FRAMES frames with `squads` squads, all forced to `full`. */
function run(engine, squads) {
  const mgr = new SquadManager(new Backend(), { engine });
  const def = makeDef();
  const cols = Math.ceil(Math.sqrt(squads));
  for (let i = 0; i < squads; i++) {
    const x = (i % cols) * 120, z = Math.floor(i / cols) * 120;
    mgr.syncSquad(i + 1, { x, y: 0, z, heading: 0, health: 100, maxHealth: 100 }, def);
  }
  // Warm the JIT on this exact shape before timing.
  for (let f = 0; f < 20; f++) mgr.update(DT);
  const t0 = performance.now();
  for (let f = 1; f <= FRAMES; f++) {
    for (let i = 0; i < squads; i++) {
      const x = (i % cols) * 120 + f * 2, z = Math.floor(i / cols) * 120;
      mgr.syncPose(i + 1, { x, y: 0, z, heading: 0 });
    }
    mgr.update(DT);
  }
  return performance.now() - t0;
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

const N = 100;   // 100 x 25 = 2 500 members; 2N = 5 000, the §0c rung
const samples = { oo: [], soa: [] };
for (let r = 0; r < ROUNDS; r++) {
  for (const engine of ['oo', 'soa']) {
    const lo = run(engine, N);
    const hi = run(engine, 2 * N);
    // us per squad per frame, marginal
    samples[engine].push(((hi - lo) / FRAMES / N) * 1000);
  }
}

const oo = median(samples.oo), soa = median(samples.soa);
console.log(`members/squad ${SQUAD_SIZE}  rounds ${ROUNDS}  frames/arm ${FRAMES}`);
console.log(`marginal us/squad/frame   OO ${oo.toFixed(2)}   SoA ${soa.toFixed(2)}   ratio ${(soa / oo).toFixed(2)}`);
console.log(`OO  samples: ${samples.oo.map((v) => v.toFixed(2)).join(' ')}`);
console.log(`SoA samples: ${samples.soa.map((v) => v.toFixed(2)).join(' ')}`);
console.log(`S4 gate (<= 1/3 of this run's OO arm): ${soa <= oo / 3 ? 'PASS' : 'MISS'}`);
