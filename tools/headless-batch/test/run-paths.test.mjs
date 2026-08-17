import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { armPaths, staleArtifacts } from '../lib/run-paths.mjs';

test('an arm names its four artifacts under the out-dir, indexed by arm', () => {
    const p = armPaths('/tmp/soak', 3);
    assert.equal(p.configPath, path.join('/tmp/soak', 'configs', 'run-3.json'));
    assert.equal(p.dumpPath, path.join('/tmp/soak', 'dumps', 'run-3.json'));
    assert.equal(p.dbPath, path.join('/tmp/soak', 'db', 'run-3.sqlite'));
    assert.equal(p.logPath, path.join('/tmp/soak', 'logs', 'run-3.log'));
});

// PLAN-long-uptime §12, the fifth ladder defect: a re-run into an existing
// out-dir inherited the previous run's SQLite file, and db_bytes is fitted on
// that file's size. The sidecars are listed explicitly because SQLite only
// recreates them when the main file is gone too.
test('a re-run clears the database, BOTH its sidecars, and the dump', () => {
    const stale = staleArtifacts('/tmp/soak', 0);
    assert.deepEqual(stale, [
        path.join('/tmp/soak', 'db', 'run-0.sqlite'),
        path.join('/tmp/soak', 'db', 'run-0.sqlite-wal'),
        path.join('/tmp/soak', 'db', 'run-0.sqlite-shm'),
        path.join('/tmp/soak', 'dumps', 'run-0.json'),
    ]);
});

// The config and the log are rewritten by the arm before/after it runs, so
// clearing them would be noise; the point of the list is what is READ back.
test('the clear list is exactly the artifacts an arm reads back or grows', () => {
    const { configPath, logPath } = armPaths('/tmp/soak', 1);
    const stale = staleArtifacts('/tmp/soak', 1);
    assert.ok(!stale.includes(configPath));
    assert.ok(!stale.includes(logPath));
});
