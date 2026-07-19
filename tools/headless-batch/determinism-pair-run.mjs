#!/usr/bin/env node
// Determinism pair-run — PLAN-headless.md task 4 (the CI hook).
//
// Runs the same --headless-run config twice, back to back, and diffs the two
// resulting stats dumps' `stateHash` sequences frame-for-frame. Two runs of
// identical config+seed must tick through an identical unit list in an
// identical order with an identical RNG stream (StatsDump.h's determinism
// claim) — any divergence is a real synced-state regression, not test flake.
//
// The two runs are sequential (not parallel) so they can safely reuse the
// same --port/--db without collision — this is a correctness check, not a
// throughput benchmark, and PLAN-headless task 2 already measured an
// uncapped multi-hour run completing in single-digit wall-seconds, so
// running it twice in CI costs nothing meaningful.
//
// Usage:
//   node determinism-pair-run.mjs --server-bin <path-to-spring-server> \
//     [--config fixtures/papertanks-determinism.json] [--out-dir <dir>] \
//     [--max-wall-min N] [--port N] [--repo-root <dir>]
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { loadJson, writeJson } from './lib/config.mjs';
import { runHeadless } from './lib/run-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_CONFIG = path.join(HERE, 'fixtures', 'papertanks-determinism.json');

async function runOnce({ serverBin, config, index, outDir, port, maxWallMin, repoRoot }) {
    const configPath = path.join(outDir, `config-${index}.json`);
    const dumpPath = path.join(outDir, `dump-${index}.json`);
    const dbPath = path.join(outDir, `db-${index}.sqlite`);

    const cfg = structuredClone(config);
    cfg.headless = cfg.headless ?? {};
    cfg.headless.statsDump = dumpPath;
    await writeJson(configPath, cfg);

    const result = await runHeadless({ serverBin, configPath, port, dbPath, maxWallMin, cwd: repoRoot });
    if (result.exitCode !== 0) {
        throw new Error(`run ${index} exited with code ${result.exitCode}:\n${result.stderr.split('\n').slice(-30).join('\n')}`);
    }
    return JSON.parse(await readFile(dumpPath, 'utf8'));
}

function diffDumps(a, b) {
    const problems = [];
    if (a.status !== b.status) problems.push(`status: ${a.status} != ${b.status}`);
    if (a.frame !== b.frame) problems.push(`frame: ${a.frame} != ${b.frame}`);
    if (a.snapshots.length !== b.snapshots.length) {
        problems.push(`snapshot count: ${a.snapshots.length} != ${b.snapshots.length}`);
    }
    const n = Math.min(a.snapshots.length, b.snapshots.length);
    for (let i = 0; i < n; i++) {
        const sa = a.snapshots[i], sb = b.snapshots[i];
        if (sa.frame !== sb.frame) {
            problems.push(`snapshot[${i}] frame: ${sa.frame} != ${sb.frame}`);
        }
        if (sa.stateHash !== sb.stateHash) {
            problems.push(`snapshot[${i}] (frame ${sa.frame}) stateHash: ${sa.stateHash} != ${sb.stateHash}`);
        }
    }
    return problems;
}

async function main() {
    const { values } = parseArgs({
        options: {
            'server-bin': { type: 'string' },
            config: { type: 'string', default: DEFAULT_CONFIG },
            'out-dir': { type: 'string', default: path.join(DEFAULT_REPO_ROOT, 'build', 'headless-determinism') },
            'max-wall-min': { type: 'string', default: '5' },
            port: { type: 'string', default: '19199' },
            'repo-root': { type: 'string', default: DEFAULT_REPO_ROOT },
        },
    });

    if (!values['server-bin']) {
        console.error('--server-bin is required');
        process.exit(2);
    }

    const serverBin = path.resolve(values['server-bin']);
    const outDir = path.resolve(values['out-dir']);
    const port = parseInt(values.port, 10);
    const maxWallMin = parseInt(values['max-wall-min'], 10);
    const repoRoot = path.resolve(values['repo-root']);
    const config = await loadJson(path.resolve(values.config));

    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    console.log(`determinism pair-run: ${values.config} via ${serverBin}`);
    const dumpA = await runOnce({ serverBin, config, index: 0, outDir, port, maxWallMin, repoRoot });
    console.log(`  run 0: status=${dumpA.status} frame=${dumpA.frame} snapshots=${dumpA.snapshots.length}`);
    const dumpB = await runOnce({ serverBin, config, index: 1, outDir, port, maxWallMin, repoRoot });
    console.log(`  run 1: status=${dumpB.status} frame=${dumpB.frame} snapshots=${dumpB.snapshots.length}`);

    const problems = diffDumps(dumpA, dumpB);
    if (problems.length > 0) {
        console.error(`DETERMINISM FAIL (${problems.length} mismatch(es)):`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
    }

    console.log(`OK: ${dumpA.snapshots.length} snapshots, stateHash sequences match byte-for-byte.`);
}

main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
});
