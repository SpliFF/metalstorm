/**
 * war-notice — the browser half of PLAN-persistence task 4d.
 *
 * The lobby's room-list SSE channel now carries a second named event,
 * `war-state`, sent whenever a war ARRIVES somewhere new (`rts/Server/
 * WarStateEvents.h` owns the detection and the sentence). This module decides
 * whether that event is worth interrupting THIS player for, and what the
 * interruption says.
 *
 * Why the decision is here and not in the lobby: the SSE channel is a
 * broadcast — there is no per-account stream — so every browser sees every
 * war's transitions. "Is this one of my wars" is a question the browser can
 * already answer off the row it holds (`enlisted`, task 4c), and answering it
 * server-side would need a per-connection identity the SSE layer does not have
 * plus a second copy of the same rule.
 *
 * Pure. No DOM, no timers: `lobby-ui` renders whatever this returns.
 */

import { formatFrozenFrame, type WarRow, type WarStateKey } from './war-browser';

/// `warevents::ToString(Kind)`, verbatim.
export type WarEventKind = 'none' | 'resuming' | 'back' | 'hibernated' | 'lost';

/// The `war-state` event payload.
export interface WarStateEvent {
    /// The room id the war lives on.
    room: number;
    kind: WarEventKind;
    /// The `WarState` the war arrived in, for a client that wants the datum as
    /// well as the transition. Absent on nothing older than this task, but
    /// optional so a reader never depends on it.
    state?: WarStateKey;
    /// The sentence the lobby wrote. Shown verbatim — the log line and the
    /// toast say the same thing on purpose.
    headline: string;
}

/// What to put on screen. `null` from `noticeFor` means "say nothing", which is
/// the answer for the great majority of events a browser sees.
export interface WarNotice {
    roomId: number;
    kind: WarEventKind;
    /// The war's name, so a player with three wars knows which one moved.
    title: string;
    /// The sentence, plus the world-waiting clause where there is one.
    detail: string;
    /// Distinguishes the good news from the bad, the same split the card's
    /// badge makes: a lost tail must not arrive wearing the accent colour.
    cls: 'war-notice-good' | 'war-notice-wait' | 'war-notice-bad';
    /// True when the war can be joined right now, so the toast can offer it.
    /// A resuming war deliberately cannot: the button would be a promise the
    /// server is still working on.
    canJoin: boolean;
}

/// Parse a `war-state` event body. Returns null on anything malformed rather
/// than throwing — a browser one version behind must ignore an event it cannot
/// read, not lose its SSE handler to an exception.
export function parseWarStateEvent(data: string): WarStateEvent | null {
    let raw: any;
    try {
        raw = JSON.parse(data);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.room !== 'number') return null;
    const kind = raw.kind;
    if (kind !== 'resuming' && kind !== 'back' && kind !== 'hibernated' &&
        kind !== 'lost' && kind !== 'none') return null;
    return {
        room: raw.room,
        kind,
        state: typeof raw.state === 'string' ? raw.state as WarStateKey : undefined,
        headline: typeof raw.headline === 'string' ? raw.headline : '',
    };
}

const CLASS_FOR: Record<Exclude<WarEventKind, 'none'>, WarNotice['cls']> = {
    resuming: 'war-notice-wait',
    back: 'war-notice-good',
    hibernated: 'war-notice-wait',
    lost: 'war-notice-bad',
};

/// Decide whether `ev` is this player's business, and what it says.
///
/// `rows` is the war list the browser is already holding — the same list the
/// event's `rooms` sibling refreshed a moment earlier (the lobby sends the list
/// first for exactly this reason). A war that is not in it gets no notice: the
/// browser has nothing to name and no way to know whose war it is.
export function noticeFor(ev: WarStateEvent, rows: WarRow[]): WarNotice | null {
    if (ev.kind === 'none') return null;
    const row = rows.find(r => r.id === ev.room);
    if (!row) return null;
    // Enlisted only. A player browsing a war they have never played does not
    // need to be interrupted when it goes to sleep, and the sentence the lobby
    // writes says "your war" — it is only true for the account that holds a
    // seat. (`watching`, §3, gets no toast: it would want different prose, and
    // that is a separate decision — see the plan's task 4d notes.)
    if (!(row.enlisted ?? row.returning)) return null;
    if (!ev.headline) return null;

    let detail = ev.headline;
    // The world-waiting clause, on the one event where the frame is a fact
    // about what is parked. Formatted by the card's own formatter so the toast
    // and the card cannot say two different things about one frame — which is
    // also why the lobby's sentence carries no frame of its own.
    const frozen = row.war?.frozen_frame;
    if (ev.kind === 'hibernated' && frozen !== undefined && frozen > 0)
        detail += ` ${formatFrozenFrame(frozen)} waiting for you.`;

    return {
        roomId: row.id,
        kind: ev.kind,
        title: row.name || `Mission ${row.id}`,
        detail,
        cls: CLASS_FOR[ev.kind],
        // A war that came back is joinable now. A hibernated one is joinable
        // too — that IS how it comes back (task 3b) — and offering it is the
        // whole proposition of the notice. `resuming` is the one that must not
        // offer: the process is not serving yet.
        canJoin: ev.kind === 'back' || ev.kind === 'hibernated',
    };
}

// ── The notice rail (review 2026-09-10; drill-down directive, item (c)) ─────
//
// One toast at a time, newest wins, was the original design — and it was
// wrong for the one event that produces many notices at once: a deploy
// hibernates every war in the theatre, so a player with three wars saw the
// last one's toast for 30 s and never learned the other two had moved. The
// rail keeps every notice, grouped by war, folds exact repeats into a count,
// and lets the player mark them read instead of racing a timer.
//
// Pure state, functional updates: `lobby-ui` holds the state and re-renders
// the rail from it. Nothing here is specific to WAR notices — a staging
// notice (world-notifications.ts) is the same shape once it has a title and
// a class — so the world lane can feed the same rail rather than a second
// toast stack (see docs/lobby-war-surfaces.md).

export interface RailNotice {
    /// Monotonic within the rail; the DOM key.
    id: number;
    roomId: number;
    kind: string;
    title: string;
    detail: string;
    cls: WarNotice['cls'];
    canJoin: boolean;
    /// Unix seconds the notice arrived (its LATEST arrival when folded).
    at: number;
    read: boolean;
    /// How many identical notices were folded into this one. 1 = no repeat.
    count: number;
}

export interface NoticeRailState {
    notices: RailNotice[];
    nextId: number;
}

/// Kept so a rail can never grow without bound on a long lobby session; the
/// oldest READ notice goes first, then the oldest unread.
export const NOTICE_RAIL_CAP = 12;

/// Identical repeats within this window fold into one entry with a count.
/// The room-list SSE re-sends nothing on reconnect, so a repeat inside 10 s
/// is the same transition observed twice (two tabs, a re-render race), not a
/// war that moved twice.
export const NOTICE_FOLD_WINDOW_SEC = 10;

export function emptyRail(): NoticeRailState {
    return { notices: [], nextId: 1 };
}

/// Push one notice. Returns a NEW state; the input is untouched.
///
/// Grouping rule: a war has at most one UNREAD notice on the rail. A newer
/// transition for the same war replaces its unread predecessor — "your war
/// is resuming" followed by "your war is back" is one story, and the second
/// line is the one that is true. A READ notice is left alone: the player has
/// seen it, and the new one is new.
export function pushRailNotice(
    rail: NoticeRailState, n: WarNotice, nowSec: number,
): NoticeRailState {
    const notices = [...rail.notices];
    const prevIdx = notices.findIndex(x => x.roomId === n.roomId && !x.read);
    if (prevIdx >= 0) {
        const prev = notices[prevIdx];
        const identical = prev.kind === n.kind && prev.detail === n.detail;
        if (identical && nowSec - prev.at <= NOTICE_FOLD_WINDOW_SEC) {
            notices[prevIdx] = { ...prev, at: nowSec, count: prev.count + 1 };
            return { notices, nextId: rail.nextId };
        }
        notices.splice(prevIdx, 1);
    }
    notices.push({
        id: rail.nextId, roomId: n.roomId, kind: n.kind, title: n.title,
        detail: n.detail, cls: n.cls, canJoin: n.canJoin, at: nowSec,
        read: false, count: 1,
    });
    // Trim: read first, oldest first.
    while (notices.length > NOTICE_RAIL_CAP) {
        const readIdx = notices.findIndex(x => x.read);
        notices.splice(readIdx >= 0 ? readIdx : 0, 1);
    }
    return { notices, nextId: rail.nextId + 1 };
}

/// Mark one notice (or every notice) read. Reading does not remove: the
/// rail is also the record of what moved while the player was looking away.
export function markRailRead(
    rail: NoticeRailState, id: number | 'all',
): NoticeRailState {
    return {
        notices: rail.notices.map(x =>
            (id === 'all' || x.id === id) && !x.read ? { ...x, read: true } : x),
        nextId: rail.nextId,
    };
}

/// Drop one notice (or every read notice) from the rail entirely.
export function dismissRailNotice(
    rail: NoticeRailState, id: number | 'read',
): NoticeRailState {
    return {
        notices: rail.notices.filter(x => id === 'read' ? !x.read : x.id !== id),
        nextId: rail.nextId,
    };
}

export function unreadCount(rail: NoticeRailState): number {
    return rail.notices.filter(x => !x.read).length;
}

/// The collapsed pill's text: '' when there is nothing to say at all (the
/// rail hides), "2 new" while something is unread, "3 notices" once all are
/// read. The unread count is the one number a player scanning for "did
/// anything move" needs, so it is the whole label when it is non-zero.
export function railSummary(rail: NoticeRailState): string {
    const total = rail.notices.length;
    if (total === 0) return '';
    const unread = unreadCount(rail);
    if (unread > 0) return `${unread} new`;
    return `${total} notice${total === 1 ? '' : 's'}`;
}

export interface RailGroup {
    roomId: number;
    title: string;
    /// Newest first.
    notices: RailNotice[];
    unread: number;
}

/// The rail's rows, one group per war, the war with the newest notice first.
export function railGroups(rail: NoticeRailState): RailGroup[] {
    const byRoom = new Map<number, RailGroup>();
    for (const n of rail.notices) {
        let g = byRoom.get(n.roomId);
        if (!g) {
            g = { roomId: n.roomId, title: n.title, notices: [], unread: 0 };
            byRoom.set(n.roomId, g);
        }
        g.notices.push(n);
        if (!n.read) g.unread++;
    }
    const groups = [...byRoom.values()];
    for (const g of groups) g.notices.sort((a, b) => b.at - a.at || b.id - a.id);
    groups.sort((a, b) => b.notices[0].at - a.notices[0].at || b.roomId - a.roomId);
    return groups;
}

/// "×3" for a folded notice, '' for a single one.
export function foldLabel(n: RailNotice): string {
    return n.count > 1 ? `×${n.count}` : '';
}

// ── The room-list stream's stall (memory: "SSE can silently never start") ──
//
// `EventSource` retries on its own only while its `readyState` is
// CONNECTING; a fatal failure (a non-200 answer, a lobby that restarted on a
// new port, a proxy that closed the response) moves it to CLOSED and it never
// tries again — and the browser then sits on a stale list for the rest of
// the session with no error anywhere. `lobby-ui` calls `stopPolling();
// startPolling()` when `shouldRestartRoomStream` says so, after
// `roomStreamRetryDelayMs` of the attempt in question.

/// `EventSource.CLOSED` — spelled as a number so this module needs no DOM.
export const EVENT_SOURCE_CLOSED = 2;

export function shouldRestartRoomStream(readyState: number): boolean {
    return readyState === EVENT_SOURCE_CLOSED;
}

/// 1 s, 2 s, 4 s … capped at 30 s. Never 0: a synchronous restart on a lobby
/// that is down would spin.
export function roomStreamRetryDelayMs(attempt: number): number {
    const a = Math.max(0, Math.floor(attempt));
    return Math.min(30_000, 1000 * Math.pow(2, Math.min(a, 5)));
}
