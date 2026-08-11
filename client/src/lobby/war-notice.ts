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
        title: row.name || `War ${row.id}`,
        detail,
        cls: CLASS_FOR[ev.kind],
        // A war that came back is joinable now. A hibernated one is joinable
        // too — that IS how it comes back (task 3b) — and offering it is the
        // whole proposition of the notice. `resuming` is the one that must not
        // offer: the process is not serving yet.
        canJoin: ev.kind === 'back' || ev.kind === 'hibernated',
    };
}
