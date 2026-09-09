// room-target.js — which game server does a `roomId` mean?
//
// WHY THIS EXISTS (memory: "spring-debug roomId is a port"). Every spawned
// spring-server binds the same port range starting at 9100, and the lobby's
// process list keeps a row for a room after its server has gone (state
// 'ended', or a hibernated pid-0 row). `getGameServerUrl(oldRoom)` used to
// take that stale row's port verbatim, so `exec_lua({roomId: 7})` against a
// war that ended at frame 9300 answered `frame=885` — from room 8, which had
// since bound the same port. A plausible number from the wrong sim corrupts a
// comparison silently; that is worse than an error.
//
// Rules, pure and tested:
//   * an EXPLICIT roomId must name a row whose server is alive (pid > 0 and
//     signal-0 reachable, state not 'ended'); otherwise refuse, and if another
//     live row now holds that port, say so by name.
//   * NO roomId keeps the permissive auto-pick (running → starting → any
//     non-ended), but skips rows whose pid is dead — a lobby row can outlive
//     its process.
//   * a roomId that matches no room but equals some row's PORT gets told it
//     passed a port.

function describeRow(s) {
    return `  room ${s.room_id} (state=${s.state}, pid=${s.pid}, port=${s.port}${s.map_id ? `, map=${s.map_id}` : ''})`;
}

export function listCandidates(servers) {
    return servers.map(describeRow).join('\n') || '  (none)';
}

/** True when the row describes a server we may route to. */
export function rowIsLive(s, pidAlive) {
    if (!s) return false;
    if (s.state === 'ended') return false;
    if (!(s.pid > 0)) return false;             // hibernated / never spawned
    return pidAlive(s.pid);
}

/**
 * Resolve `roomId` against the lobby's rows.
 * @returns {{server:object}|{error:string}}
 */
export function pickServer(servers, roomId, { pidAlive }) {
    const rows = Array.isArray(servers) ? servers : [];
    if (roomId !== undefined && roomId !== null && roomId > 0) {
        const row = rows.find(s => s.room_id === roomId);
        if (!row) {
            const byPort = rows.find(s => s.port === roomId);
            const portHint = byPort
                ? ` ${roomId} is a PORT, not a room id — port ${roomId} belongs to room ${byPort.room_id} (state=${byPort.state}); pass roomId: ${byPort.room_id}.`
                : '';
            return { error: `Error: no game server for room ${roomId}.${portHint} Candidates:\n${listCandidates(rows)}` };
        }
        if (!rowIsLive(row, pidAlive)) {
            const why = row.state === 'ended' ? 'has ended'
                : !(row.pid > 0) ? 'is hibernated (no process)'
                : `is dead (pid ${row.pid} is gone, row state='${row.state}')`;
            const squatter = rows.find(s => s !== row && s.port === row.port && rowIsLive(s, pidAlive));
            const hint = squatter
                ? ` Port ${row.port} is now bound by room ${squatter.room_id} (state=${squatter.state}) — a query aimed at room ${roomId} would have answered from room ${squatter.room_id}'s sim without any error.`
                : '';
            return { error: `Error: room ${roomId} ${why}; refusing to route to :${row.port}.${hint} Live candidates:\n${listCandidates(rows.filter(s => rowIsLive(s, pidAlive)))}` };
        }
        return { server: row };
    }
    const live = rows.filter(s => rowIsLive(s, pidAlive));
    const server = live.find(s => s.state === 'running')
        || live.find(s => s.state === 'starting')
        || live[0];
    if (!server) {
        return {
            error: rows.length
                ? `Error: no LIVE game server (every row is ended, hibernated or dead). Rows:\n${listCandidates(rows)}`
                : 'Error: no game servers found. Is the lobby running and is a game in progress?',
        };
    }
    return { server };
}
