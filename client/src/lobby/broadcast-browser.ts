/**
 * Broadcast browser — turning one `/api/broadcasts/list` row into what a
 * spectator picks a Mission Broadcast by (PLAN-beta-broadcast.md lane C).
 *
 * Mirrors `replay-browser.ts`: pure and separated from the lobby DOM for the
 * same reason — the interesting decisions here (live vs recorded, how far
 * behind, whether someone is already watching) are worth asserting, not
 * eyeballing.
 */

/// One row of `POST /api/broadcasts/list` (PLAN-beta-broadcast.md §Lobby).
/// A live mission is listed once its first record clears the delay floor;
/// `state` distinguishes it from a finished (`recorded`) segment, which has
/// no `behind_seconds` to show.
export interface BroadcastListing {
    file: string;
    mission_title?: string;
    map?: string;
    game?: string;
    state: 'live' | 'recorded';
    behind_seconds?: number;
    /// UNIX **seconds** (the lobby sends `availableSinceMs / 1000`). Typed as
    /// `string` too because a future/older server may send an ISO instant.
    available_since?: number | string;
    /// Seconds of mission covered so far, not frames — the catalog is built
    /// off wall-clock log spans, not a sim.
    duration?: number;
    /// Set when this file already has a live relay — watching joins it.
    watching_room?: number;
}

export interface BroadcastEntryModel {
    /// Headline: the mission title, falling back to map/game, then the
    /// filename when nothing else is known.
    title: string;
    /// "Broadcast · 1h behind" for a live mission, "Recorded" for a
    /// finished one — the chip PLAN-beta-broadcast.md §Client asks for.
    chip: string;
    /// `m:ss`, or '' when the catalog carries no duration yet.
    duration: string;
    /// Everything else worth a glance, joined with ' · '.
    detail: string;
    /// Button text — the exact copy PLAN-beta-broadcast.md names for a live
    /// mission; 'Join cast' when someone is already watching this file;
    /// 'Watch' for a finished recording, which has no delay to state.
    watchLabel: string;
}

function clock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/// "1h behind" / "45m behind". The server's floor is one hour but a dev
/// override can lower it for the live-verification recipe, so this formats
/// whatever arrives rather than assuming an hour.
function behindLabel(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    if (h >= 1) return `${h}h behind`;
    return `${Math.max(1, Math.round(s / 60))}m behind`;
}

function shortDate(when: number | string): string {
    if (when === '' || when === undefined || when === null) return '';
    // The lobby sends UNIX SECONDS, not milliseconds and not an ISO string:
    // `new Date(1789616390)` is 22 Jan 1970, which is what this rendered
    // before the scale was applied (beta-e2e pass 1).
    const d = new Date(typeof when === 'number' ? when * 1000 : when);
    if (Number.isNaN(d.getTime())) return String(when);
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

export function describeBroadcastEntry(r: BroadcastListing): BroadcastEntryModel {
    const chip = r.state === 'live'
        ? `Broadcast · ${behindLabel(r.behind_seconds ?? 3600)}`
        : 'Recorded';

    const detail: string[] = [];
    if (r.available_since) detail.push(shortDate(r.available_since));
    if (r.map) detail.push(r.map);

    return {
        title: r.mission_title || (r.map ? `${r.map}${r.game ? ` · ${r.game}` : ''}` : r.file),
        chip,
        duration: r.duration ? clock(r.duration) : '',
        detail: detail.join(' · '),
        watchLabel: r.watching_room !== undefined
            ? 'Join cast'
            : (r.state === 'live' ? 'Watch this Mission — 1h behind' : 'Watch'),
    };
}
