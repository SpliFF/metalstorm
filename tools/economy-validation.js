#!/usr/bin/env node

/**
 * economy-validation.js — the economy validation gate
 * (PLAN-metalstorm-economy.md §4, PLAN-economy-grid.md task 3).
 *
 * Usage:
 *   node tools/economy-validation.js [--seed N ...] [--json] [--lua PATH]
 *
 * This is a THIN RUNNER. It spawns `lua` on
 * `data/games/metalstorm/LuaRules/Gadgets/authority/economy_sim.lua`, prints
 * the grid it emits, and exits non-zero if any cell is outside its acceptance
 * band. All the arithmetic — the cost formula, the escrow ledger, the rate
 * EMAs, the generator's caps and rewards — happens in Lua against the real
 * game modules. Nothing is reimplemented here, deliberately.
 *
 * ── Why it no longer drives headless runs ──────────────────────────────────
 *
 * It used to read `.json` stats dumps from a matrix of headless server runs.
 * PLAN-economy-grid.md's autopsy (B1–B7) found every layer of that broken, and
 * two findings killed the approach rather than the implementation:
 *
 *   * B6 — every criterion read `run.data.economy.teams`, a key the engine has
 *     never written. `StatsDump` is a fixed 15-field C++ struct with no Lua
 *     hook, and the economy metrics live in a Lua-local. Each check iterated an
 *     empty object and returned true, so the grid went green on ANY dump.
 *   * B7d — `gsRNG.SetSeed(18655, true)` is hard-coded, so the four-seed axis
 *     produced four byte-identical runs and "≥90% of runs pass" was n=1.
 *
 * Both are consequences of measuring the economy from outside the sim. The
 * economy needs no map, no units and no pathfinder to exercise, so the harness
 * now runs it directly and the seed axis is a real one.
 *
 * What this does NOT cover: whether units can reach the objectives, whether the
 * AI spends the way the player model assumes, whether a map produces the
 * contest the control rule keys on. Those need a live match and always will.
 *
 * Exit codes:
 *   0 = every cell inside every band
 *   1 = at least one cell outside a band
 *   2 = the harness could not be run (no lua, load error, bad output)
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const GADGETS_DIR = path.join(
  __dirname, '..', 'data', 'games', 'metalstorm', 'LuaRules', 'Gadgets');
const SIM = path.join('authority', 'economy_sim.lua');

function parseArgs(argv) {
  const opts = { seeds: [], json: false, lua: 'lua' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') opts.seeds.push(Number(argv[++i]));
    else if (a === '--json') opts.json = true;
    else if (a === '--lua') opts.lua = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (opts.seeds.length === 0) opts.seeds = [1, 2, 3, 4];
  return opts;
}

/** Run the Lua harness for one seed; returns its TSV on stdout. */
function runSeed(opts, seed) {
  const res = spawnSync(opts.lua, [SIM, String(seed)], {
    cwd: GADGETS_DIR,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      console.error(`ERROR: '${opts.lua}' not found on PATH. Install Lua, or pass --lua <path>.`);
    } else {
      console.error(`ERROR: could not run ${opts.lua}: ${res.error.message}`);
    }
    process.exit(2);
  }
  if (res.status !== 0) {
    console.error(`ERROR: economy_sim.lua exited ${res.status}`);
    if (res.stderr) console.error(res.stderr.trim());
    process.exit(2);
  }
  return res.stdout;
}

/** TSV (header row + data rows) -> array of objects. */
function parseTSV(tsv) {
  const lines = tsv.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    console.error('ERROR: economy_sim.lua produced no rows');
    console.error(tsv);
    process.exit(2);
  }
  const header = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((key, i) => {
      const raw = cells[i] === undefined ? '' : cells[i];
      const num = Number(raw);
      row[key] = (raw !== '' && !Number.isNaN(num)) ? num : raw;
    });
    return row;
  });
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function num(v, dp) {
  return typeof v === 'number' ? v.toFixed(dp) : String(v);
}

function printTable(rows) {
  console.log([
    pad('type', 9), pad('dens', 7), pad('seed', 5), pad('veloc', 7),
    pad('mint/m', 9), pad('burn/m', 9), pad('pool×', 8), pad('escrow', 7),
    pad('broke', 7), pad('dead', 7), pad('objs', 6), pad('done', 6), 'verdict',
  ].join(' '));
  console.log('-'.repeat(110));
  for (const r of rows) {
    console.log([
      pad(r.type, 9), pad(r.density, 7), pad(r.seed, 5), pad(num(r.velocity, 3), 7),
      pad(num(r.mintRate, 1), 9), pad(num(r.burnRate, 1), 9),
      pad(num(r.poolRatio, 2), 8), pad(r.escrowFloat, 7),
      pad(num(r.timeToBrokeMinutes, 1), 7), pad(num(r.deadMinutes, 1), 7),
      pad(r.created, 6), pad(r.completed, 6),
      r.verdict === 'PASS' || r.verdict === 'INFO'
        ? r.verdict : `FAIL  ${r.failures}`,
    ].join(' '));
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(path.join(GADGETS_DIR, SIM))) {
    console.error(`ERROR: ${path.join(GADGETS_DIR, SIM)} not found`);
    process.exit(2);
  }

  const rows = [];
  for (const seed of opts.seeds) rows.push(...parseTSV(runSeed(opts, seed)));

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
  }

  // INFO rows (the `mixednorm` reward-normalisation probe) are measured and
  // printed, never graded — see economy_sim.lua's M.INFO_TYPES.
  const failed = rows.filter(r => r.verdict !== 'PASS' && r.verdict !== 'INFO');

  console.log('');
  const info = rows.filter(r => r.verdict === 'INFO');
  console.log(`Cells: ${rows.length}  passed: ${rows.length - failed.length - info.length}`
    + `  failed: ${failed.length}  informational: ${info.length}`);
  if (info.length > 0) {
    console.log('\n`mixednorm` is the reward-normalisation probe (economy §3.2 lever 2):');
    console.log('the `mixed` war with the lever ON. Measured, never graded — the shipped');
    console.log('spec has `reward_normalisation_enabled = false`. Compare it to `mixed`.');
  }

  if (failed.length === 0) {
    console.log('✅ Every cell is inside its acceptance band.');
    process.exit(0);
  }

  // Which band, and how often. A single out-of-band constant usually shows up
  // as one band failing across many cells, which is the useful shape to see.
  const byBand = new Map();
  for (const r of failed) {
    for (const f of String(r.failures).split('; ')) {
      if (!f) continue;
      const band = f.split(' ')[0];
      byBand.set(band, (byBand.get(band) || 0) + 1);
    }
  }
  console.log('\nFailures by band:');
  for (const [band, count] of [...byBand].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(band, 14)} ${count} cell(s)`);
  }
  console.log('\n❌ The economy is outside its bands. Read the `mixed` rows first:');
  console.log('   they are the only cells where all six generator rules run at once,');
  console.log('   which is what a real war looks like. A per-type row failing alone');
  console.log('   says that rule cannot fund a team by itself — which it is not');
  console.log('   meant to.');
  process.exit(1);
}

main();
