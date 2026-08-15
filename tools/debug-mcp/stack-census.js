// Stack census — the pure half of the MCP `list_stack` / `cleanup_stack` tools
// (PLAN-test-automation P8).
//
// Extracted from server.js for the same reason room-end.js was: the
// interesting part is classification (which of these processes is managed,
// which is a stray, which port is a zombie, which binary will actually be
// forked), it is pure, and it deserves tests — while server.js starts a stdio
// server on import and shells out to pgrep/ps/lsof.
//
// server.js owns every side effect: pgrep/ps/lsof, statSync, the
// `--print-engine-hash` probe, /api/metrics fetches and the kills. It hands
// the raw results here and gets findings + a cleanup plan back.

// --- Process patterns -------------------------------------------------------
//
// Patterns copied from tools/scripts/spring-services.sh:51-54. Keep in sync.
// The (debug|release) alternation is deliberate; a `.` wildcard here is NOT
// safe: `build/.*/spring-server` also matches the LOBBY, whose command line
// carries `--db data/spring-server.db` — `.*` happily spans the gap, so a
// "kill the game servers" match takes the lobby down with it.
export const STACK_PATTERNS = {
    lobby: 'build/(debug|release)/spring-lobby',
    server: 'build/(debug|release)/spring-server',
    logserver: 'build/(debug|release)/spring-logserver',
    vite: 'client/node_modules/.bin/vite',
};

/** Well-known dev-stack listeners (tools/scripts/spring-services.sh). */
export const STACK_PORTS = { logserver: 8010, lobby: 8011, vite: 8012 };

/** Game servers are assigned ports from this range by the lobby. */
export const GAME_PORT_MIN = 9100;
export const GAME_PORT_MAX = 10099;

/** 5 missed 2s heartbeats — the same threshold probeGame() uses. */
export const STATUS_STALE_SEC = 10;

export function isStackPort(port) {
    return port === STACK_PORTS.logserver || port === STACK_PORTS.lobby
        || port === STACK_PORTS.vite
        || (port >= GAME_PORT_MIN && port <= GAME_PORT_MAX);
}

// --- Parsers ----------------------------------------------------------------

/**
 * Parse `ps -o pid=,ppid=,lstart=,args=` output. `lstart` is a fixed 5-field
 * date (`Fri Aug 15 11:02:33 2026`), so the split is positional: 2 numbers,
 * 5 date fields, then the command line — which may itself contain spaces and
 * must NOT be re-split.
 */
export function parsePsOutput(text) {
    const rows = [];
    for (const line of String(text || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const parts = t.split(/\s+/);
        if (parts.length < 8) continue;
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        if (!Number.isFinite(pid)) continue;
        const lstart = parts.slice(2, 7).join(' ');
        // Re-find the command in the ORIGINAL line rather than joining parts,
        // so runs of spaces inside an argument survive.
        const idx = t.indexOf(lstart);
        const cmd = idx >= 0 ? t.slice(idx + lstart.length).trim() : parts.slice(7).join(' ');
        rows.push({ pid, ppid, lstart, cmd });
    }
    return rows;
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` machine output. Records are
 * one-per-line, tagged by their first character; `p`/`c` set the current
 * process context and every following `n` belongs to it.
 */
export function parseLsofF(text) {
    const out = [];
    let pid = null, cmd = '';
    for (const line of String(text || '').split('\n')) {
        if (!line) continue;
        const tag = line[0], val = line.slice(1);
        if (tag === 'p') { pid = Number(val); cmd = ''; continue; }
        if (tag === 'c') { cmd = val; continue; }
        if (tag !== 'n' || pid === null) continue;
        // `n` looks like `127.0.0.1:8011`, `*:9100`, or `[::1]:8010`.
        const m = /:(\d+)$/.exec(val);
        if (!m) continue;
        out.push({ pid, cmd, addr: val, port: Number(m[1]) });
    }
    return out;
}

/**
 * Control-server address for mprocs: env override > mprocs.yaml `server:` >
 * default — the same resolution order as spring-services.sh:73-81.
 */
export function resolveMprocsAddr({ env = '', yamlText = '' } = {}) {
    if (env) return env;
    const m = /^server:[ \t]+(\S+)/m.exec(String(yamlText || ''));
    if (m) return m[1];
    return '127.0.0.1:4050';
}

// --- Binaries ---------------------------------------------------------------

/**
 * Which spring-server the lobby will fork, and whether the other one is newer.
 *
 * The pick rule is replicated from rts/lobby_main.cpp:450-454 (release if it
 * exists, else debug) rather than probed — the lobby has no endpoint for it,
 * and the rule is one line.
 *
 * `drift` is the field note baked into lobby_main.cpp:447-449: a debug-only
 * rebuild is invisible in a lobby-driven arm, because the lobby keeps forking
 * the stale release binary.
 *
 * @param {{release?: {mtimeMs:number,size:number,engineHash?:string|null},
 *          debug?:   {mtimeMs:number,size:number,engineHash?:string|null}}} stats
 */
export function classifyBinaries(stats = {}) {
    const release = stats.release || null;
    const debug = stats.debug || null;
    const picked = release ? 'build/release/spring-server'
        : debug ? 'build/debug/spring-server' : null;
    const pickedStat = release || debug || null;
    const other = release ? debug : null;
    const drift = !!(pickedStat && other && other.mtimeMs > pickedStat.mtimeMs);
    return { picked, pickedStat, drift, release, debug };
}

// --- Classification ---------------------------------------------------------

const F = (kind, severity, fields) => ({ kind, severity, ...fields });

/**
 * Turn a raw census into `findings[]`.
 *
 * @param {object} c
 * @param {{lobby:object[],server:object[],logserver:object[],vite:object[]}} c.processes
 *        ps rows per pattern (`{pid, ppid, lstart, cmd}`).
 * @param {{available:boolean, listeners:object[]}} c.ports  parseLsofF output.
 * @param {{source:'lobby'|'sqlite'|'none', rows:object[]}} c.authority
 * @param {{available:boolean, rows:object[]}} c.gameStatus  rows carry `alive`.
 * @param {object} c.binaries  classifyBinaries() output.
 * @param {object[]} c.identities  `{pid, port, identity|null}` per probed server.
 */
export function classifyStack(c) {
    const findings = [];
    const listeners = c.ports?.available ? (c.ports.listeners || []) : [];
    const portsOf = pid => listeners.filter(l => l.pid === pid).map(l => l.port);
    const holderOf = port => listeners.find(l => l.port === port) || null;

    if (!c.ports?.available) {
        findings.push(F('lsof-unavailable', 'info', {
            detail: 'lsof not available — port-based classification skipped',
            suggestedAction: 'install lsof, or read `processes` only',
        }));
    }

    const authoritySource = c.authority?.source || 'none';
    const managedPids = new Set(
        (c.authority?.rows || []).map(r => Number(r.pid)).filter(Boolean),
    );

    // --- lobby / logserver / vite: managed when they hold their own port ----
    const lobbyPids = (c.processes.lobby || []).map(p => p.pid);
    const lobbyHolder = holderOf(STACK_PORTS.lobby);
    for (const p of c.processes.lobby || []) {
        const bound = lobbyHolder?.pid === p.pid;
        if (bound || lobbyPids.length === 1) {
            findings.push(F('managed', 'info', {
                pid: p.pid, port: bound ? STACK_PORTS.lobby : null, cmd: p.cmd,
                detail: bound ? 'lobby bound to :8011' : 'the only lobby process',
                suggestedAction: 'none',
            }));
        }
    }
    if (lobbyPids.length > 1) {
        // SO_REUSEPORT round-robins accepts between them, so the extras are not
        // merely idle — they answer real requests from a half-initialised state
        // (run-springrts-web "two lobbies" gotcha).
        for (const p of c.processes.lobby) {
            if (lobbyHolder?.pid === p.pid) continue;
            findings.push(F('duplicate-lobby', 'error', {
                pid: p.pid, cmd: p.cmd,
                detail: `${lobbyPids.length} spring-lobby processes; this one does not hold :8011`,
                suggestedAction: "cleanup_stack({kinds:['duplicate-lobby']})",
            }));
        }
    }

    for (const p of c.processes.logserver || []) {
        findings.push(F('managed', 'info', {
            pid: p.pid, port: portsOf(p.pid)[0] ?? null, cmd: p.cmd,
            detail: 'logserver', suggestedAction: 'none',
        }));
    }

    const vitePids = (c.processes.vite || []).map(p => p.pid);
    const viteHolder = holderOf(STACK_PORTS.vite);
    for (const p of c.processes.vite || []) {
        const bound = viteHolder?.pid === p.pid;
        if (bound) {
            findings.push(F('managed', 'info', {
                pid: p.pid, port: STACK_PORTS.vite, cmd: p.cmd,
                detail: 'vite bound to :8012', suggestedAction: 'none',
            }));
        } else if (c.ports?.available && (vitePids.length > 1 || !viteHolder)) {
            // A second vite silently takes a fallback port (:8013…). The client
            // bakes the lobby port at BUILD time, so a browser pointed at the
            // fallback drives the wrong stack and reads as a protocol mismatch.
            findings.push(F('orphan-vite', 'warning', {
                pid: p.pid, port: portsOf(p.pid)[0] ?? null, cmd: p.cmd,
                detail: 'vite process not listening on :8012 (fallback port?)',
                suggestedAction: "cleanup_stack({kinds:['orphan-vite']})",
            }));
        } else {
            findings.push(F('managed', 'info', {
                pid: p.pid, port: null, cmd: p.cmd,
                detail: 'vite (port unknown)', suggestedAction: 'none',
            }));
        }
    }

    // --- game servers -------------------------------------------------------
    const strayServerPids = new Set();
    for (const p of c.processes.server || []) {
        if (managedPids.has(p.pid)) {
            const row = (c.authority.rows || []).find(r => Number(r.pid) === p.pid);
            findings.push(F('managed', 'info', {
                pid: p.pid, port: row?.port ?? null, roomId: row?.room_id ?? null,
                cmd: p.cmd, detail: `game server for room ${row?.room_id} (state=${row?.state})`,
                suggestedAction: 'end_game({roomId}) for a graceful stop',
            }));
            continue;
        }
        strayServerPids.add(p.pid);
        // Lobby down ≠ everything is stray: with no authority every server
        // looks unmanaged, so the finding is demoted to info and cleanup
        // refuses to act on it.
        const unknown = authoritySource === 'none';
        findings.push(F('stray-server', unknown ? 'info' : 'warning', {
            pid: p.pid, port: portsOf(p.pid)[0] ?? null, cmd: p.cmd,
            detail: unknown
                ? 'lobby unreachable — authority unknown'
                : 'spring-server pid not in lobby /api/processes',
            suggestedAction: unknown
                ? 'start the lobby, then re-run list_stack'
                : "cleanup_stack({kinds:['stray-server']})",
        }));
    }

    // --- zombie ports -------------------------------------------------------
    const serverPids = new Set((c.processes.server || []).map(p => p.pid));
    for (const l of listeners) {
        if (l.port < GAME_PORT_MIN || l.port > GAME_PORT_MAX) continue;
        if (managedPids.has(l.pid)) continue;
        if (serverPids.has(l.pid)) continue;   // already reported as stray-server
        findings.push(F('zombie-port', 'error', {
            pid: l.pid, port: l.port, cmd: l.cmd,
            // Room routing is by port: a squatter on a game port makes the
            // lobby's next room unreachable (and auth fail) with no error
            // anywhere (the U8 session burned on exactly this).
            detail: 'listener in the game-server port range whose pid is not a managed game server',
            suggestedAction: `cleanup_stack({kinds:['zombie-port']})${
                /spring-server/.test(l.cmd || '') ? '' : ' — needs force:true (cmd is not spring-server)'}`,
        }));
    }

    // --- game_status rows ---------------------------------------------------
    if (c.gameStatus?.available) {
        for (const r of c.gameStatus.rows || []) {
            if (r.alive) continue;
            findings.push(F('stale-status-row', 'warning', {
                pid: r.pid, port: r.port, roomId: r.room_id,
                detail: `game_status row for room ${r.room_id} names dead pid ${r.pid}`,
                // Never deleted by the MCP: spring-server writes this row with
                // INSERT OR REPLACE and the lobby reads it, so a third writer
                // is a race; the row also deliberately outlives the process for
                // kill-and-resume (server_main.cpp:2177-2181).
                suggestedAction: 'row is refreshed/replaced by the next server for this room; report-only in v1',
            }));
        }
    }

    // --- binaries -----------------------------------------------------------
    if (c.binaries?.drift) {
        findings.push(F('binary-drift', 'warning', {
            detail: `${c.binaries.picked} is what the lobby forks, but the other build is newer`,
            suggestedAction: 'rebuild the picked binary, or delete it so the newer one is picked',
        }));
    }

    const diskHash = c.binaries?.pickedStat?.engineHash || null;
    for (const id of c.identities || []) {
        if (!id.identity) {
            findings.push(F('stale-binary-running', 'info', {
                pid: id.pid, port: id.port,
                detail: 'server predates identity reporting (/api/metrics has no `identity`)',
                suggestedAction: 'restart the game server to run a binary that reports its identity',
            }));
            continue;
        }
        if (diskHash && id.identity.engineHash && id.identity.engineHash !== diskHash) {
            findings.push(F('stale-binary-running', 'warning', {
                pid: id.pid, port: id.port,
                detail: `running engineHash ${id.identity.engineHash} ≠ ${c.binaries.picked} ${diskHash}`,
                suggestedAction: 'restart_game({roomId}) — the process you are testing is not the binary you built',
            }));
        }
    }

    const order = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return findings;
}

/** One-line human summary of a findings list. */
export function summarize(findings) {
    const counts = {};
    for (const f of findings) {
        if (f.kind === 'managed') continue;
        counts[f.kind] = (counts[f.kind] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}`);
    return parts.length ? parts.join(', ') : 'stack clean (no findings beyond managed processes)';
}

// --- Cleanup planning -------------------------------------------------------

/** The only classifications cleanup_stack will ever act on. */
export const CLEANABLE_KINDS = ['stray-server', 'zombie-port', 'orphan-vite', 'duplicate-lobby'];

/**
 * Decide, purely, which pids cleanup_stack may kill.
 *
 * The :8011 invariant is enforced here AND again in server.js's kill helper —
 * belt and braces, because "the lobby died during cleanup" is the one outcome
 * that costs a whole session.
 *
 * @param {object[]} findings   classifyStack() output
 * @param {object} opts
 * @param {string[]} [opts.kinds]   subset of CLEANABLE_KINDS (default: all)
 * @param {boolean} [opts.force]    allow zombie-port kills whose cmd isn't spring-server
 * @param {number|null} [opts.lobbyPid]  pid holding :8011, if known
 * @param {string} [opts.authoritySource]
 * @returns {{actions:object[], refusals:object[]}}
 */
export function planCleanup(findings, opts = {}) {
    const kinds = (opts.kinds && opts.kinds.length ? opts.kinds : CLEANABLE_KINDS)
        .filter(k => CLEANABLE_KINDS.includes(k));
    const actions = [];
    const refusals = [];
    const seen = new Set();

    for (const f of findings) {
        if (!kinds.includes(f.kind)) continue;
        const add = (reason) => refusals.push({ ...f, outcome: 'refused', reason });

        if (!f.pid) { add('finding has no pid'); continue; }
        if (opts.lobbyPid && f.pid === opts.lobbyPid) {
            add('pid holds a LISTEN on :8011 — never killed, whatever its classification');
            continue;
        }
        if (f.kind === 'stray-server' && opts.authoritySource === 'none') {
            add('lobby unreachable — authority unknown, so "stray" cannot be established');
            continue;
        }
        if (f.kind === 'zombie-port' && !/spring-server/.test(f.cmd || '') && !opts.force) {
            add('port-range match whose command is not spring-server — pass force:true if you mean it');
            continue;
        }
        if (seen.has(f.pid)) continue;
        seen.add(f.pid);
        actions.push({
            pid: f.pid, kind: f.kind, port: f.port ?? null, cmd: f.cmd || '',
            plan: 'SIGTERM → poll 5s → SIGKILL',
        });
    }
    return { actions, refusals };
}
