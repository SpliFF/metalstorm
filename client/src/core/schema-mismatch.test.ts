/**
 * PLAN-protocol-guard task 4 — the client remedy for a refused wire schema.
 *
 * Two rules are under test and neither is reachable from a healthy tree: the
 * server only says `VersionMismatch` to a bundle built against a different
 * schema, and the give-up arm needs a cache that keeps serving that bundle
 * after a reload. So the refusal is fabricated on both layers — a hand-built
 * `AuthResponse` for the routing, a pre-set flag for the loop guard.
 */
import { describe, it, expect, vi } from 'vitest';
import * as flatbuffers from 'flatbuffers';
import {
    decideSchemaMismatch, clearSchemaMismatchGuard, cacheBustUrl, stripCacheBust,
    schemaMismatchCardText, VM_RELOAD_FLAG, VM_CACHE_BUST_PARAM,
    type MismatchStorage,
} from './schema-mismatch.js';
import { Connection } from './connection.js';
import { AuthStatus } from '../protocol/spring-web/auth-status.js';
import { AuthResponse } from '../protocol/spring-web/auth-response.js';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { ENVELOPE_FLATBUFFERS } from './protocol-version.js';

const URL_BASE = 'https://game.example/play?room=7';
const SERVER_MSG = 'Wire schema mismatch (client 000000000000, server efdd25212f66)';

function memStorage(seed: Record<string, string> = {}): MismatchStorage & { map: Map<string, string> } {
    const map = new Map(Object.entries(seed));
    return {
        map,
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => { map.set(k, v); },
        removeItem: (k) => { map.delete(k); },
    };
}

describe('schema-mismatch policy', () => {
    it('reloads once, cache-busted, and records that it did', () => {
        const storage = memStorage();
        const action = decideSchemaMismatch(storage, URL_BASE, 'tok1', SERVER_MSG);
        expect(action.kind).toBe('reload');
        // The reload must not be answerable from the cache that just served
        // the rejected bundle, and it must keep the room param.
        const url = new URL((action as { url: string }).url);
        expect(url.searchParams.get(VM_CACHE_BUST_PARAM)).toBe('tok1');
        expect(url.searchParams.get('room')).toBe('7');
        expect(storage.map.get(VM_RELOAD_FLAG)).toBe('tok1');
    });

    it('gives up on the second mismatch instead of looping', () => {
        const storage = memStorage({ [VM_RELOAD_FLAG]: 'tok1' });
        const action = decideSchemaMismatch(storage, URL_BASE, 'tok2', SERVER_MSG);
        expect(action.kind).toBe('card');
        // Both hashes reach the reader — the pair is the only thing that says
        // which side is stale.
        expect((action as { message: string }).message).toBe(SERVER_MSG);
        expect(schemaMismatchCardText(SERVER_MSG)).toContain('efdd25212f66');
        expect(schemaMismatchCardText(SERVER_MSG)).toMatch(/hard-refresh/i);
    });

    it('still reloads once when there is no storage at all', () => {
        expect(decideSchemaMismatch(null, URL_BASE, 'tok1', SERVER_MSG).kind).toBe('reload');
    });

    it('gives up rather than reload blind when storage throws', () => {
        const throwing: MismatchStorage = {
            getItem: () => { throw new Error('blocked'); },
            setItem: () => { throw new Error('blocked'); },
            removeItem: () => { throw new Error('blocked'); },
        };
        // A tab that cannot remember it reloaded must not be given a reload it
        // can repeat forever.
        expect(decideSchemaMismatch(throwing, URL_BASE, 'tok1', SERVER_MSG).kind).toBe('card');
        const writeOnly: MismatchStorage = {
            getItem: () => null,
            setItem: () => { throw new Error('quota'); },
            removeItem: () => {},
        };
        expect(decideSchemaMismatch(writeOnly, URL_BASE, 'tok1', SERVER_MSG).kind).toBe('card');
    });

    it('returns the reload budget and cleans the URL on a good auth', () => {
        const storage = memStorage({ [VM_RELOAD_FLAG]: 'tok1' });
        const busted = cacheBustUrl(URL_BASE, 'tok1');
        const clean = clearSchemaMismatchGuard(storage, busted);
        expect(storage.map.has(VM_RELOAD_FLAG)).toBe(false);
        expect(new URL(clean).searchParams.has(VM_CACHE_BUST_PARAM)).toBe(false);
        expect(new URL(clean).searchParams.get('room')).toBe('7');
        // A URL that was never busted comes back byte-identical, so the good
        // path never touches history.
        expect(stripCacheBust(URL_BASE)).toBe(URL_BASE);
        // …and the next mismatch is entitled to its own reload.
        expect(decideSchemaMismatch(storage, URL_BASE, 'tok3', SERVER_MSG).kind).toBe('reload');
    });
});

/** One `ServerMessage(AuthResponse)` envelope, as the game server sends it. */
function authResponseEnvelope(status: AuthStatus, message: string): Uint8Array {
    const builder = new flatbuffers.Builder(256);
    const msgOff = builder.createString(message);
    const roleOff = builder.createString('player');
    const ar = AuthResponse.createAuthResponse(
        builder, status, 0, 0, msgOff, 0, roleOff, 0, 0);
    const sm = ServerMessage.createServerMessage(
        builder, ServerPayload.AuthResponse, ar);
    builder.finish(sm);
    const fb = builder.asUint8Array();
    const out = new Uint8Array(fb.length + 1);
    out[0] = ENVELOPE_FLATBUFFERS;
    out.set(fb, 1);
    return out;
}

describe('Connection AuthResponse routing', () => {
    it('routes VersionMismatch to the schema handler, not the auth handler', () => {
        const onVersionMismatch = vi.fn();
        const onAuthFailed = vi.fn();
        const conn = new Connection({ onVersionMismatch, onAuthFailed });
        (conn as unknown as { handleBinaryMessage(d: Uint8Array): void })
            .handleBinaryMessage(authResponseEnvelope(AuthStatus.VersionMismatch, SERVER_MSG));
        expect(onVersionMismatch).toHaveBeenCalledWith(SERVER_MSG);
        expect(onAuthFailed).not.toHaveBeenCalled();
    });

    it('leaves every other rejection on the generic auth-failure path', () => {
        const onVersionMismatch = vi.fn();
        const onAuthFailed = vi.fn();
        const conn = new Connection({ onVersionMismatch, onAuthFailed });
        (conn as unknown as { handleBinaryMessage(d: Uint8Array): void })
            .handleBinaryMessage(authResponseEnvelope(AuthStatus.InvalidCredentials, 'bad password'));
        expect(onAuthFailed).toHaveBeenCalledWith('bad password');
        expect(onVersionMismatch).not.toHaveBeenCalled();
    });

    it('falls back to onAuthFailed for a host with no schema handler', () => {
        // viewport.ts is exactly this host: a second window that shows the
        // message as text. It must not lose the rejection entirely.
        const onAuthFailed = vi.fn();
        const conn = new Connection({ onAuthFailed });
        (conn as unknown as { handleBinaryMessage(d: Uint8Array): void })
            .handleBinaryMessage(authResponseEnvelope(AuthStatus.VersionMismatch, SERVER_MSG));
        expect(onAuthFailed).toHaveBeenCalledWith(SERVER_MSG);
    });
});
