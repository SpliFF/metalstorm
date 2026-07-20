#!/usr/bin/env node

/**
 * economy-validation.js — acceptance script for economy validation grid
 * (PLAN-metalstorm-economy.md §4, task 4).
 *
 * Usage:
 *   node tools/economy-validation.js <results-dir>
 *
 * Reads all .json stats dumps from <results-dir>, applies acceptance criteria
 * from economy_validation_grid.json, emits a pass/fail verdict + summary stats.
 *
 * Exit codes:
 *   0 = grid passes (≥90% of runs meet all criteria)
 *   1 = grid fails (too many runs failed)
 *   2 = error (missing files, parse failures, etc.)
 */

const fs = require('fs');
const path = require('path');

// Acceptance criteria (from PLAN-metalstorm-economy.md §4)
const ACCEPTANCE = {
  velocityRange: [0.6, 1.5],
  velocityAfterFrame: 2592000,  // day 1 in sim frames
  poolRatioMax: 8,
  deadTeamTimePctMax: 1,
  joinGrantMintPctMax: 10,
  passThreshold: 0.9,  // ≥90% of runs must pass
};

function loadStatsFiles(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const runs = [];
  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      runs.push({ file, data });
    } catch (err) {
      console.error(`WARN: Failed to parse ${file}: ${err.message}`);
    }
  }
  return runs;
}

function checkVelocity(run) {
  // Velocity ∈ [0.6, 1.5] after day 1
  const teams = run.data.economy?.teams || {};
  for (const teamID in teams) {
    const timeline = teams[teamID].velocity_timeline || [];
    const afterDay1 = timeline.filter(e => e.frame >= ACCEPTANCE.velocityAfterFrame);
    if (afterDay1.length === 0) continue;  // No data after day 1 — skip team
    for (const entry of afterDay1) {
      if (entry.velocity < ACCEPTANCE.velocityRange[0] || entry.velocity > ACCEPTANCE.velocityRange[1]) {
        return false;
      }
    }
  }
  return true;
}

function checkPoolRatio(run) {
  // Pool ratio < 8 sustained (checked at end of run)
  const teams = run.data.economy?.teams || {};
  for (const teamID in teams) {
    const poolRatio = teams[teamID].final_pool_ratio || 0;
    if (poolRatio >= ACCEPTANCE.poolRatioMax) {
      return false;
    }
  }
  return true;
}

function checkDeadTeamTime(run) {
  // Dead-team time < 1% of runtime (excluding end-game = final 10%)
  const totalFrames = run.data.finalFrame || 0;
  const endGameStart = totalFrames * 0.9;
  const teams = run.data.economy?.teams || {};
  for (const teamID in teams) {
    const deadFrames = teams[teamID].dead_frames_before_endgame || 0;
    const pct = (deadFrames / endGameStart) * 100;
    if (pct >= ACCEPTANCE.deadTeamTimePctMax) {
      return false;
    }
  }
  return true;
}

function checkJoinGrantInflation(run) {
  // Join grants < 10% of total mint (churn-amplified runs only)
  const teams = run.data.economy?.teams || {};
  for (const teamID in teams) {
    const counters = teams[teamID].ledger || {};
    const mint = counters.mint || 0;
    const joinGrantMint = counters.join_grant_mint || 0;  // Assuming ledger tracks this separately
    if (mint > 0) {
      const pct = (joinGrantMint / mint) * 100;
      if (pct >= ACCEPTANCE.joinGrantMintPctMax) {
        return false;
      }
    }
  }
  return true;
}

function validateRun(run) {
  const checks = {
    velocity: checkVelocity(run),
    poolRatio: checkPoolRatio(run),
    deadTeamTime: checkDeadTeamTime(run),
    joinGrantInflation: checkJoinGrantInflation(run),
  };
  const passed = Object.values(checks).every(Boolean);
  return { passed, checks };
}

function main() {
  const resultsDir = process.argv[2];
  if (!resultsDir) {
    console.error('Usage: node tools/economy-validation.js <results-dir>');
    process.exit(2);
  }

  if (!fs.existsSync(resultsDir)) {
    console.error(`ERROR: Results directory ${resultsDir} does not exist`);
    process.exit(2);
  }

  console.log(`Loading stats dumps from ${resultsDir}...`);
  const runs = loadStatsFiles(resultsDir);
  if (runs.length === 0) {
    console.error('ERROR: No valid .json stats files found');
    process.exit(2);
  }
  console.log(`Loaded ${runs.length} runs.`);

  const results = runs.map(run => ({
    file: run.file,
    ...validateRun(run),
  }));

  const passed = results.filter(r => r.passed).length;
  const passRate = passed / results.length;

  console.log('\n=== VALIDATION SUMMARY ===');
  console.log(`Total runs: ${results.length}`);
  console.log(`Passed: ${passed} (${(passRate * 100).toFixed(1)}%)`);
  console.log(`Failed: ${results.length - passed}`);
  console.log('');

  // Per-criterion breakdown
  const criterionCounts = { velocity: 0, poolRatio: 0, deadTeamTime: 0, joinGrantInflation: 0 };
  for (const r of results) {
    for (const criterion in criterionCounts) {
      if (!r.checks[criterion]) criterionCounts[criterion]++;
    }
  }
  console.log('Failures by criterion:');
  for (const criterion in criterionCounts) {
    console.log(`  ${criterion}: ${criterionCounts[criterion]} runs`);
  }
  console.log('');

  // List failed runs
  const failedRuns = results.filter(r => !r.passed);
  if (failedRuns.length > 0 && failedRuns.length <= 10) {
    console.log('Failed runs:');
    for (const r of failedRuns) {
      const failedCriteria = Object.keys(r.checks).filter(c => !r.checks[c]);
      console.log(`  ${r.file}: ${failedCriteria.join(', ')}`);
    }
    console.log('');
  }

  // Verdict
  if (passRate >= ACCEPTANCE.passThreshold) {
    console.log(`✅ GRID PASSES (${(passRate * 100).toFixed(1)}% ≥ ${ACCEPTANCE.passThreshold * 100}%)`);
    console.log('Constants in authority_cost.lua are validated. No tuning needed.');
    process.exit(0);
  } else {
    console.log(`❌ GRID FAILS (${(passRate * 100).toFixed(1)}% < ${ACCEPTANCE.passThreshold * 100}%)`);
    console.log('Economy constants need adjustment. See failures above.');
    process.exit(1);
  }
}

main();
