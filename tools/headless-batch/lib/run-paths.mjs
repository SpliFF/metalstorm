// Per-arm artifact paths for the batch driver, and the list of them a re-run
// must clear before an arm starts. Pure (path arithmetic only) so
// `test/run-paths.test.mjs` can assert the clearing rule without spawning a
// server — the same pure-core/wiring split lib/matrix.mjs uses.
//
// Why the clearing rule exists (PLAN-long-uptime §12, the fifth ladder defect):
// batch.mjs creates its output directories with `recursive: true` and never
// removes what is already in them, so a second run into the same --out-dir
// hands each arm the PREVIOUS run's SQLite file. `db_bytes` — the S8 growth
// surface — is sampled as the size of main + -wal + -shm, so a stale main file
// starts the series mid-sawtooth and a stale -wal fits the tail of somebody
// else's checkpoint ramp. A stale dump is worse than wrong: batch.mjs reads the
// dump back after the arm exits, so an arm that dies before writing one would
// be recorded with the previous run's counters and reported as a result.

import path from 'node:path';

export function armPaths(outDir, index) {
    return {
        configPath: path.join(outDir, 'configs', `run-${index}.json`),
        dumpPath: path.join(outDir, 'dumps', `run-${index}.json`),
        dbPath: path.join(outDir, 'db', `run-${index}.sqlite`),
        logPath: path.join(outDir, 'logs', `run-${index}.log`),
    };
}

// Everything an arm must not inherit from a previous run into the same
// out-dir. The config and the log are rewritten unconditionally by the arm
// itself, so they are not listed; the db sidecars are, because SQLite only
// recreates them when the main file is also gone.
export function staleArtifacts(outDir, index) {
    const { dumpPath, dbPath } = armPaths(outDir, index);
    return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, dumpPath];
}
