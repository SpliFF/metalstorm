/**
 * world-notifications.ts — the browser half of PLAN-worldsim.md W11 (and of
 * the phase-3 additions that ride the same seam).
 *
 * `rts/Server/WorldNotifications.h` is the seam: a staging transition (or a
 * POI changing hands) fires one `Publish` and the lobby's subscriber pushes
 * it, over the ALREADY-IDENTIFIED chat SSE channel (`/api/chat/stream`,
 * `lobby-ui.ts`'s `openChatStream`), as a named event — `world-staging` for
 * the four staging kinds, `world-poi` for an ownership change
 * (`WorldNotificationSseEvent`). Both are restricted server-side to
 * accounts with a stake in the POI (`WorldNotificationRecipients`: attacker
 * faction, defender faction, garrisoned commanders), so unlike
 * `war-notice.ts`'s `war-state` event there is NO client-side "is this
 * mine" filter — every event that arrives here was addressed to this
 * account.
 *
 * A third event, `world-season`, is a BROADCAST on the room stream
 * (`/api/rooms/stream`) rather than the chat stream: a season boundary is
 * everyone's business. `parseWorldSeasonEvent` reads it; it lands in the
 * same list.
 *
 * Pure. No DOM, no timers: `world-screen.ts`/`lobby-ui.ts` render whatever
 * this returns. The list is a STANDING list with read-state and pruning,
 * not a log — a player who was away needs the last handful and needs to be
 * able to clear them.
 */

/// `WorldNotificationKindToString`, verbatim, plus the season rollover.
export type WorldStagingNoticeKind = 'opened' | 'materialised' | 'cancelled' | 'failed';
export type WorldNoticeKind = WorldStagingNoticeKind | 'ownership' | 'season';

/// The `world-staging` / `world-poi` event payload (`WorldNotificationToJson`).
export interface WorldStagingNoticeEvent {
    world: string;
    poi: string;
    poiName: string;
    kind: WorldNoticeKind;
    attackerFaction: string;
    defenderFaction: string;
    stagingId: number;
    /// The claim that transferred the POI, on an `ownership` event; 0 otherwise.
    claimId: number;
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
    /// Cleared by `markRead`. The alerts badge counts the unread ones.
    read: boolean;
}

/// Alias for the widened list — the old name stays exported because
/// `lobby-ui.ts` imports it.
export type WorldNotice = WorldStagingNotice;

/// How many notices the World screen keeps. A standing list, not a log — a
/// player who was away needs the last handful, not every alert since login.
export const WORLD_NOTICE_CAP = 20;

/// How long a READ notice is kept before `pruneNotices` drops it. Unread
/// ones are kept until read or capped — an alert the player has not seen
/// yet is not stale, however old.
export const WORLD_NOTICE_READ_TTL_MS = 24 * 3600_000;

const STAGING_KINDS: readonly string[] = ['opened', 'materialised', 'cancelled', 'failed'];

/// Parse a `world-staging` or `world-poi` event body. Returns null on
/// anything malformed rather than throwing, matching `parseWarStateEvent`: a
/// browser one version behind an event it cannot read must not lose its SSE
/// handler to it.
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
    if (!STAGING_KINDS.includes(kind) && kind !== 'ownership') return null;
    return {
        world: typeof raw.world === 'string' ? raw.world : '',
        poi: raw.poi,
        poiName: typeof raw.poiName === 'string' ? raw.poiName : raw.poi,
        kind,
        attackerFaction: typeof raw.attackerFaction === 'string' ? raw.attackerFaction : '',
        defenderFaction: typeof raw.defenderFaction === 'string' ? raw.defenderFaction : '',
        stagingId: typeof raw.stagingId === 'number' ? raw.stagingId : 0,
        claimId: typeof raw.claimId === 'number' ? raw.claimId : 0,
        worldMs: typeof raw.worldMs === 'number' ? raw.worldMs : 0,
        headline: typeof raw.headline === 'string' ? raw.headline : '',
    };
}

/// Parse a `world-season` event body (the lobby sweep's broadcast:
/// `{worldId, endedSeason, newSeason, headline}`) into the same notice
/// shape, so the one list carries it. No POI: `poi` is the season id-ish
/// token so the row is still keyed on something stable.
export function parseWorldSeasonEvent(data: string): WorldStagingNoticeEvent | null {
    let raw: any;
    try {
        raw = JSON.parse(data);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.newSeason !== 'number') return null;
    const ended = typeof raw.endedSeason === 'number' ? raw.endedSeason : raw.newSeason - 1;
    return {
        world: typeof raw.worldId === 'string' ? raw.worldId : '',
        poi: `season-${raw.newSeason}`,
        poiName: `Season ${raw.newSeason}`,
        kind: 'season',
        attackerFaction: '',
        defenderFaction: '',
        stagingId: 0,
        claimId: 0,
        worldMs: typeof raw.worldMs === 'number' ? raw.worldMs : 0,
        headline: typeof raw.headline === 'string' && raw.headline
            ? raw.headline
            : `Season ${ended} has ended; season ${raw.newSeason} begins.`,
    };
}

/// The toast's colour class — good news for "opened" (a warning the player is
/// meant to see), neutral for a withdrawal, and the two ways a window closes
/// split the same way `war-notice.ts`'s `back`/`lost` do. An ownership change
/// is the most consequential thing the world can say, so it reads as urgent
/// too; a season boundary is calendar news.
const CLASS_FOR: Record<WorldNoticeKind, 'good' | 'wait' | 'bad'> = {
    opened: 'wait',
    materialised: 'bad',
    cancelled: 'wait',
    failed: 'wait',
    ownership: 'bad',
    season: 'good',
};

export function stagingNoticeClass(kind: WorldNoticeKind): 'good' | 'wait' | 'bad' {
    return CLASS_FOR[kind] ?? 'wait';
}

/// Append a freshly-arrived event to the standing list, assigning it a local
/// id and capping the list at `WORLD_NOTICE_CAP` (oldest dropped first).
/// Pure — returns a new array rather than mutating `list`, so a caller using
/// it as component state gets the identity change it needs to re-render.
export function pushNotice(
    list: WorldStagingNotice[], ev: WorldStagingNoticeEvent, nextId: number, now: number,
): WorldStagingNotice[] {
    const withNew = [{ ...ev, id: nextId, receivedAt: now, read: false }, ...list];
    return withNew.length > WORLD_NOTICE_CAP ? withNew.slice(0, WORLD_NOTICE_CAP) : withNew;
}

export function unreadCount(list: readonly WorldStagingNotice[]): number {
    let n = 0;
    for (const x of list) if (!x.read) n++;
    return n;
}

/// Mark one notice read (by local id), or every notice when `id` is null.
/// Pure; the list identity changes only if something did.
export function markRead(list: WorldStagingNotice[], id: number | null): WorldStagingNotice[] {
    let changed = false;
    const out = list.map(n => {
        if (n.read || (id !== null && n.id !== id)) return n;
        changed = true;
        return { ...n, read: true };
    });
    return changed ? out : list;
}

/// Drop read notices older than `ttlMs`, and (always) enforce the cap. Unread
/// notices are never pruned by age. Pure.
export function pruneNotices(
    list: WorldStagingNotice[], now: number, ttlMs: number = WORLD_NOTICE_READ_TTL_MS,
): WorldStagingNotice[] {
    const kept = list.filter(n => !n.read || now - n.receivedAt < ttlMs);
    const capped = kept.length > WORLD_NOTICE_CAP ? kept.slice(0, WORLD_NOTICE_CAP) : kept;
    return capped.length === list.length ? list : capped;
}

/// Remove every READ notice — the drawer's "Clear read" control. Pure.
export function clearRead(list: WorldStagingNotice[]): WorldStagingNotice[] {
    const kept = list.filter(n => !n.read);
    return kept.length === list.length ? list : kept;
}

/// "just now" / "4m ago" / "3h ago" / "2d ago" — the wall clock the reader
/// lives on, never the world clock.
export function formatAgo(receivedAt: number, now: number): string {
    const s = Math.max(0, Math.floor((now - receivedAt) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}
