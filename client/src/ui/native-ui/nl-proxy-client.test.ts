/**
 * nl-proxy-client.test.ts — the proxy path and its fallback
 * (PLAN-metalstorm-command-language.md §3 "Degradation", §8, milestone M4)
 *
 * `runUtterance` is the only function in the client that can reach the network,
 * and the whole design rests on one asymmetry it implements:
 *
 *   - **The proxy being unavailable is an operational state.** 503, 429, a
 *     timeout, a dead socket — all of them fall back to the local slot-filler
 *     and tag the line "(offline parser)". The player keeps playing.
 *   - **The proxy returning a bad envelope is a bug.** A 200 whose body fails
 *     `validateNLResponse` prints the validator's complaint. Falling back there
 *     would silently paper over a broken contract with a worse parser, and the
 *     first anyone would know is a player wondering why complex sentences
 *     stopped working.
 *
 * These tests never touch the network: `fetchImpl` is injected. There is no
 * live-API call in any suite (§8) — `tools/nl-eval/` is the opt-in harness that
 * needs a key, and it is excluded from CI on purpose.
 */

import { describe, it, expect } from 'vitest';
import { OFFLINE_TAG, runUtterance, type ProxyDeps } from './nl-client.js';
import type { NLConsoleLine, NLSentCommand } from './nl-executor.js';
import { validateNLResponse } from './nl-envelope.js';
import { buildFixtureWorld } from './nl-fixtures/fixture-world.js';
import { loadContexts, loadVocabulary } from './nl-fixtures/load-fixtures.test-support.js';

const vocabulary = loadVocabulary();
const contexts = loadContexts();

function setup(contextKey = 'basin') {
    const world = buildFixtureWorld(contexts[contextKey], vocabulary);
    const sent: NLSentCommand[] = [];
    const lines: NLConsoleLine[] = [];
    const deps = {
        index: world.index,
        vocabulary,
        selectionGroupId: world.deps.selectionGroupId ?? null,
        groupLabel: (id: number) => world.groups.find((g) => g.groupId === id)?.name ?? `Group ${id}`,
        ports: {
            sendCommand: (cmd: unknown) => sent.push(cmd as NLSentCommand),
            resolver: world.resolver,
            console: { say: (line: NLConsoleLine) => lines.push(line) },
        },
    };
    return { deps, sent, lines, world };
}

/** A `fetch` that answers with whatever the test says, and records the request
 *  so the payload itself can be asserted. */
function stubFetch(reply: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: unknown, init: unknown) => {
        calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
        return reply();
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

function proxyDeps(fetchImpl: typeof fetch, over: Partial<ProxyDeps> = {}): ProxyDeps {
    return {
        endpoint: 'http://localhost:8011',
        token: 'test-token',
        context: { places: [{ n: 'Northgate', t: 'region' }] },
        fetchImpl,
        ...over,
    };
}

// ─────────────────────────────── the fallback ──────────────────────────────

describe('the proxy being unavailable falls back to the offline parser', () => {
    // The headline acceptance case: key unset on the server ⇒ 503 ⇒ the
    // player's simple sentences still work, tagged so they can see why.
    it('503 nl-disabled produces a valid envelope via the accelerator', async () => {
        const { impl, calls } = stubFetch(() => jsonResponse(503, { error: 'nl-disabled' }));
        const s = setup();

        const result = await runUtterance('defend Northgate', {
            ...s.deps,
            proxy: proxyDeps(impl),
        });

        expect(calls).toHaveLength(1);
        expect(result.source).toBe('offline-parser');
        expect(result.fallbackReason).toBe('HTTP 503');

        // The envelope the local path produced is a REAL one — this is the
        // §8 fallback-path assertion, not just "it didn't throw".
        expect(validateNLResponse(result.response, { vocabulary }).ok).toBe(true);
        expect(result.report.sent.length).toBeGreaterThan(0);
    });

    it('tags the console line "(offline parser)"', async () => {
        const { impl } = stubFetch(() => jsonResponse(503, { error: 'nl-disabled' }));
        const s = setup();

        await runUtterance('defend Northgate', { ...s.deps, proxy: proxyDeps(impl) });

        const tagged = s.lines.filter((l) => (l.notes ?? []).includes(OFFLINE_TAG));
        expect(tagged.length).toBe(1);
        // On the first line the executor printed that the player would read as
        // an ANSWER — not appended at the end, where someone scrolling their
        // transcript would never connect it to the sentence it explains.
        // `system` lines are skipped by `withNotes` on purpose: they are the
        // console narrating itself, and hanging "(offline parser)" off one
        // would attach the badge to something that isn't the outcome.
        const firstAnswer = s.lines.find((l) => l.kind !== 'system');
        expect(firstAnswer?.notes).toContain(OFFLINE_TAG);
    });

    it('falls back on 429 as well — a rate limit is not a refusal', async () => {
        const { impl } = stubFetch(() => jsonResponse(429, { error: 'nl-rate-limited' }));
        const s = setup();
        const result = await runUtterance('defend Northgate', { ...s.deps, proxy: proxyDeps(impl) });

        expect(result.source).toBe('offline-parser');
        expect(result.fallbackReason).toBe('HTTP 429');
        expect(result.report.sent.length).toBeGreaterThan(0);
    });

    it('falls back when the socket dies', async () => {
        const impl = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
        const s = setup();
        const result = await runUtterance('defend Northgate', { ...s.deps, proxy: proxyDeps(impl) });

        expect(result.source).toBe('offline-parser');
        expect(result.fallbackReason).toBe('Failed to fetch');
    });

    it('falls back when the proxy hangs past the client deadline', async () => {
        // Never resolves until aborted — the abort is what has to rescue this,
        // and without it the console would simply freeze mid-sentence.
        const impl = ((_url: unknown, init: { signal?: AbortSignal }) => new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')));
        })) as unknown as typeof fetch;
        const s = setup();

        const result = await runUtterance('defend Northgate', {
            ...s.deps,
            proxy: proxyDeps(impl, { timeoutMs: 10 }),
        });

        expect(result.source).toBe('offline-parser');
        expect(result.fallbackReason).toBe('timeout');
        expect(result.report.sent.length).toBeGreaterThan(0);
    });

    it('runs local-only when there is no proxy configured at all', async () => {
        const s = setup();
        const result = await runUtterance('defend Northgate', s.deps);
        expect(result.source).toBe('offline-parser');
        // No tag: there is no proxy to have fallen back FROM, and labelling
        // the ordinary M0–M3 path "offline" would be noise.
        expect(s.lines[0]?.notes ?? []).not.toContain(OFFLINE_TAG);
    });
});

// ──────────────────────────── the happy path ──────────────────────────────

describe('a valid proxy envelope executes', () => {
    it('sends the order the proxy asked for, with no offline tag', async () => {
        const envelope = {
            actions: [{
                kind: 'command',
                intent: { verb: 'defend', subject: { type: 'any' }, target: { type: 'entity-ref', name: 'Northgate' } },
            }],
            say: 'Defending Northgate.',
        };
        const { impl } = stubFetch(() => jsonResponse(200, envelope));
        const s = setup();

        const result = await runUtterance('hold the line at northgate whatever it takes', {
            ...s.deps,
            proxy: proxyDeps(impl),
        });

        expect(result.source).toBe('proxy');
        expect(result.report.sent.length).toBe(1);
        expect(s.lines.every((l) => !(l.notes ?? []).includes(OFFLINE_TAG))).toBe(true);
    });

    it('posts to /api/nl/command with the session token and the context', async () => {
        const { impl, calls } = stubFetch(() =>
            jsonResponse(200, { actions: [{ kind: 'query', query: { op: 'resources' } }] }));
        const s = setup();

        await runUtterance('how are we doing', {
            ...s.deps,
            proxy: proxyDeps(impl, { history: ['earlier', 'answer'] }),
        });

        expect(calls[0].url).toBe('http://localhost:8011/api/nl/command');
        expect(calls[0].init.method).toBe('POST');
        const headers = calls[0].init.headers as Record<string, string>;
        // POST, because a GET in this codebase never receives headers and so
        // could not carry this at all (NetworkServer.h).
        expect(headers.authorization).toBe('Bearer test-token');

        const body = JSON.parse(String(calls[0].init.body));
        expect(body.utterance).toBe('how are we doing');
        expect(body.context.places[0].n).toBe('Northgate');
        expect(body.history).toEqual(['earlier', 'answer']);
    });

    it('omits history entirely when there is none', async () => {
        const { impl, calls } = stubFetch(() =>
            jsonResponse(200, { actions: [{ kind: 'query', query: { op: 'resources' } }] }));
        const s = setup();
        await runUtterance('how are we doing', { ...s.deps, proxy: proxyDeps(impl) });

        expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('history');
    });
});

// ─────────────────────── the proxy is still untrusted ─────────────────────

describe('the proxy output is validated at the client', () => {
    // §3: "the client validator remains the second gate". The server asked for
    // structured output against the same schema — this is what happens when
    // that guarantee does not hold, and it must not be "execute it anyway".
    it('refuses an envelope the contract rejects instead of executing it', async () => {
        const { impl } = stubFetch(() => jsonResponse(200, {
            actions: [{ kind: 'command', intent: { verb: 'teleport', subject: { type: 'any' } } }],
        }));
        const s = setup();

        const result = await runUtterance('teleport everyone home', {
            ...s.deps,
            proxy: proxyDeps(impl),
        });

        expect(result.source).toBe('proxy');
        expect(result.validation.ok).toBe(false);
        expect(result.report.sent).toHaveLength(0);
        expect(s.lines.some((l) => l.kind === 'refused')).toBe(true);
    });

    it('does not silently retry through the local parser on a bad envelope', async () => {
        // The tempting bug: treat "invalid" as "unavailable" and re-run
        // locally. It would look fine in a demo and hide a broken contract
        // forever — and worse, it would move an army the model never asked to.
        const { impl } = stubFetch(() => jsonResponse(200, { actions: [] }));
        const s = setup();

        const result = await runUtterance('defend Northgate', { ...s.deps, proxy: proxyDeps(impl) });

        expect(result.source).toBe('proxy');
        expect(result.report.sent).toHaveLength(0);
        expect(s.lines.every((l) => !(l.notes ?? []).includes(OFFLINE_TAG))).toBe(true);
    });

    it('rejects a name the envelope invented but the world does not have', async () => {
        // The prompt's first rule, enforced client-side rather than trusted:
        // an entity-ref that resolves to nothing must refuse, not guess.
        const { impl } = stubFetch(() => jsonResponse(200, {
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'defend',
                    subject: { type: 'any' },
                    target: { type: 'entity-ref', name: 'Atlantis' },
                },
            }],
        }));
        const s = setup();

        const result = await runUtterance('defend atlantis', { ...s.deps, proxy: proxyDeps(impl) });

        expect(result.source).toBe('proxy');
        expect(result.report.sent).toHaveLength(0);
        expect(s.lines.some((l) => l.kind === 'refused')).toBe(true);
    });
});
