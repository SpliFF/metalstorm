/**
 * chat.test.ts — the client half of task 9b (PLAN-lobby.md §3).
 *
 * Every case here is a rule the SERVER already enforces and the client can
 * silently undo: the target you POST is not the target you receive, an ally
 * target is derived and never chosen, a room tab dies with the room, and a
 * dead ticket is indistinguishable from a dropped connection.
 */

import { describe, it, expect } from 'vitest';
import {
    ChatModel, CHAT_STREAM_MAX_ATTEMPTS, CHAT_TAB_LIMIT, CHAT_TICKET_TTL_SEC,
    actionBody, chatTime, isActionLine, mergeMessages, normalizeChannel,
    hasMention, linkSegments, moderationActive, moderationNoticeText, muteRowLine,
    parseChatDuration, parseChatInput, pmOther, pmTarget, roomTabSpecs, shouldNotify,
    sortTabs, streamRecovery, tabKey, type ChatFrame, type ChatTab,
} from './chat.js';

function frame(over: Partial<ChatFrame> = {}): ChatFrame {
    return {
        id: 1, scope: 'main', target: 'main', from: 'bob', fromId: 7,
        text: 'hi', ts: 1_700_000_000, ...over,
    };
}

describe('canonical targets', () => {
    it('names one PM conversation from both ends', () => {
        expect(pmTarget(4, 9)).toBe('4:9');
        expect(pmTarget(9, 4)).toBe('4:9');
    });

    it('reads the other party out of a PM target, and refuses one that is not mine', () => {
        expect(pmOther('4:9', 4)).toBe(9);
        expect(pmOther('4:9', 9)).toBe(4);
        // A frame for a conversation this account is not in has no "other
        // party", and guessing one would open a tab addressed to a stranger.
        expect(pmOther('4:9', 5)).toBe(0);
        expect(pmOther('main', 4)).toBe(0);
    });

    it('mirrors NormalizeChannel, including what it refuses', () => {
        expect(normalizeChannel('#Help')).toBe('help');
        expect(normalizeChannel('  dev  ')).toBe('dev');
        expect(normalizeChannel('has space')).toBe('');
        expect(normalizeChannel('')).toBe('');
        expect(normalizeChannel('x'.repeat(25))).toBe('');
        expect(normalizeChannel('x'.repeat(24))).toBe('x'.repeat(24));
    });

    it('derives the three room-shaped targets and never invents the ally team', () => {
        const player = roomTabSpecs({ roomId: 12, team: 1, isSpectator: false }, 'Raven Basin');
        expect(player.map(s => [s.scope, s.target, s.sendTarget])).toEqual([
            ['room', '12', '12'],
            ['ally', '12/ally/1', '12'],
        ]);
        // The room id is what goes back on the wire for all three: the server
        // appends the team it reads off the roster (resolveChatScope), so a
        // client that posted `12/ally/1` would be posting a target the route
        // cannot parse.
        const spec = roomTabSpecs({ roomId: 12, team: 3, isSpectator: true }, 'Raven Basin');
        expect(spec.map(s => s.scope)).toEqual(['room', 'spectator']);
        expect(spec[1].target).toBe('12/spec');
        // A spectator gets no ally tab: the server answers 403 for one, so a
        // tab there is a control whose only reply is a refusal.
        expect(spec.some(s => s.scope === 'ally')).toBe(false);
    });
});

describe('a PM tab is keyed by the target and addressed by the name', () => {
    it('routes the server\'s echo of a PM back into the tab that sent it', () => {
        const m = new ChatModel(4);
        const tab = m.ensurePmTab(9, 'kez');
        // What the routes want back, and what frames carry: different strings.
        expect(tab.sendTarget).toBe('kez');
        expect(tab.target).toBe('4:9');

        const landed = m.applyFrame(frame({ id: 5, scope: 'pm', target: '4:9',
                                            from: 'kez', fromId: 9, text: 'yo' }));
        expect(landed?.key).toBe(tab.key);
        // The defect this pins: keyed on the username, the reply opens a
        // SECOND tab and the conversation splits in half.
        expect(m.list().filter(t => t.scope === 'pm')).toHaveLength(1);
    });

    it('opens a tab for a PM from someone the client never addressed', () => {
        const m = new ChatModel(4);
        const t = m.applyFrame(frame({ id: 2, scope: 'pm', target: '4:9',
                                       from: 'kez', fromId: 9 }));
        expect(t?.label).toBe('kez');
        expect(t?.sendTarget).toBe('kez');
        expect(t?.closable).toBe(true);
    });

    it('drops a PM frame for a conversation this account is not part of', () => {
        const m = new ChatModel(4);
        expect(m.applyFrame(frame({ scope: 'pm', target: '7:9', fromId: 9 }))).toBeNull();
    });

    it('drops a room frame with no tab, because that means the client left', () => {
        const m = new ChatModel(4);
        expect(m.applyFrame(frame({ scope: 'room', target: '12' }))).toBeNull();
    });
});

describe('room tabs follow the room', () => {
    it('stages the seat\'s tabs and takes them away on leave', () => {
        const m = new ChatModel(4);
        expect(m.syncRoomTabs({ roomId: 12, team: 0, isSpectator: false }, 'Raven')).toBe(true);
        expect(m.list().map(t => t.key)).toEqual([
            'main:main', 'room:12', 'ally:12/ally/0',
        ]);
        // Idempotent: a re-render must not rebuild tabs (and wipe their lines).
        expect(m.syncRoomTabs({ roomId: 12, team: 0, isSpectator: false }, 'Raven')).toBe(false);

        m.setActive('room:12');
        expect(m.syncRoomTabs(null)).toBe(true);
        expect(m.list().map(t => t.key)).toEqual(['main:main']);
        // The active tab was just deleted; the panel must land somewhere.
        expect(m.activeKey).toBe('main:main');
    });

    it('swaps the ally tab when the seat changes team', () => {
        const m = new ChatModel(4);
        m.syncRoomTabs({ roomId: 12, team: 0, isSpectator: false }, 'Raven');
        m.syncRoomTabs({ roomId: 12, team: 1, isSpectator: false }, 'Raven');
        expect(m.list().map(t => t.key)).toEqual([
            'main:main', 'room:12', 'ally:12/ally/1',
        ]);
    });

    it('swaps ally for spectator when the seat does', () => {
        const m = new ChatModel(4);
        m.syncRoomTabs({ roomId: 12, team: 1, isSpectator: false }, 'Raven');
        m.syncRoomTabs({ roomId: 12, team: 1, isSpectator: true }, 'Raven');
        expect(m.list().map(t => t.scope)).toEqual(['main', 'room', 'spectator']);
    });

    it('refuses to close #main or a room tab', () => {
        const m = new ChatModel(4);
        m.syncRoomTabs({ roomId: 12, team: 0, isSpectator: false }, 'Raven');
        expect(m.close('main:main')).toBe(false);
        expect(m.close('room:12')).toBe(false);
        m.ensurePmTab(9, 'kez');
        expect(m.close('pm:4:9')).toBe(true);
    });
});

describe('unread', () => {
    it('counts other people\'s lines in tabs nobody is reading', () => {
        const m = new ChatModel(4);
        m.ensurePmTab(9, 'kez');
        m.applyFrame(frame({ id: 1, scope: 'pm', target: '4:9', fromId: 9 }));
        m.applyFrame(frame({ id: 2, scope: 'pm', target: '4:9', fromId: 9 }));
        expect(m.totalUnread()).toBe(2);
        m.setActive('pm:4:9');
        expect(m.totalUnread()).toBe(0);
    });

    it('never counts my own line, in any tab', () => {
        const m = new ChatModel(4);
        m.ensurePmTab(9, 'kez');
        // Echoed back from another device: it is in a tab I am not reading,
        // and it is still not news to me.
        m.applyFrame(frame({ id: 3, scope: 'pm', target: '4:9', fromId: 4 }));
        expect(m.totalUnread()).toBe(0);
    });

    it('never counts the backfill', () => {
        const m = new ChatModel(4);
        m.ensurePmTab(9, 'kez');
        m.applyHistory('pm:4:9', [
            { id: 2, from: 'kez', fromId: 9, text: 'b', ts: 2 },
            { id: 1, from: 'kez', fromId: 9, text: 'a', ts: 1 },
        ]);
        expect(m.totalUnread()).toBe(0);
        expect(m.get('pm:4:9')!.loaded).toBe(true);
    });
});

describe('history and the live stream overlap', () => {
    it('dedupes on id and orders ascending', () => {
        const m = new ChatModel(4);
        // The line said between "stream opened" and "history answered"
        // arrives twice — this is the ordinary case, not an edge case.
        m.applyFrame(frame({ id: 7, text: 'live' }));
        m.applyHistory('main:main', [
            { id: 7, from: 'bob', fromId: 7, text: 'live', ts: 3 },
            { id: 6, from: 'bob', fromId: 7, text: 'older', ts: 2 },
        ]);
        expect(m.get('main:main')!.messages.map(x => x.id)).toEqual([6, 7]);
    });

    it('stamps history rows with the tab\'s own scope and target', () => {
        const m = new ChatModel(4);
        m.syncRoomTabs({ roomId: 12, team: 0, isSpectator: false }, 'Raven');
        m.applyHistory('ally:12/ally/0', [{ id: 1, from: 'a', fromId: 2, text: 'x', ts: 1 }]);
        const msg = m.get('ally:12/ally/0')!.messages[0];
        // The reply names them once for the page; a row that kept the default
        // would be filed under `main`.
        expect([msg.scope, msg.target]).toEqual(['ally', '12/ally/0']);
    });

    it('keeps a system line marked', () => {
        const m = new ChatModel(4);
        m.applyHistory('main:main', [{ id: 1, from: '', fromId: 0, text: 'x', ts: 1, system: true }]);
        expect(m.get('main:main')!.messages[0].system).toBe(true);
    });

    it('caps a tab at the render budget, keeping the newest', () => {
        const many = Array.from({ length: CHAT_TAB_LIMIT + 20 },
                                (_, i) => frame({ id: i + 1 }));
        const out = mergeMessages([], many);
        expect(out).toHaveLength(CHAT_TAB_LIMIT);
        expect(out[out.length - 1].id).toBe(CHAT_TAB_LIMIT + 20);
    });
});

describe('the composer', () => {
    const main: ChatTab = {
        key: 'main:main', scope: 'main', target: 'main', sendTarget: 'main',
        label: '#main', closable: false, messages: [], unread: 0, loaded: true,
    };

    it('sends plain text to the active tab\'s SEND target', () => {
        const room: ChatTab = { ...main, key: 'ally:12/ally/1', scope: 'ally',
                                target: '12/ally/1', sendTarget: '12', label: 'Allies' };
        expect(parseChatInput('push left', room)).toEqual({
            kind: 'send', scope: 'ally', target: '12', text: 'push left',
        });
    });

    it('turns /w into a PM and keeps the rest of the line intact', () => {
        expect(parseChatInput('/w kez see you at the ford', main)).toEqual({
            kind: 'pm', username: 'kez', text: 'see you at the ford',
        });
    });

    it('refuses an unknown command instead of saying it out loud', () => {
        // The defect: a mistyped `/w` that falls through to `send` publishes
        // the message — and the name it was addressed to — to the channel.
        const r = parseChatInput('/whisper kez the plan', main);
        expect(r.kind).toBe('error');
    });

    it('keeps the /me marker in the text, because the wire has no flag for it', () => {
        expect(parseChatInput('/me waves', main)).toEqual({
            kind: 'send', scope: 'main', target: 'main', text: '/me waves',
        });
        expect(isActionLine('/me waves')).toBe(true);
        expect(actionBody('/me waves')).toBe('waves');
        expect(isActionLine('/me ')).toBe(false);
        expect(isActionLine('normal line')).toBe(false);
    });

    it('maps ignore, unignore, join and leave onto their routes', () => {
        expect(parseChatInput('/ignore bob', main)).toEqual(
            { kind: 'ignore', username: 'bob', on: true });
        expect(parseChatInput('/unignore bob', main)).toEqual(
            { kind: 'ignore', username: 'bob', on: false });
        expect(parseChatInput('/join #help', main)).toEqual(
            { kind: 'channel', channel: 'help', join: true });
        expect(parseChatInput('/leave help', main)).toEqual(
            { kind: 'channel', channel: 'help', join: false });
        expect(parseChatInput('/join #not a channel', main).kind).toBe('error');
    });

    it('says nothing on an empty line and refuses text with no tab', () => {
        expect(parseChatInput('   ', main)).toEqual({ kind: 'none' });
        expect(parseChatInput('hello', null).kind).toBe('error');
    });
});

describe('tab order', () => {
    const t = (over: Partial<ChatTab>): ChatTab => ({
        key: 'k', scope: 'main', target: 'x', sendTarget: 'x', label: 'l',
        closable: true, messages: [], unread: 0, loaded: false, ...over,
    });

    it('puts #main first, the room next, channels then PMs', () => {
        const order = sortTabs([
            t({ scope: 'pm', label: 'kez' }),
            t({ scope: 'channel', label: '#help' }),
            t({ scope: 'ally', label: 'Allies' }),
            t({ scope: 'main', label: '#main' }),
            t({ scope: 'room', label: 'Raven' }),
        ]).map(x => x.scope);
        expect(order).toEqual(['main', 'room', 'ally', 'channel', 'pm']);
    });

    it('orders PMs by who spoke last, not by name', () => {
        const order = sortTabs([
            t({ scope: 'pm', label: 'aaa', messages: [frame({ ts: 10 })] }),
            t({ scope: 'pm', label: 'zzz', messages: [frame({ ts: 99 })] }),
        ]).map(x => x.label);
        expect(order).toEqual(['zzz', 'aaa']);
    });
});

describe('the stream recovery policy', () => {
    it('lets the browser have one free retry on a live ticket', () => {
        // `onerror` carries no status, so a blip and an expired credential
        // look identical — the first one is assumed to be a blip.
        expect(streamRecovery(1, 10)).toEqual({ action: 'wait', delayMs: 0, notice: '' });
    });

    it('re-mints immediately when the ticket is past its TTL, however few the errors', () => {
        // The credential case: the browser retries the SAME url, so a dead
        // ticket loops forever with the page none the wiser.
        const r = streamRecovery(1, CHAT_TICKET_TTL_SEC);
        expect(r.action).toBe('remint');
        expect(r.delayMs).toBe(1000);
    });

    it('backs off exponentially and caps', () => {
        expect(streamRecovery(2, 0).delayMs).toBe(2000);
        expect(streamRecovery(3, 0).delayMs).toBe(4000);
        expect(streamRecovery(5, 0).delayMs).toBe(16000);
        expect(streamRecovery(CHAT_STREAM_MAX_ATTEMPTS - 1, 0).delayMs)
            .toBeLessThanOrEqual(30000);
    });

    it('stops and says so rather than retrying for the rest of the session', () => {
        const r = streamRecovery(CHAT_STREAM_MAX_ATTEMPTS, 0);
        expect(r.action).toBe('stop');
        expect(r.notice).toMatch(/disconnected/i);
    });

    it('is silent on the first blip and speaks once it is retrying', () => {
        expect(streamRecovery(1, 0).notice).toBe('');
        expect(streamRecovery(2, 0).notice).toMatch(/reconnect/i);
    });
});

describe('small things the panel renders', () => {
    it('formats a stamp as HH:MM', () => {
        expect(chatTime(1_700_000_000)).toMatch(/^\d{2}:\d{2}$/);
    });

    it('keys a tab by scope and target together', () => {
        // Two scopes can carry the same target string (`12` is a room id and
        // could be a channel name), so the key is both.
        expect(tabKey('room', '12')).not.toBe(tabKey('channel', '12'));
    });
});

// ── task 9d: the moderation surface and §3.5's quality-of-life list ────────

/// A tab, in the shape `parseChatInput` reads (scope + sendTarget only).
function tab(over: Partial<ChatTab> = {}): ChatTab {
    return {
        key: 'channel:help', scope: 'channel', target: 'help', sendTarget: 'help',
        label: '#help', closable: true, messages: [], unread: 0, loaded: false,
        ...over,
    };
}

describe('durations', () => {
    it('reads every unit the composer accepts', () => {
        expect(parseChatDuration('30')).toBe(30);
        expect(parseChatDuration('30s')).toBe(30);
        expect(parseChatDuration('5m')).toBe(300);
        expect(parseChatDuration('2h')).toBe(7200);
        expect(parseChatDuration('1d')).toBe(86400);
    });

    it('reads "until lifted" as the service spells it — 0, not absent', () => {
        // `until = 0` IS a mute (the row is the mute); the absence of a row is
        // the only "not muted". A client that sent nothing here would ask for
        // a mute and get the same thing by accident rather than on purpose.
        expect(parseChatDuration('perm')).toBe(0);
        expect(parseChatDuration('forever')).toBe(0);
    });

    it('says "not a duration" rather than guessing, so a reason can be first', () => {
        expect(parseChatDuration('spamming')).toBe(-1);
        expect(parseChatDuration('')).toBe(-1);
        expect(parseChatDuration('5x')).toBe(-1);
        expect(parseChatDuration('5 m')).toBe(-1);
    });
});

describe('moderation commands', () => {
    it('scopes /mute to the conversation the moderator is standing in', () => {
        const c = parseChatInput('/mute bob 5m flooding', tab());
        expect(c).toEqual({ kind: 'mute', username: 'bob', scope: 'channel',
                            target: 'help', seconds: 300, reason: 'flooding', on: true });
    });

    it('sends the room-shaped scope its bare room id, never the derived target', () => {
        // Same rule as `send`: the ally target is derived by the server off
        // the roster precisely so a client cannot name a team.
        const ally = tab({ key: 'ally:12/ally/1', scope: 'ally', target: '12/ally/1',
                           sendTarget: '12', label: 'Allies' });
        const c = parseChatInput('/mute bob 60', ally);
        expect(c).toMatchObject({ kind: 'mute', scope: 'ally', target: '12', seconds: 60 });
    });

    it('requires a duration for a scoped mute, and refuses rather than defaulting', () => {
        // The wire's default for an absent `seconds` is 0 = until lifted, so
        // the lazy client is the dangerous one: `/mute bob` would silence
        // somebody indefinitely and read like a five-minute timeout.
        expect(parseChatInput('/mute bob', tab())).toMatchObject({ kind: 'error' });
        expect(parseChatInput('/mute bob flooding', tab())).toMatchObject({ kind: 'error' });
        expect(parseChatInput('/mute bob perm rude', tab()))
            .toMatchObject({ kind: 'mute', seconds: 0, reason: 'rude' });
    });

    it('refuses a mute in a PM before the round trip, and names the tool that works', () => {
        const pm = parseChatInput('/mute bob 5m', tab({ scope: 'pm', target: '4:9',
                                                       sendTarget: 'bob' }));
        expect(pm).toMatchObject({ kind: 'error' });
        expect((pm as { message: string }).message).toMatch(/\/ignore bob/);
    });

    it('makes the account-level mute a different verb, usable from anywhere', () => {
        // It belongs to no conversation, so it needs no membership — and it
        // must therefore work from the one tab that has no ops at all.
        const pmTab = tab({ scope: 'pm', target: '4:9', sendTarget: 'bob' });
        expect(parseChatInput('/gmute bob 1h spam', pmTab)).toEqual({
            kind: 'mute', username: 'bob', seconds: 3600, reason: 'spam', on: true });
        expect(parseChatInput('/gmute bob 1h spam', null)).toMatchObject({ kind: 'mute' });
        // No scope key at all: `scope`/`target` absent is what the route reads
        // as the account-level mute.
        expect('scope' in (parseChatInput('/gmute bob perm', pmTab) as object)).toBe(false);
    });

    it('unmutes in the scope being read, and globally with the global verb', () => {
        expect(parseChatInput('/unmute bob', tab())).toEqual({
            kind: 'mute', username: 'bob', scope: 'channel', target: 'help',
            seconds: 0, reason: '', on: false });
        expect(parseChatInput('/gunmute bob', tab())).toEqual({
            kind: 'mute', username: 'bob', seconds: 0, reason: '', on: false });
    });

    it('kicks only from the named channel being read', () => {
        expect(parseChatInput('/kick bob 10m rude', tab())).toEqual({
            kind: 'kick', channel: 'help', username: 'bob', seconds: 600, reason: 'rude' });
        // `#main` cannot be left, so there is nothing to eject anybody from,
        // and a room's ejection verb is `/api/rooms/kick` — a player kicked
        // from a room channel but still seated is in a war they cannot talk to.
        for (const scope of ['main', 'room', 'ally', 'spectator', 'pm'] as const) {
            expect(parseChatInput('/kick bob 10m', tab({ scope })))
                .toMatchObject({ kind: 'error' });
        }
    });

    it('lets a kick take a reason with no duration, and defaults the duration server-side', () => {
        expect(parseChatInput('/kick bob being rude', tab()))
            .toMatchObject({ seconds: 0, reason: 'being rude' });
    });

    it('carries a broadcast and the mute list', () => {
        expect(parseChatInput('/broadcast server restarting', tab()))
            .toEqual({ kind: 'broadcast', text: 'server restarting' });
        expect(parseChatInput('/broadcast', tab())).toMatchObject({ kind: 'error' });
        expect(parseChatInput('/mutes', tab())).toEqual({ kind: 'mutes' });
    });
});

describe('the moderation notice', () => {
    const ev = { muted: true, until: 0, reason: 'spam', by: 'admin' };

    it('stands until lifted when the mute has no expiry', () => {
        expect(moderationActive(ev, 1_700_000_000)).toBe(true);
        expect(moderationActive({ ...ev, muted: false }, 1_700_000_000)).toBe(false);
        expect(moderationActive(null, 1_700_000_000)).toBe(false);
    });

    it('ends itself when the mute expires', () => {
        // Nothing tells the client a timed mute ran out, so a banner that
        // needs an event to clear says "you cannot speak" to somebody who can.
        const timed = { ...ev, until: 1_700_000_060 };
        expect(moderationActive(timed, 1_700_000_000)).toBe(true);
        expect(moderationActive(timed, 1_700_000_061)).toBe(false);
    });

    it('names who, until when and why', () => {
        expect(moderationNoticeText(ev)).toMatch(/muted by admin until lifted/);
        expect(moderationNoticeText(ev)).toMatch(/spam/);
        expect(moderationNoticeText({ ...ev, until: 1_700_000_000, reason: '' }))
            .toMatch(/until \d{2}:\d{2}\.$/);
    });

    it('formats a mute-list row against the scope /unmute needs', () => {
        const row = { account_id: 7, username: 'bob', scope: 'channel:help',
                      until: 1_700_000_600, permanent: false, reason: 'spam', by: 'admin' };
        const line = muteRowLine(row, 1_700_000_000);
        expect(line).toMatch(/bob/);
        expect(line).toMatch(/channel:help/);
        expect(line).toMatch(/10m left/);
        expect(muteRowLine({ ...row, permanent: true, until: 0 }, 1_700_000_000))
            .toMatch(/until lifted/);
    });
});

describe('§3.5 quality of life', () => {
    it('highlights a mention but not a name inside a word', () => {
        expect(hasMention('nice one al', 'al')).toBe(true);
        expect(hasMention('al: hello', 'al')).toBe(true);
        expect(hasMention('AL, look', 'al')).toBe(true);
        expect(hasMention('already done', 'al')).toBe(false);
        expect(hasMention('rally', 'al')).toBe(false);
        expect(hasMention('anything', '')).toBe(false);
    });

    it('treats a username as text, not as a pattern', () => {
        // Usernames are user content; `a.c` must not match `abc`.
        expect(hasMention('abc here', 'a.c')).toBe(false);
        expect(hasMention('a.c here', 'a.c')).toBe(true);
    });

    it('pings for a PM or a mention, and never for my own line or the server', () => {
        const active = tabKey('main', 'main');
        expect(shouldNotify(frame({ text: 'hey al' }), 1, 'al', active)).toBe(true);
        expect(shouldNotify(frame({ text: 'hey all' }), 1, 'al', active)).toBe(false);
        expect(shouldNotify(frame({ fromId: 1, text: 'hey al' }), 1, 'al', active)).toBe(false);
        expect(shouldNotify(frame({ system: true, text: 'hey al' }), 1, 'al', active)).toBe(false);
        const pm = frame({ scope: 'pm', target: '1:7', text: 'psst' });
        expect(shouldNotify(pm, 1, 'al', active)).toBe(true);
        // …but not the PM you are reading. A mention still pings there: it is
        // addressed to you and the window may not have focus.
        expect(shouldNotify(pm, 1, 'al', tabKey('pm', '1:7'))).toBe(false);
        expect(shouldNotify({ ...pm, text: 'al?' }, 1, 'al', tabKey('pm', '1:7'))).toBe(true);
    });

    it('links http(s) only, and leaves the sentence out of the url', () => {
        expect(linkSegments('see http://x.dev/y. ok')).toEqual([
            { text: 'see ' }, { text: 'http://x.dev/y', href: 'http://x.dev/y' },
            { text: '. ok' },
        ]);
        // Anything else is text: `javascript:` and `data:` are exactly what
        // must not become an anchor, and a bare `www.` is ambiguous prose.
        expect(linkSegments('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }]);
        expect(linkSegments('www.x.dev')).toEqual([{ text: 'www.x.dev' }]);
        expect(linkSegments('plain')).toEqual([{ text: 'plain' }]);
        expect(linkSegments('https://a/b and https://c/d').filter(s => s.href).length).toBe(2);
    });
});
