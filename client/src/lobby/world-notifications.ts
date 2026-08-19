/**
 * world-notifications.ts — the browser half of PLAN-worldsim.md W11.
 *
 * `rts/Server/WorldNotifications.h` is the seam: a staging transition fires
 * one `Publish` and the lobby's only subscriber pushes it, over the
 * ALREADY-IDENTIFIED chat SSE channel (`/api/chat/stream`, `lobby-ui.ts`'s
 * `openChatStream`), as a named `world-staging` event — restricted
 * server-side to accounts with a stake in the POI (`WorldNotificationRecipients`:
 * attacker faction, defender faction, garrisoned commanders). Unlike
 * `war-notice.ts`'s `war-state` event, this one does NOT need a client-side
 * "is this mine" filter — every event that arrives here has already been
 * addressed to this account, because the channel is per-account rather than
 * broadcast.
 *
 * Pure. No DOM, no timers: `world-screen.ts`/`lobby-ui.ts` render whatever
 * this returns.
 */

/// `WorldNotificationKindToString`, verbatim.
export type WorldStagingNoticeKind = 'opened' | 'materialised' | 'cancelled' | 'failed';

/// The `world-staging` event payload (`WorldNotificationToJson`).
export interface WorldStagingNoticeEvent {
    world: string;
    poi: string;
    poiName: string;
    kind: WorldStagingNoticeKind;
    attackerFaction: string;
    defenderFaction: string;
    stagingId: number;
    worldMs: number;
    /// The sentence the lobby wrote. Shown verbatim, same discipline
    /// `WarStateEvent.headline` follows — the log line and the toast/list
    /// entry must never disagree about what happened.
    headline: string;
}

/// A notification as kept in the World screen's list — the wire event plus
/// bookkeeping the client alone needs.
export interface WorldStagingNotice extends WorldStagingNoticeEvent {
    /// Local, monotonic, assigned by `pushNotice` — stable across a re-render
    /// so a list keyed on it does not remount every row on every arrival.
    id: number;
    /// `Date.now()` at receipt, for a relative-time label. Not `worldMs`
    /// (that is the WORLD clock, and the list is read on the wall clock the
    /// player is living in).
    receivedAt: number;
}

/// How many notices the World screen keeps. A standing list, not a log — a
/// player who was away needs the last handful, not every alert since login.
export const WORLD_NOTICE_CAP = 20;

/// Parse a `world-staging` event body. Returns null on anything malformed
/// rather than throwing, matching `parseWarStateEvent`: a browser one version
/// behind an event it cannot read must not lose its SSE handler to it.
export function parseWorldStagingEvent(data: string): WorldStagingNoticeEvent | null {
    let raw: any;
    try {
        raw = JSON.parse(data);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.poi !== 'string' || !raw.poi) return null;
    const kind = raw.kind;
    if (kind !== 'opened' && kind !== 'materialised' && kind !== 'cancelled' && kind !== 'failed')
        return null;
    return {
        world: typeof raw.world === 'string' ? raw.world : '',
        poi: raw.poi,
        poiName: typeof raw.poiName === 'string' ? raw.poiName : raw.poi,
        kind,
        attackerFaction: typeof raw.attackerFaction === 'string' ? raw.attackerFaction : '',
        defenderFaction: typeof raw.defenderFaction === 'string' ? raw.defenderFaction : '',
        stagingId: typeof raw.stagingId === 'number' ? raw.stagingId : 0,
        worldMs: typeof raw.worldMs === 'number' ? raw.worldMs : 0,
        headline: typeof raw.headline === 'string' ? raw.headline : '',
    };
}

/// The toast's colour class — good news for "opened" (a warning the player is
/// meant to see), neutral for a withdrawal, and the two ways a window closes
/// split the same way `war-notice.ts`'s `back`/`lost` do.
const CLASS_FOR: Record<WorldStagingNoticeKind, 'good' | 'wait' | 'bad'> = {
    opened: 'wait',
    materialised: 'bad',
    cancelled: 'wait',
    failed: 'wait',
};

export function stagingNoticeClass(kind: WorldStagingNoticeKind): 'good' | 'wait' | 'bad' {
    return CLASS_FOR[kind];
}

/// Append a freshly-arrived event to the standing list, assigning it a local
/// id and capping the list at `WORLD_NOTICE_CAP` (oldest dropped first).
/// Pure — returns a new array rather than mutating `list`, so a caller using
/// it as component state gets the identity change it needs to re-render.
export function pushNotice(
    list: WorldStagingNotice[], ev: WorldStagingNoticeEvent, nextId: number, now: number,
): WorldStagingNotice[] {
    const withNew = [{ ...ev, id: nextId, receivedAt: now }, ...list];
    return withNew.length > WORLD_NOTICE_CAP ? withNew.slice(0, WORLD_NOTICE_CAP) : withNew;
}
