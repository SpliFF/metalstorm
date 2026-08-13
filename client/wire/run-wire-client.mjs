#!/usr/bin/env node
/**
 * Node entry point for the scripted wire client (PLAN-replay.md §7.11 T2-a-1).
 *
 * Node has no WebTransport — not in any release, not behind a flag — so the
 * client comes from `@fails-components/webtransport` (libquiche, prebuilt native
 * addon). Two facts about it are load-bearing and were both measured rather than
 * read:
 *
 *  1. **It does not implement `serverCertificateHashes`.** It verifies a chain
 *     through a global hook, `globalThis.FAILSVerifyProof`, which rejects our
 *     self-signed rolling cert. Pinning is therefore implemented HERE, by
 *     repointing that hook at the hashes `/api/wt/info` publishes — the same
 *     material the browser pins, checked the same way (SHA-256 of the leaf DER).
 *     It is a real check, not a bypass: a wrong hash must fail the handshake.
 *  2. **The hook must be installed AFTER importing the package**, which assigns
 *     its own at import time. Installing it first looks like it works and is
 *     silently overwritten — the connection then fails in the QUIC handshake
 *     with a bare "Opening handshake failed."
 *
 * The wire logic itself is `wire-client.ts`, loaded through vite so it can
 * import the app's own generated FlatBuffers and control framing. vite is
 * already a client dependency and is how the browser resolves those same
 * modules, so there is no second build path to keep in step.
 *
 * Usage:
 *   node wire/run-wire-client.mjs --url http://127.0.0.1:9001 --user alice \
 *       [--pass secret] [--expect-auth ok|reject] [--expect-player-num N]
 *       [--command 10 --squads 1,2 --params 100,0,100] [--hold-ms 2000] [--json]
 *
 * Exit status: 0 = every assertion held, 1 = an assertion failed, 2 = the
 * harness itself could not run (no server, no addon, bad arguments).
 */

import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
    const out = {
        url: 'http://127.0.0.1:9001', user: '', pass: '', token: '',
        expectAuth: 'ok', expectPlayerNum: null, command: null,
        squads: [], params: [], options: 0, holdMs: 1500, json: false, quiet: false,
        pinMismatch: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--url': out.url = next(); break;
            case '--user': out.user = next(); break;
            case '--pass': out.pass = next(); break;
            case '--token': out.token = next(); break;
            case '--expect-auth': out.expectAuth = next(); break;
            case '--expect-player-num': out.expectPlayerNum = Number(next()); break;
            case '--command': out.command = Number(next()); break;
            case '--squads': out.squads = next().split(',').filter(Boolean).map(Number); break;
            case '--params': out.params = next().split(',').filter(Boolean).map(Number); break;
            case '--options': out.options = Number(next()); break;
            case '--hold-ms': out.holdMs = Number(next()); break;
            case '--json': out.json = true; break;
            case '--quiet': out.quiet = true; break;
            case '--pin-mismatch': out.pinMismatch = true; break;
            default:
                console.error(`unknown argument: ${a}`);
                process.exit(2);
        }
    }
    if (!out.user) { console.error('--user is required'); process.exit(2); }
    if (out.expectAuth !== 'ok' && out.expectAuth !== 'reject') {
        console.error('--expect-auth takes "ok" or "reject"'); process.exit(2);
    }
    return out;
}

/** Load the node WebTransport client, then install hash pinning over its hook. */
async function loadWebTransport(pinnedHashes, log) {
    let mod;
    try {
        mod = await import('@fails-components/webtransport');
    } catch (e) {
        console.error('cannot load @fails-components/webtransport — run `npm install` '
            + `in client/ (this harness needs its native quiche addon): ${e.message}`);
        process.exit(2);
    }
    await mod.quicheLoaded;

    // AFTER the import — see the header note (2).
    let verifyCalls = 0;
    globalThis.FAILSVerifyProof = (obj) => {
        verifyCalls++;
        if (!obj?.certs?.length) return false;
        const der = Buffer.from(new Uint8Array(obj.certs[0]));
        const hash = createHash('sha256').update(der).digest('hex');
        const pinned = pinnedHashes.includes(hash);
        log(`[wire] cert ${hash} ${pinned ? 'matches a pinned hash' : 'IS NOT PINNED — refusing'}`);
        return pinned;
    };
    return { WebTransport: mod.WebTransport, verifyCalls: () => verifyCalls };
}

const args = parseArgs(process.argv.slice(2));
const log = args.quiet ? () => {} : (m) => console.log(m);

// The node client reports a refused handshake by THROWING from a UDP socket
// callback, outside any promise chain — so a `try`/`catch` around connect() does
// not see it and the process dies with a stack trace instead of a verdict. Under
// `--pin-mismatch` that throw IS the expected result, so it is claimed here.
process.on('uncaughtException', (err) => {
    if (args.pinMismatch && /handshake failed/i.test(String(err?.message))) {
        console.log(`[wire] PASS — handshake refused as it must: ${err.message}`);
        process.exit(0);
    }
    console.error(`harness error (uncaught): ${err?.stack ?? err}`);
    process.exit(2);
});

const vite = await createServer({
    configFile: false, root: CLIENT_ROOT, logLevel: 'error',
    server: { middlewareMode: true },
});
let exitCode = 2;
try {
    const { WireClient } = await vite.ssrLoadModule('/wire/wire-client.ts');
    const { AuthStatus } = await vite.ssrLoadModule('/src/protocol/spring-web/auth-status.ts');

    // Discovery runs before the transport is loaded, because the hashes it
    // publishes are what the pinning hook is built from.
    const probe = new WireClient({
        httpBase: args.url, username: args.user, password: args.pass,
        WebTransportCtor: class { }, log,
    });
    const info = await probe.discover();
    log(`[wire] wt/info port=${info.port} certMode=${info.certMode} `
        + `hashes=${info.certHashes.length}`);

    // `--pin-mismatch` is the harness's self-test: pin a hash the server cannot
    // present and the QUIC handshake must fail. Without it, a hook that returned
    // `true` unconditionally would pass every other arm here identically, and
    // the harness would be connecting to anything that answered on the port.
    const pinned = args.pinMismatch ? ['0'.repeat(64)] : info.certHashes;
    if (args.pinMismatch) log('[wire] --pin-mismatch: pinning a hash the server cannot present');

    const wt = await loadWebTransport(pinned, log);
    const client = new WireClient({
        httpBase: args.url, username: args.user, password: args.pass,
        token: args.token || undefined, WebTransportCtor: wt.WebTransport, log,
        // The browser needs the hashes in the constructor; this client pins
        // through the hook, so it is handed nothing.
        sessionOptions: () => ({}),
    });

    if (args.pinMismatch) {
        try {
            await client.connect();
            console.error('FAIL: the session opened against an unpinned certificate');
            exitCode = 1;
        } catch (e) {
            log(`[wire] PASS — handshake refused as it must: ${e?.message ?? e}`);
            exitCode = 0;
        }
        client.close();
        await vite.close();
        process.exit(exitCode);
    }

    await client.connect();
    const auth = await client.awaitAuth();

    const failures = [];
    if (args.expectAuth === 'ok' && !auth.ok) {
        failures.push(`expected auth OK, got ${AuthStatus[auth.status]} (${auth.message})`);
    }
    if (args.expectAuth === 'reject' && auth.ok) {
        failures.push('expected auth to be refused, but it succeeded');
    }
    if (args.expectPlayerNum !== null && auth.playerNum !== args.expectPlayerNum) {
        failures.push(`expected playerNum ${args.expectPlayerNum}, got ${auth.playerNum}`);
    }

    if (args.command !== null && auth.ok) {
        client.sendPlayerCommand({
            commandId: args.command, squadIds: args.squads,
            params: args.params, options: args.options,
        });
    }

    // Hold the session open: a command's effect (and any server refusal) arrives
    // after the send returns, and a harness that exits immediately proves only
    // that the bytes were written.
    if (args.holdMs > 0) await new Promise((r) => setTimeout(r, args.holdMs));

    const envelopes = [...client.inboundByEnvelope.entries()]
        .map(([k, v]) => `0x${k.toString(16).padStart(2, '0')}:${v}`).join(' ');
    const payloads = [...client.inboundByPayload.entries()]
        .map(([k, v]) => `${k}:${v}`).join(' ');

    if (args.json) {
        console.log(JSON.stringify({
            auth, verifyCalls: wt.verifyCalls(),
            inboundByEnvelope: Object.fromEntries(client.inboundByEnvelope),
            inboundByPayload: Object.fromEntries(client.inboundByPayload),
            failures,
        }));
    } else {
        log(`[wire] inbound envelopes: ${envelopes || '(none)'}`);
        log(`[wire] inbound flatbuffers payloads: ${payloads || '(none)'}`);
        log(`[wire] cert verifications: ${wt.verifyCalls()}`);
    }

    client.close();
    if (failures.length) {
        for (const f of failures) console.error(`FAIL: ${f}`);
        exitCode = 1;
    } else {
        log('[wire] PASS');
        exitCode = 0;
    }
} catch (e) {
    console.error(`harness error: ${e?.stack ?? e}`);
    exitCode = 2;
} finally {
    await vite.close();
}
process.exit(exitCode);
