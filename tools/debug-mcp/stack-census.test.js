import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parsePsOutput, parseLsofF, resolveMprocsAddr, classifyBinaries,
    classifyStack, planCleanup, summarize, isStackPort, STACK_PATTERNS,
} from './stack-census.js';

// --- parsers ----------------------------------------------------------------

test('parsePsOutput keeps a command line containing spaces intact', () => {
    const rows = parsePsOutput(
        ' 4242  1 Fri Aug 15 11:02:33 2026 build/debug/spring-server --game metalstorm --map meridian basin\n'
        + ' 99 1 Fri Aug 15 09:00:01 2026 build/release/spring-lobby --db data/spring-server.db\n',
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].pid, 4242);
    assert.equal(rows[0].ppid, 1);
    assert.equal(rows[0].lstart, 'Fri Aug 15 11:02:33 2026');
    assert.equal(rows[0].cmd, 'build/debug/spring-server --game metalstorm --map meridian basin');
    assert.equal(rows[1].cmd, 'build/release/spring-lobby --db data/spring-server.db');
});

test('parsePsOutput skips blank and short lines', () => {
    assert.deepEqual(parsePsOutput('\n  \nnot a ps row\n'), []);
});

test('parseLsofF attributes every n record to the preceding p/c pair', () => {
    const rows = parseLsofF('p101\ncspring-lobby\nn127.0.0.1:8011\nn*:8443\np202\ncnode\nn[::1]:8012\n');
    assert.deepEqual(rows, [
        { pid: 101, cmd: 'spring-lobby', addr: '127.0.0.1:8011', port: 8011 },
        { pid: 101, cmd: 'spring-lobby', addr: '*:8443', port: 8443 },
        { pid: 202, cmd: 'node', addr: '[::1]:8012', port: 8012 },
    ]);
});

test('parseLsofF ignores records with no port and output with no process', () => {
    assert.deepEqual(parseLsofF('n127.0.0.1:8011\n'), []);
    assert.deepEqual(parseLsofF('p1\ncx\nn/tmp/sock\n'), []);
});

test('resolveMprocsAddr: env beats yaml beats default', () => {
    assert.equal(resolveMprocsAddr({ env: '127.0.0.1:4999', yamlText: 'server: 127.0.0.1:4050' }), '127.0.0.1:4999');
    assert.equal(resolveMprocsAddr({ yamlText: 'procs:\nserver: 127.0.0.1:4051\n' }), '127.0.0.1:4051');
    assert.equal(resolveMprocsAddr({}), '127.0.0.1:4050');
});

test('isStackPort covers the three fixed ports and the game range only', () => {
    for (const p of [8010, 8011, 8012, 9100, 9700, 10099]) assert.ok(isStackPort(p), `${p}`);
    for (const p of [80, 8013, 9099, 10100]) assert.ok(!isStackPort(p), `${p}`);
});

test('the pgrep patterns still spell out both build dirs (no `.` wildcard)', () => {
    for (const pat of Object.values(STACK_PATTERNS)) assert.ok(!/build\/\.\*/.test(pat), pat);
    assert.equal(STACK_PATTERNS.server, 'build/(debug|release)/spring-server');
});

// --- binaries ---------------------------------------------------------------

test('classifyBinaries picks release when it exists, and flags a newer debug', () => {
    const b = classifyBinaries({
        release: { mtimeMs: 1000, size: 1 },
        debug: { mtimeMs: 2000, size: 1 },
    });
    assert.equal(b.picked, 'build/release/spring-server');
    assert.equal(b.drift, true);
});

test('classifyBinaries: debug-only build is picked and never drifts', () => {
    const b = classifyBinaries({ debug: { mtimeMs: 2000, size: 1 } });
    assert.equal(b.picked, 'build/debug/spring-server');
    assert.equal(b.drift, false);
});

test('classifyBinaries: a newer release over an older debug is not drift', () => {
    const b = classifyBinaries({ release: { mtimeMs: 3000, size: 1 }, debug: { mtimeMs: 1000, size: 1 } });
    assert.equal(b.drift, false);
});

// --- classification ---------------------------------------------------------

const baseCensus = (over = {}) => ({
    processes: { lobby: [], server: [], logserver: [], vite: [] },
    ports: { available: true, listeners: [] },
    authority: { source: 'lobby', rows: [] },
    gameStatus: { available: true, rows: [] },
    binaries: classifyBinaries({}),
    identities: [],
    ...over,
});

const kinds = fs => fs.map(f => f.kind);

test('a server pid in the lobby list is managed, one outside it is a stray', () => {
    const f = classifyStack(baseCensus({
        processes: {
            lobby: [], logserver: [], vite: [],
            server: [
                { pid: 10, cmd: 'build/release/spring-server --room 7' },
                { pid: 11, cmd: 'build/debug/spring-server --headless-run' },
            ],
        },
        ports: { available: true, listeners: [{ pid: 10, cmd: 'spring-serv', port: 9100 }, { pid: 11, cmd: 'spring-serv', port: 9101 }] },
        authority: { source: 'lobby', rows: [{ pid: 10, port: 9100, room_id: 7, state: 'running' }] },
    }));
    assert.deepEqual(kinds(f).sort(), ['managed', 'stray-server']);
    const stray = f.find(x => x.kind === 'stray-server');
    assert.equal(stray.pid, 11);
    assert.equal(stray.severity, 'warning');
});

test('with no authority every server is only info, and cleanup refuses it', () => {
    const f = classifyStack(baseCensus({
        processes: { lobby: [], logserver: [], vite: [], server: [{ pid: 11, cmd: 'build/debug/spring-server' }] },
        authority: { source: 'none', rows: [] },
    }));
    const stray = f.find(x => x.kind === 'stray-server');
    assert.equal(stray.severity, 'info');
    assert.match(stray.detail, /authority unknown/);

    const { actions, refusals } = planCleanup(f, { authoritySource: 'none' });
    assert.deepEqual(actions, []);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0].reason, /authority unknown/);
});

test('a game-range listener with no managed pid is a zombie-port at error', () => {
    const f = classifyStack(baseCensus({
        ports: { available: true, listeners: [{ pid: 77, cmd: 'nc', port: 9105 }] },
    }));
    assert.deepEqual(kinds(f), ['zombie-port']);
    assert.equal(f[0].severity, 'error');
    assert.match(f[0].suggestedAction, /force:true/);
});

test('zombie-port cleanup needs force when the command is not spring-server', () => {
    const findings = [{ kind: 'zombie-port', severity: 'error', pid: 77, port: 9105, cmd: 'nc -l 9105' }];
    assert.equal(planCleanup(findings).actions.length, 0);
    assert.equal(planCleanup(findings).refusals[0].reason.includes('force:true'), true);
    assert.equal(planCleanup(findings, { force: true }).actions.length, 1);
    const springish = [{ ...findings[0], cmd: 'build/debug/spring-server --room 9' }];
    assert.equal(planCleanup(springish).actions.length, 1);
});

test('the :8011 lobby is managed and a second lobby is a duplicate at error', () => {
    const f = classifyStack(baseCensus({
        processes: {
            server: [], logserver: [], vite: [],
            lobby: [{ pid: 1, cmd: 'build/release/spring-lobby' }, { pid: 2, cmd: 'build/debug/spring-lobby' }],
        },
        ports: { available: true, listeners: [{ pid: 1, cmd: 'spring-lobb', port: 8011 }] },
    }));
    assert.deepEqual(kinds(f), ['duplicate-lobby', 'managed']);
    assert.equal(f.find(x => x.kind === 'duplicate-lobby').pid, 2);
});

test('cleanup never plans the :8011 holder, whatever its classification', () => {
    const findings = [{ kind: 'duplicate-lobby', severity: 'error', pid: 1, cmd: 'spring-lobby' }];
    const { actions, refusals } = planCleanup(findings, { lobbyPid: 1 });
    assert.deepEqual(actions, []);
    assert.match(refusals[0].reason, /:8011/);
});

test('a single lobby yields no duplicate-lobby finding and nothing to clean', () => {
    const f = classifyStack(baseCensus({
        processes: { server: [], logserver: [], vite: [], lobby: [{ pid: 1, cmd: 'build/release/spring-lobby' }] },
        ports: { available: true, listeners: [{ pid: 1, cmd: 'spring-lobb', port: 8011 }] },
    }));
    assert.deepEqual(kinds(f), ['managed']);
    assert.deepEqual(planCleanup(f, { kinds: ['duplicate-lobby'], lobbyPid: 1 }).actions, []);
});

test('a vite off :8012 is an orphan; the bound one is managed', () => {
    const f = classifyStack(baseCensus({
        processes: {
            server: [], logserver: [], lobby: [],
            vite: [{ pid: 5, cmd: 'vite' }, { pid: 6, cmd: 'vite' }],
        },
        ports: { available: true, listeners: [{ pid: 5, cmd: 'node', port: 8012 }, { pid: 6, cmd: 'node', port: 8013 }] },
    }));
    assert.deepEqual(kinds(f).sort(), ['managed', 'orphan-vite']);
    assert.equal(f.find(x => x.kind === 'orphan-vite').pid, 6);
});

test('a dead game_status pid is reported and never planned for cleanup', () => {
    const f = classifyStack(baseCensus({
        gameStatus: { available: true, rows: [{ room_id: 7, pid: 4242, port: 9100, alive: false }] },
    }));
    assert.deepEqual(kinds(f), ['stale-status-row']);
    assert.match(f[0].suggestedAction, /report-only/);
    assert.deepEqual(planCleanup(f, { kinds: ['stray-server', 'zombie-port', 'orphan-vite', 'duplicate-lobby'] }).actions, []);
    // even if a caller asks for it by name, it is not a cleanable kind
    assert.deepEqual(planCleanup(f, { kinds: ['stale-status-row'] }).actions, []);
});

test('binary drift and a mismatched running hash are separate findings', () => {
    const binaries = classifyBinaries({
        release: { mtimeMs: 1000, size: 1, engineHash: 'aaaaaaaaaaaaaaaa' },
        debug: { mtimeMs: 2000, size: 1, engineHash: 'bbbbbbbbbbbbbbbb' },
    });
    const f = classifyStack(baseCensus({
        binaries,
        identities: [{ pid: 10, port: 9100, identity: { engineHash: 'cccccccccccccccc', stamp: 'x', pid: 10 } }],
    }));
    assert.deepEqual(kinds(f).sort(), ['binary-drift', 'stale-binary-running']);
    assert.equal(f.find(x => x.kind === 'stale-binary-running').severity, 'warning');
});

test('a matching running hash produces no stale-binary finding', () => {
    const binaries = classifyBinaries({ release: { mtimeMs: 1000, size: 1, engineHash: 'aaaaaaaaaaaaaaaa' } });
    const f = classifyStack(baseCensus({
        binaries,
        identities: [{ pid: 10, port: 9100, identity: { engineHash: 'aaaaaaaaaaaaaaaa' } }],
    }));
    assert.deepEqual(kinds(f), []);
});

test('a server with no identity block is info, not a false positive', () => {
    const f = classifyStack(baseCensus({
        binaries: classifyBinaries({ release: { mtimeMs: 1, size: 1, engineHash: 'aaaaaaaaaaaaaaaa' } }),
        identities: [{ pid: 10, port: 9100, identity: null }],
    }));
    assert.equal(f[0].kind, 'stale-binary-running');
    assert.equal(f[0].severity, 'info');
    assert.match(f[0].detail, /predates identity reporting/);
});

test('missing lsof degrades to an info finding, not a failure', () => {
    const f = classifyStack(baseCensus({ ports: { available: false } }));
    assert.deepEqual(kinds(f), ['lsof-unavailable']);
    assert.equal(f[0].severity, 'info');
});

test('findings sort error-first and summarize ignores managed rows', () => {
    const f = classifyStack(baseCensus({
        processes: { lobby: [], logserver: [], vite: [], server: [{ pid: 11, cmd: 'build/debug/spring-server' }] },
        ports: { available: true, listeners: [{ pid: 77, cmd: 'nc', port: 9105 }] },
        authority: { source: 'lobby', rows: [] },
    }));
    assert.equal(f[0].severity, 'error');
    assert.equal(summarize(f), '1 zombie-port, 1 stray-server');
    assert.equal(summarize([{ kind: 'managed', severity: 'info' }]), 'stack clean (no findings beyond managed processes)');
});

test('planCleanup deduplicates a pid that produced two findings', () => {
    const findings = [
        { kind: 'stray-server', severity: 'warning', pid: 11, cmd: 'build/debug/spring-server' },
        { kind: 'zombie-port', severity: 'error', pid: 11, port: 9101, cmd: 'build/debug/spring-server' },
    ];
    assert.equal(planCleanup(findings).actions.length, 1);
});
