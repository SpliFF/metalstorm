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
    parseChatInput, pmOther, pmTarget, roomTabSpecs, sortTabs, streamRecovery,
    tabKey, type ChatFrame, type ChatTab,
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
