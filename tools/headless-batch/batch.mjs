#!/usr/bin/env node
// Batch driver CLI — PLAN-headless.md task 3.
//
// Takes a headless-run config template + a parameter matrix (profiles x maps
// x seeds, or any other axes), spawns one `spring-server --headless-run`
// process per combination (they're small — PLAN-headless §2), and collates
// every run's stats dump into one JSONL file (one line per run) for
// downstream analysis (balance sweeps, economy tuning grids, AI profile
// round-robins, long-uptime soak ladders).
//
// `seed` is carried through as an ordinary matrix axis and written into each
// generated config, but the engine does not yet consume it: gsRNG is
// hard-seeded to a fixed constant at CGlobalSynced::ResetState()
// (rts/Sim/Misc/GlobalSynced.cpp) and there is no `--seed` / config `seed`
// field wired to it. Per AGENTS.md's no-silent-deviation rule this is called
// out explicitly rather than pretended away: today, varying `seed` across a
// matrix produces distinct labelled rows (useful for the batch driver's own
// bookkeeping and for `expandMatrix`'s reproducibility guarantee, §6 "meta"
// test) but not yet a different RNG stream. Wiring `Config.seed` through to
// `gsRNG.SetSeed()` is future engine work, not part of this task.
//
// Usage:
//   node batch.mjs --template <template.json> --matrix <matrix.json> \
//     --out-dir <dir> --server-bin <path-to-spring-server> \
//     [--jsonl <path>] [--concurrency N] [--max-wall-min N] [--base-port N] [--repo-root <dir>]
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { expandMatrix } from './lib/matrix.mjs';
import { loadJson, writeJson } from './lib/config.mjs';
import { runHeadless } from './lib/run-server.mjs';
import { armPaths, staleArtifacts } from './lib/run-paths.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main() {
    const { values } = parseArgs({
        options: {
            template: { type: 'string' },
            matrix: { type: 'string' },
            'out-dir': { type: 'string' },
            'server-bin': { type: 'string' },
            jsonl: { type: 'string' },
            concurrency: { type: 'string', default: '4' },
            'max-wall-min': { type: 'string', default: '5' },
            'base-port': { type: 'string', default: '19100' },
            'repo-root': { type: 'string', default: DEFAULT_REPO_ROOT },
        },
    });

    for (const req of ['template', 'matrix', 'out-dir', 'server-bin']) {
        if (!values[req]) {
            console.error(`--${req} is required`);
            process.exit(2);
        }
    }

    const outDir = path.resolve(values['out-dir']);
    const serverBin = path.resolve(values['server-bin']);
    const jsonlPath = values.jsonl ? path.resolve(values.jsonl) : path.join(outDir, 'results.jsonl');
    const concurrency = Math.max(1, parseInt(values.concurrency, 10));
    const maxWallMin = parseInt(values['max-wall-min'], 10);
    const basePort = parseInt(values['base-port'], 10);
    const repoRoot = path.resolve(values['repo-root']);

    const template = await loadJson(path.resolve(values.template));
    const matrixSpec = await loadJson(path.resolve(values.matrix));
    const rows = expandMatrix(matrixSpec, template);

    await mkdir(outDir, { recursive: true });
    await rm(jsonlPath, { force: true });

    console.log(`headless-batch: ${rows.length} run(s), concurrency=${concurrency}`);

    let nextIndex = 0;
    let failures = 0;

    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= rows.length) return;
            const row = rows[i];

            const { configPath, dumpPath, dbPath, logPath } = armPaths(outDir, i);
            const port = basePort + i;

            // A re-run into an existing --out-dir must not inherit the previous
            // run's database or dump — see lib/run-paths.mjs for why (db_bytes
            // is fitted on these files' size, and a stale dump would be read
            // back as this arm's result).
            for (const stale of staleArtifacts(outDir, i)) await rm(stale, { force: true });

            const config = structuredClone(row.config);
            config.headless = config.headless ?? {};
            config.headless.statsDump = dumpPath;
            await writeJson(configPath, config);
            // StatsDump::WriteDumpFile does not create parent dirs (it's the
            // caller's job per StatsDump.h) — same for the sqlite path.
            await mkdir(path.dirname(dumpPath), { recursive: true });
            await mkdir(path.dirname(dbPath), { recursive: true });

            const result = await runHeadless({ serverBin, configPath, port, dbPath, maxWallMin, cwd: repoRoot });
            const ok = result.exitCode === 0;
            if (!ok) failures++;

            // Persist every arm's server output, passing runs included. A dump
            // records counters, not warnings, and the warnings are where an
            // arm says it staged nothing: three of the four fixture defects in
            // PLAN-long-uptime §11.1 (no scenario, AI slots on an empty team,
            // a war that ends) announce themselves in the log and in no
            // counter. Keeping only a failed run's stderr tail meant the whole
            // ladder was green and silent while measuring an empty world.
            await mkdir(path.dirname(logPath), { recursive: true });
            await writeFile(logPath, `${result.stdout}\n--- stderr ---\n${result.stderr}`);

            let dump = null;
            try {
                dump = JSON.parse(await readFile(dumpPath, 'utf8'));
            } catch {
                // No dump written (run failed before termination, or bad path) —
                // recorded as `dump: null` below, never faked with zeros.
            }

            const line = {
                index: i,
                params: row.params,
                port,
                configPath,
                dumpPath,
                exitCode: result.exitCode,
                ok,
                dump,
                stderrTail: ok ? undefined : result.stderr.split('\n').slice(-20).join('\n'),
            };
            await appendFile(jsonlPath, JSON.stringify(line) + '\n');
            console.log(`  [${i + 1}/${rows.length}] ${ok ? 'OK' : 'FAIL'} ${JSON.stringify(row.params)}`);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

    console.log(`headless-batch: done, ${rows.length - failures}/${rows.length} ok -> ${jsonlPath}`);
    if (failures > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
