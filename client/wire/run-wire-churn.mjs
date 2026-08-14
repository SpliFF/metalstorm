#!/usr/bin/env node
/**
 * Churn driver — PLAN-long-uptime.md **T4-1**'s arm ("ladder 2").
 *
 * `run-wire-client.mjs` opens ONE session and asserts on it. §2's churn
 * amplifier wants the opposite shape: N sessions connecting, sending and
 * disconnecting for the length of a soak window, so the per-client surfaces
 * (S1's interned rulesParams key dictionary, S6's standing orders, S12's
 * player rows) are exercised at all. Those read 0 at every sample of every
 * headless ladder run so far — not because they are bounded but because
 * `StateStreamer::BroadcastRulesParams` returns before the interning block
 * when the client count is zero (T4-2). A headless run has no clients, so no
 * length of headless ladder can rule them.
 *
 * ONE node process holds every session. Spawning `run-wire-client.mjs` per
 * cycle would pay vite + the native quiche addon (~3 s here) per connect, so
 * the churn rate would be a measurement of node's start-up cost rather than of
 * the server. The transport and its pinning hook are therefore loaded once,
 * exactly as run-wire-client.mjs loads them, and the two files share the
 * ordering trap that matters: **the FAILSVerifyProof hook must be installed
 * AFTER importing the package**, which installs its own at import time.
 *
 * Usage:
 *   node wire/run-wire-churn.mjs --url http://127.0.0.1:19300 \
 *     --users soak0:devpass,soak1:devpass --duration-ms 120000 \
 *     [--hold-ms 4000] [--gap-ms 500] [--command 10] [--standing-order-type 0]
 *     [--wait-for-server 60000] [--json] [--quiet]
 *
 * Exit status: 0 = the window ran and every cycle authenticated, 1 = an
 * assertion failed (a cycle could not authenticate, bytes did not leave), 2 =
 * the harness itself could not run. Same three-way split as
 * run-wire-client.mjs, for the same reason: exit 2 sends the reader to their
 * npm install, so a misbehaving SERVER must never produce it.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '..');

/** CMD_MOVE — the order a player issues most, and what the browser sends. */
const CMD_MOVE = 10;

function parseArgs(argv) {
    const out = {
        url: 'http://127.0.0.1:9001', users: [], durationMs: 60_000,
        holdMs: 3_000, gapMs: 500, command: CMD_MOVE, standingOrderType: 0,
        ordersPerCycle: 1, waitForServerMs: 0, json: false, quiet: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--url': out.url = next(); break;
            case '--users':
                out.users = next().split(',').filter(Boolean).map((spec) => {
                    const [user, pass = 'devpass'] = spec.split(':');
                    return { user, pass };
                });
                break;
            case '--duration-ms': out.durationMs = Number(next()); break;
            case '--hold-ms': out.holdMs = Number(next()); break;
            case '--gap-ms': out.gapMs = Number(next()); break;
            case '--command': out.command = Number(next()); break;
            case '--standing-order-type': out.standingOrderType = Number(next()); break;
            case '--orders-per-cycle': out.ordersPerCycle = Number(next()); break;
            case '--wait-for-server': out.waitForServerMs = Number(next()); break;
            case '--json': out.json = true; break;
            case '--quiet': out.quiet = true; break;
            default:
                console.error(`unknown argument: ${a}`);
                process.exit(2);
        }
    }
    if (!out.users.length) { console.error('--users is required'); process.exit(2); }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const log = args.quiet ? () => {} : (m) => console.log(m);

// The node client reports a refused handshake by throwing out of a UDP socket
// callback, where no try/catch can see it. In a churn window that is a real
// possibility (the server can go away mid-window when its stop condition
// fires), and it must not be reported as this harness failing to run.
let windowClosed = false;
process.on('uncaughtException', (err) => {
    if (windowClosed) return;
    console.error(`harness error (uncaught): ${err?.stack ?? err}`);
    process.exit(2);
});

/** Load the node WebTransport client, then install hash pinning over its hook.
 *  Identical to run-wire-client.mjs's, including the ordering requirement. */
async function loadWebTransport(pinnedHashes) {
    let mod;
    try {
        mod = await import('@fails-components/webtransport');
    } catch (e) {
        console.error('cannot load @fails-components/webtransport — run `npm install` '
            + `in client/ (this harness needs its native quiche addon): ${e.message}`);
        process.exit(2);
    }
    await mod.quicheLoaded;
    globalThis.FAILSVerifyProof = (obj) => {
        if (!obj?.certs?.length) return false;
        const der = Buffer.from(new Uint8Array(obj.certs[0]));
        return pinnedHashes.includes(createHash('sha256').update(der).digest('hex'));
    };
    return mod.WebTransport;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Write one line to stdout and WAIT for it to leave.
 *
 * `console.log` + `process.exit()` truncates: stdout to a pipe is asynchronous,
 * so the exit discards whatever is still buffered. Measured 2026-08-14 on a
 * 6-minute window — the verdict carries one seat record per cycle, crossed the
 * 8 KiB pipe buffer at 142 cycles, and the caller received exactly 8 192 bytes
 * of JSON and a **zero** exit status. The 3-minute window (66 cycles) fitted and
 * passed, so the harness was correct in exactly the arms that did not matter.
 * Same shape as the voided writes on the wire: a report that never left, read as
 * sent.
 */
function emit(line) {
    return new Promise((resolve) => { process.stdout.write(`${line}\n`, resolve); });
}

const vite = await createServer({
    configFile: false, root: CLIENT_ROOT, logLevel: 'error',
    server: { middlewareMode: true },
});

let exitCode = 2;
try {
    const { WireClient } = await vite.ssrLoadModule('/wire/wire-client.ts');
    const { ClientPayload } = await vite.ssrLoadModule('/src/protocol/spring-web/client-payload.ts');

    // Discovery first: the hashes it publishes are what the pinning hook is
    // built from, and it doubles as the wait for the server to exist.
    const probe = new WireClient({
        httpBase: args.url, username: args.users[0].user, password: args.users[0].pass,
        WebTransportCtor: class { }, log,
    });
    const deadline = Date.now() + args.waitForServerMs;
    let info;
    for (;;) {
        try { info = await probe.discover(); break; } catch (e) {
            if (Date.now() >= deadline) {
                console.error(`the server did not answer /api/wt/info within `
                    + `${args.waitForServerMs} ms: ${e?.message ?? e}`);
                process.exit(2);
            }
            await sleep(50);
        }
    }
    log(`[churn] wt/info port=${info.port} certMode=${info.certMode} `
        + `hashes=${info.certHashes.length}`);

    const WebTransportCtor = await loadWebTransport(info.certHashes);

    const windowEnd = Date.now() + args.durationMs;
    /** Per-slot tallies. Everything a verdict is allowed to rest on is counted
     *  here — a cycle is only "done" once its session authenticated AND its
     *  bytes left, so a window that connected N times and said nothing cannot
     *  read as N cycles of churn. */
    const totals = {
        cyclesStarted: 0, cyclesAuthed: 0, cyclesFailed: 0,
        sentByPayload: {}, serverErrorsByCode: {}, writeErrors: [],
        seats: [], failures: [], keyDictionaryCycles: [],
    };

    // S1's census (PLAN-long-uptime T4-1e). Every session is sent the WHOLE key
    // dictionary at join, so the per-cycle DELTA against everything seen so far
    // is what the window minted — recorded uncapped, because a sampled key list
    // would answer "which keys" with whichever ones happened to be sampled.
    // Ids are deliberately not recorded: a compaction inside the window
    // renumbers them, and `rev` is what makes that visible.
    const keysSeen = new Set();
    let dictCycle = 0;
    function tallyKeyDictionary(client) {
        const dict = client.latestKeyDictionary();
        if (!dict) return;
        const newKeys = [];
        for (const k of dict.keys) {
            if (keysSeen.has(k)) continue;
            keysSeen.add(k);
            newKeys.push(k);
        }
        totals.keyDictionaryCycles.push({
            cycle: dictCycle++, rev: dict.rev, size: dict.keys.length, newKeys,
        });
    }

    function tallySent(client) {
        for (const [tag, n] of client.sentByPayload) {
            totals.sentByPayload[tag] = (totals.sentByPayload[tag] ?? 0) + n;
        }
        for (const e of client.serverErrors) {
            totals.serverErrorsByCode[e.code] = (totals.serverErrorsByCode[e.code] ?? 0) + 1;
        }
        for (const w of client.writeErrors) totals.writeErrors.push(w);
    }

    async function slot({ user, pass }) {
        while (Date.now() < windowEnd) {
            totals.cyclesStarted++;
            const client = new WireClient({
                httpBase: args.url, username: user, password: pass,
                WebTransportCtor, log: () => {}, sessionOptions: () => ({}),
            });
            try {
                await client.connect();
                const auth = await client.awaitAuth(20_000);
                if (!auth.ok) {
                    totals.cyclesFailed++;
                    totals.failures.push(`${user}: auth refused (status ${auth.status})`);
                } else {
                    totals.cyclesAuthed++;
                    // The seat is recorded per cycle rather than once: a churn
                    // window that loses its seats halfway (a roster the server
                    // stopped honouring, a promotion that stopped firing) is
                    // invisible in a single sample taken at the start.
                    totals.seats.push({ user, playerNum: auth.playerNum, team: auth.team, role: auth.role });
                    if (args.command !== null && args.command >= 0) {
                        client.sendPlayerCommand({
                            commandId: args.command, squadIds: [1],
                            params: [4000, 0, 4000],
                        });
                    }
                    for (let i = 0; i < args.ordersPerCycle; i++) {
                        client.sendStandingOrderCreate({
                            type: args.standingOrderType, priority: 50,
                            params: [4000, 0, 4000, 600],
                        });
                    }
                    await client.flush();
                }
                // Hold: a create's refusal (401/402/429) comes back after the
                // send returns, so a cycle that closed immediately would report
                // every order as issued and none as refused.
                await sleep(Math.min(args.holdMs, Math.max(0, windowEnd - Date.now())));
            } catch (e) {
                totals.cyclesFailed++;
                totals.failures.push(`${user}: ${e?.message ?? e}`);
            } finally {
                tallySent(client);
                // After the hold, so the dictionary counted is the one the
                // session held at the END of its cycle — a rev bump arriving
                // during the hold is this cycle's, not the next one's.
                tallyKeyDictionary(client);
                client.close();
            }
            if (Date.now() < windowEnd) await sleep(args.gapMs);
        }
    }

    log(`[churn] ${args.users.length} slot(s) x ${(args.durationMs / 1000).toFixed(0)} s `
        + `(hold ${args.holdMs} ms, gap ${args.gapMs} ms)`);
    await Promise.all(args.users.map(slot));
    windowClosed = true;

    const failures = [];
    if (totals.cyclesAuthed === 0) failures.push('no cycle authenticated — the churn window exercised nothing');
    if (totals.writeErrors.length) failures.push(`${totals.writeErrors.length} write(s) never left the client`);

    const verdict = {
        ...totals,
        standingOrderPayloadType: ClientPayload.StandingOrderCreate,
        commandPayloadType: args.command >= 0 ? ClientPayload.PlayerCommand : null,
        durationMs: args.durationMs,
        users: args.users.map((u) => u.user),
        failures,
    };
    if (args.json) await emit(JSON.stringify(verdict));
    const dictSamples = totals.keyDictionaryCycles;
    log(`[churn] key dictionary: ${dictSamples.length} sample(s), `
        + `${keysSeen.size} distinct key(s), final size `
        + `${dictSamples.length ? dictSamples[dictSamples.length - 1].size : 0}`);
    log(`[churn] cycles ${totals.cyclesAuthed} authed / ${totals.cyclesStarted} started, `
        + `${totals.cyclesFailed} failed; server errors `
        + `${JSON.stringify(totals.serverErrorsByCode)}`);

    exitCode = failures.length ? 1 : 0;
    for (const f of failures) console.error(`FAIL: ${f}`);
} catch (e) {
    console.error(`harness error: ${e?.stack ?? e}`);
    exitCode = 2;
} finally {
    await vite.close();
}
process.exit(exitCode);
