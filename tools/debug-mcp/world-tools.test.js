import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIo } from './tool-io-fake.js';
import {
    WORLD_TOOLS, worldHandlers, worldUrl, explainWorldError,
    summariseClock, summarisePois, WORLD_ERROR_HELP,
} from './world-tools.js';

const WORLD = {
    worldId: 'primary', name: 'Meridian', state: 'active', poiCount: 12,
    clock: { label: 'Day 12, 07:31', paused: false, worldMs: 1000 },
    season: { number: 3, remainingWorldMs: 7200000 },
};
const POIS = {
    worldId: 'primary',
    pois: [
        { id: 'basin_a', name: 'Basin A', kind: 'town', owner: 1, battleStatus: 'quiet', staging: [] },
        { id: 'north_gate', name: 'North Gate', kind: 'fort', owner: null, battleStatus: 'staging',
          staging: [{ stagingId: 4, poiId: 'north_gate', attackerFaction: 2, transports: 1, squads: 2, remainingWorldMs: 5000 }] },
        { id: 'delta', name: 'Delta', kind: 'town', owner: 2, battleStatus: 'active', warRoomId: 7, staging: [] },
    ],
    edges: [{ from: 'basin_a', to: 'north_gate' }, { from: 'delta', to: 'basin_a' }],
};

test('worldUrl threads ?world= onto GET and POST alike, and never double-slashes', () => {
    assert.equal(worldUrl('http://l:1/', '/api/world', undefined), 'http://l:1/api/world');
    assert.equal(worldUrl('http://l:1', '/api/world/pause', 'alt'), 'http://l:1/api/world/pause?world=alt');
    assert.equal(worldUrl('http://l:1', '/api/world', 'a b'), 'http://l:1/api/world?world=a%20b');
});

test('world_status: clock by default, summarised, with the world selector forwarded', async () => {
    const { io, calls } = fakeIo({ 'GET /api/world': { body: WORLD } });
    const out = await worldHandlers.world_status({ world: 'primary' }, io);
    assert.match(out.summary, /world primary \(Meridian\) state=active/);
    assert.match(out.summary, /clock Day 12, 07:31/);
    assert.match(out.summary, /season 3/);
    assert.equal(out.world.worldId, 'primary');
    assert.equal(calls[0].query.world, 'primary');
    assert.equal(calls.length, 1, 'detail:"clock" must not fetch pois/stats/factions');
});

test('world_status detail:"all" fetches all four, and stats is flagged as a settling write in the schema', async () => {
    const { io, calls } = fakeIo({
        'GET /api/world': { body: WORLD },
        'GET /api/world/pois': { body: POIS },
        'GET /api/world/stats': { body: { worldId: 'primary', commanders: [] } },
        'GET /api/world/factions': { body: { worldId: 'primary', factions: [] } },
    });
    const out = await worldHandlers.world_status({ detail: 'all' }, io);
    assert.equal(calls.length, 4);
    assert.ok(out.world && out.pois && out.stats && out.factions);
    assert.match(out.poiSummary, /3 POIs · 2 owned · 1 staging \/ 1 at war/);
    const tool = WORLD_TOOLS.find((t) => t.name === 'world_status');
    assert.match(tool.description, /settles commander authority accrual/i);
});

test('a world error is explained by code, carrying have/need rather than swallowing them', async () => {
    const { io } = fakeIo({ 'GET /api/world': { status: 404, body: { ok: false, error: 'no_world' } } });
    const out = await worldHandlers.world_status({ world: 'ghost' }, io);
    assert.match(out, /^Error: GET \/api\/world 404 no_world/);
    assert.match(out, /does not exist/);

    const msg = explainWorldError('POST /api/world/claims/file', {
        status: 403, body: { ok: false, error: 'insufficient_authority', have: 10, need: 25 },
    });
    assert.match(msg, /403 insufficient_authority \(have=10, need=25\)/);
    assert.match(msg, /not enough world authority/);
});

test('an unknown error code still reports the body instead of an empty sentence', () => {
    const msg = explainWorldError('GET /api/world', { status: 500, body: { boom: 1 } });
    assert.match(msg, /500 — \{"boom":1\}/);
});

test('every staging refusal the 2026-09-16 build added is explained', () => {
    for (const code of ['window_closed', 'no_side', 'same_side', 'too_much_force'])
        assert.ok(WORLD_ERROR_HELP[code], `${code} needs a help line`);
});

test('world_pois filters by poi/kind/battleStatus and keeps only the touching edges', async () => {
    const { io } = fakeIo({ 'GET /api/world/pois': { body: POIS } });
    const one = await worldHandlers.world_pois({ poi: 'north_gate' }, io);
    assert.equal(one.pois.length, 1);
    assert.deepEqual(one.edges, [{ from: 'basin_a', to: 'north_gate' }]);
    assert.equal((await worldHandlers.world_pois({ kind: 'town' }, io)).pois.length, 2);
    assert.equal((await worldHandlers.world_pois({ battleStatus: 'active' }, io)).pois.length, 1);
});

test('world_pois names an unknown POI rather than answering an empty list', async () => {
    const { io } = fakeIo({ 'GET /api/world/pois': { body: POIS } });
    const out = await worldHandlers.world_pois({ poi: 'nowhere' }, io);
    assert.match(out, /no POI "nowhere"/);
});

test('summarisers survive a young world (null season, empty arrays)', () => {
    assert.match(summariseClock({ worldId: 'w', name: 'n', state: 'active', clock: { paused: true }, season: null }), /PAUSED · no season yet · 0 POIs/);
    assert.equal(summarisePois({}), '0 POIs · 0 owned · 0 staging / 0 at war · 0 open commitments · 0 edges');
    assert.match(summariseClock(undefined), /world \? \(\?\)/);
});

test('world_commit posts the counts, bearer-authed, and explains the escrow it just opened', async () => {
    const { io, calls } = fakeIo({
        'POST /api/world/staging/commit': { body: { ok: true, joined: false, staging: { stagingId: 9, remainingWorldMs: 60000 } } },
    });
    const out = await worldHandlers.world_commit({ poi: 'north_gate', squads: 3, origin: 'basin_a' }, io);
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent, { poi: 'north_gate', transports: 1, squads: 3, origin: 'basin_a' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN-abc');
    assert.match(out.summary, /opened a staging window at north_gate with 1 transport\(s\) \/ 3 squad\(s\)/);
    assert.match(out.summary, /world_commit_cancel\(\{stagingId:9\}\)/);
});

test('world_commit refuses non-positive counts locally instead of shipping a NaN', async () => {
    const { io, calls } = fakeIo({});
    assert.match(await worldHandlers.world_commit({ poi: 'p', squads: 0 }, io), /`squads` must be a positive integer/);
    assert.match(await worldHandlers.world_commit({ poi: 'p', transports: 1.5 }, io), /`transports` must be a positive integer/);
    assert.equal(calls.length, 0);
});

test('world_commit: window_closed is explained as "re-read and join the war"', async () => {
    const { io } = fakeIo({ 'POST /api/world/staging/commit': { status: 409, body: { ok: false, error: 'window_closed' } } });
    const out = await worldHandlers.world_commit({ poi: 'north_gate' }, io);
    assert.match(out, /409 window_closed/);
    assert.match(out, /re-read world_pois/);
});

test('world_commit_cancel: cancelled:false is reported as a closed window, not as success', async () => {
    const { io } = fakeIo({ 'POST /api/world/staging/cancel': { body: { ok: true, cancelled: false } } });
    const out = await worldHandlers.world_commit_cancel({ stagingId: 4 }, io);
    assert.match(out.summary, /was NOT cancelled/);
    const { io: io2 } = fakeIo({ 'POST /api/world/staging/cancel': { body: { ok: true, cancelled: true } } });
    assert.match((await worldHandlers.world_commit_cancel({ stagingId: 4 }, io2)).summary, /escrow refunded/);
    assert.match(await worldHandlers.world_commit_cancel({}, io2), /needs a numeric `stagingId`/);
});

test('world_factions: list is public, the acts are authed and send the documented bodies', async () => {
    const seen = [];
    const record = (name) => ({ url, init }) => { seen.push([name, init.body, init.headers?.Authorization]); return { body: { ok: true } }; };
    const { io } = fakeIo({
        'GET /api/world/factions': { body: { factions: [], archetypes: [] } },
        'POST /api/world/me': record('me'),
        'POST /api/world/factions/found': record('found'),
        'POST /api/world/factions/join': record('join'),
        'POST /api/world/factions/leave': record('leave'),
    });
    await worldHandlers.world_factions({}, io);
    await worldHandlers.world_factions({ action: 'me' }, io);
    await worldHandlers.world_factions({ action: 'found', name: 'Compact', archetype: 'industrial', seatPoi: 'basin_a' }, io);
    await worldHandlers.world_factions({ action: 'join', factionId: 2 }, io);
    await worldHandlers.world_factions({ action: 'leave' }, io);
    assert.deepEqual(JSON.parse(seen.find((s) => s[0] === 'found')[1]), { name: 'Compact', archetype: 'industrial', seatPoi: 'basin_a' });
    assert.deepEqual(JSON.parse(seen.find((s) => s[0] === 'join')[1]), { factionId: 2 });
    for (const s of seen) assert.equal(s[2], 'Bearer TOKEN-abc', `${s[0]} must be authed`);
});

test('world_factions refuses incomplete acts before the round trip', async () => {
    const { io, calls } = fakeIo({});
    assert.match(await worldHandlers.world_factions({ action: 'found', name: 'x' }, io), /needs `name` and `archetype`/);
    assert.match(await worldHandlers.world_factions({ action: 'join' }, io), /needs a numeric `factionId`/);
    assert.match(await worldHandlers.world_factions({ action: 'nope' }, io), /action must be one of/);
    assert.equal(calls.length, 0);
});

test('world_factions join: side_mismatch reports both side keys', async () => {
    const { io } = fakeIo({
        'POST /api/world/factions/join': { status: 409, body: { ok: false, error: 'side_mismatch', accountSideKey: 'compact', factionSideKey: 'reavers' } },
    });
    const out = await worldHandlers.world_factions({ action: 'join', factionId: 2 }, io);
    assert.match(out, /accountSideKey="compact", factionSideKey="reavers"/);
});

test('world_claims: list filters by state; file/withdraw send the documented bodies', async () => {
    const claims = { worldId: 'primary', rules: { claimPoiCost: 25 }, claims: [{ claimId: 1, state: 'open' }, { claimId: 2, state: 'won' }] };
    const { io, calls } = fakeIo({
        'GET /api/world/claims': { body: claims },
        'POST /api/world/claims/file': { body: { ok: true, claim: { claimId: 3 } } },
        'POST /api/world/claims/withdraw': { body: { ok: true, withdrawn: true } },
    });
    assert.equal((await worldHandlers.world_claims({ state: 'open' }, io)).claims.length, 1);
    await worldHandlers.world_claims({ action: 'file', poi: 'delta' }, io);
    await worldHandlers.world_claims({ action: 'withdraw', claimId: 3 }, io);
    assert.deepEqual(JSON.parse(calls[1].init.body), { poi: 'delta' });
    assert.deepEqual(JSON.parse(calls[2].init.body), { claimId: 3 });
    assert.match(await worldHandlers.world_claims({ action: 'file' }, io), /needs `poi`/);
});

test('claims/file insufficient_authority is a 403 now, and reads as one', async () => {
    const { io } = fakeIo({ 'POST /api/world/claims/file': { status: 403, body: { ok: false, error: 'insufficient_authority', have: 4, need: 25 } } });
    const out = await worldHandlers.world_claims({ action: 'file', poi: 'delta' }, io);
    assert.match(out, /403 insufficient_authority \(have=4, need=25\)/);
});

test('world_seasons: no number is the index; a number is one season; a float is refused locally', async () => {
    const { io, calls } = fakeIo({
        'GET /api/world/seasons': { body: { seasons: [] } },
        'GET /api/world/seasons/2': { body: { season: { number: 2 }, digests: [] } },
    });
    await worldHandlers.world_seasons({}, io);
    assert.equal((await worldHandlers.world_seasons({ number: 2 }, io)).season.number, 2);
    assert.match(await worldHandlers.world_seasons({ number: 1.5 }, io), /must be a non-negative integer/);
    assert.match(await worldHandlers.world_seasons({ number: -1 }, io), /must be a non-negative integer/);
    assert.equal(calls.length, 2, 'the refused numbers must not reach the route');
});

test('world_pause: changed:false reads as a no-op, and battles are called out as unaffected', async () => {
    const { io, calls } = fakeIo({ 'POST /api/world/pause': { body: { ok: true, changed: true, clock: {} } } });
    const out = await worldHandlers.world_pause({ reason: 'maintenance' }, io);
    assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'pause', reason: 'maintenance' });
    assert.match(out.summary, /running battles are UNAFFECTED/);
    const { io: io2 } = fakeIo({ 'POST /api/world/pause': { body: { ok: true, changed: false } } });
    assert.match((await worldHandlers.world_pause({ action: 'resume' }, io2)).summary, /already running — no change/);
    assert.match(await worldHandlers.world_pause({ action: 'stop' }, io), /must be "pause" or "resume"/);
});

// --- notifications ---------------------------------------------------------

const TICKET_OK = { 'POST /api/chat/ticket': { body: { ticket: 'TICKET-xyz', ttl: 60, stream: '/api/chat/stream' } } };

test('world_notifications: trades the token for a ticket, keeps only world events, and NEVER echoes the ticket', async () => {
    const { io, calls } = fakeIo({
        ...TICKET_OK,
        'GET /api/chat/stream': {
            stream: [
                'event: world-staging\ndata: {"kind":"opened","poi":"north_gate"}\n\n',
                'event: chat\ndata: {"text":"hi"}\n\n',
                'event: world-poi\ndata: {"kind":"ownership","poi":"delta"}\n\n',
            ],
        },
    });
    const out = await worldHandlers.world_notifications({ listenMs: 200 }, io);
    assert.equal(out.events.length, 2);
    assert.deepEqual(out.events.map((e) => e.event), ['world-staging', 'world-poi']);
    assert.equal(out.events[0].data.poi, 'north_gate');
    assert.equal(out.other, undefined);
    const stream = calls.find((c) => c.key === 'GET /api/chat/stream');
    assert.equal(stream.query.ticket, 'TICKET-xyz', 'the ticket rides the URL');
    assert.ok(!JSON.stringify(out).includes('TICKET-xyz'), 'the ticket is a credential and must not be echoed back');
});

test('world_notifications: includeOther returns the chat traffic too', async () => {
    const { io } = fakeIo({
        ...TICKET_OK,
        'GET /api/chat/stream': { stream: ['event: chat\ndata: {"text":"hi"}\n\n'] },
    });
    const out = await worldHandlers.world_notifications({ listenMs: 200, includeOther: true }, io);
    assert.equal(out.events.length, 0);
    assert.equal(out.other.length, 1);
    assert.match(out.summary, /no world events in 200ms/);
    assert.match(out.summary, /late commit joining an OPEN window fires nothing/);
});

test('world_notifications: listenMs is clamped, and a listen carries its OWN deadline (not the 15s default)', async () => {
    const { io, calls } = fakeIo({ ...TICKET_OK, 'GET /api/chat/stream': { stream: [] } });
    const out = await worldHandlers.world_notifications({ listenMs: 999999 }, io);
    assert.equal(out.listenMs, 120000);
    const stream = calls.find((c) => c.key === 'GET /api/chat/stream');
    assert.ok(stream.init.signal, 'the stream fetch must bring its own AbortSignal');
    assert.equal((await worldHandlers.world_notifications({ listenMs: 1 }, io)).listenMs, 100);
});

test('world_notifications: no ticket means no listen, and says so', async () => {
    const { io } = fakeIo({ 'POST /api/chat/ticket': { status: 401, body: { error: 'unauthorized' } } });
    assert.match(await worldHandlers.world_notifications({}, io), /POST \/api\/chat\/ticket 401/);
    const { io: io2 } = fakeIo({ 'POST /api/chat/ticket': { body: { ttl: 60 } } });
    assert.match(await worldHandlers.world_notifications({}, io2), /answered without a ticket/);
});

test('every WORLD_TOOL has a handler, and every handler has a schema', () => {
    for (const t of WORLD_TOOLS) assert.ok(worldHandlers[t.name], `${t.name} has no handler`);
    for (const name of Object.keys(worldHandlers))
        assert.ok(WORLD_TOOLS.some((t) => t.name === name), `${name} has no schema`);
});
