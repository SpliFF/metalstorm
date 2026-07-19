import { describe, it, expect, vi } from 'vitest';
import { CommandBuffer, CMD, OPT } from './command-buffer.js';
import type { Connection } from './connection.js';

/**
 * CommandNotify gate (review fix 2): every natively-issued order must run
 * through the wired notifier before reaching the server; a truthy return
 * vetoes the send (Recoil: CGuiHandler passes every GUI command through
 * luaUI->CommandNotify first). Post-GW4 the notifier is synchronous
 * (dispatchCommandNotify in the same worker), but the async form is still
 * accepted and fails open on rejection.
 */

/** Minimal Connection stand-in — records sendPlayerCommand calls. */
function mockConnection(): { conn: Connection; sent: unknown[][] } {
    const sent: unknown[][] = [];
    const conn = {
        sendPlayerCommand: (...args: unknown[]) => { sent.push(args); },
    } as unknown as Connection;
    return { conn, sent };
}

describe('CommandBuffer CommandNotify gate', () => {
    it('sends synchronously when no notifier is wired', () => {
        const { conn, sent } = mockConnection();
        const buf = new CommandBuffer(conn);
        buf.issueImmediate(CMD.MOVE, [7], [1, 2, 3], OPT.SHIFT);
        expect(sent).toEqual([[CMD.MOVE, [7], [1, 2, 3], OPT.SHIFT, 0]]);
        buf.dispose();
    });

    it('drops the command when a sync notifier vetoes (returns true)', () => {
        const { conn, sent } = mockConnection();
        const buf = new CommandBuffer(conn);
        buf.setNotifier(() => true);
        buf.issueImmediate(CMD.ATTACK, [7], [42]);
        expect(sent).toEqual([]);
        buf.dispose();
    });

    it('sends synchronously when a sync notifier passes (returns false)', () => {
        const { conn, sent } = mockConnection();
        const buf = new CommandBuffer(conn);
        const notifier = vi.fn(() => false);
        buf.setNotifier(notifier);
        buf.issueImmediate(CMD.GUARD, [7, 8], [42], OPT.SHIFT);
        // Notifier saw the order…
        expect(notifier).toHaveBeenCalledWith(CMD.GUARD, [42], OPT.SHIFT);
        // …and the send happened in the same tick (ordering preserved).
        expect(sent).toEqual([[CMD.GUARD, [7, 8], [42], OPT.SHIFT, 0]]);
        buf.dispose();
    });

    it('fails open when the notifier throws', () => {
        const { conn, sent } = mockConnection();
        const buf = new CommandBuffer(conn);
        buf.setNotifier(() => { throw new Error('widget error'); });
        buf.issueImmediate(CMD.MOVE, [1], [0, 0, 0]);
        expect(sent).toHaveLength(1);
        buf.dispose();
    });

    it('supports an async notifier: veto drops, pass sends, rejection fails open', async () => {
        const { conn, sent } = mockConnection();
        const buf = new CommandBuffer(conn);

        buf.setNotifier(async () => true);
        buf.issueImmediate(CMD.MOVE, [1], [0, 0, 0]);
        await Promise.resolve();  // let the veto settle
        expect(sent).toHaveLength(0);

        buf.setNotifier(async () => false);
        buf.issueImmediate(CMD.MOVE, [1], [0, 0, 0]);
        await Promise.resolve();
        expect(sent).toHaveLength(1);

        buf.setNotifier(() => Promise.reject(new Error('stalled')));
        buf.issueImmediate(CMD.MOVE, [1], [0, 0, 0]);
        await Promise.resolve();
        await Promise.resolve();  // rejection handler + send
        expect(sent).toHaveLength(2);
        buf.dispose();
    });

    it('clearing the notifier (null) restores the direct send path', () => {
        const { conn, sent } = mockConnection();
        const buf = new CommandBuffer(conn);
        buf.setNotifier(() => true);
        buf.setNotifier(null);
        buf.issueImmediate(CMD.STOP, [3], []);
        expect(sent).toHaveLength(1);
        buf.dispose();
    });

    it('gates debounced (issueCommand) sends through the notifier too', () => {
        const { conn, sent } = mockConnection();
        const buf = new CommandBuffer(conn);
        const seen: number[] = [];
        buf.setNotifier((cmdId) => { seen.push(cmdId); return cmdId === CMD.ATTACK; });
        buf.issueCommand(CMD.MOVE, [5], [1, 2, 3]);
        buf.flush();
        buf.issueCommand(CMD.ATTACK, [5], [9]);
        buf.flush();
        expect(seen).toEqual([CMD.MOVE, CMD.ATTACK]);
        // MOVE passed, ATTACK was vetoed.
        expect(sent).toEqual([[CMD.MOVE, [5], [1, 2, 3], 0, 0]]);
        buf.dispose();
    });
});
