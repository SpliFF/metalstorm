/**
 * Replay browser — turning one `/api/replays/list` row into the four things
 * §5 says a listing shows: date, duration, players, outcome (PLAN-replay.md
 * task 4c).
 *
 * Pure, and separated from the lobby DOM for the same reason `describeReplayBar`
 * is: every interesting decision here is about what a recording's *absences*
 * mean, and those are worth asserting rather than eyeballing. A replay can be
 * unreadable, truncated mid-match, missing an outcome, or missing a hash track,
 * and each of those is a different sentence to a person deciding what to watch.
 */

const SIM_HZ = 30;

/// One row of `POST /api/replays/list`. Mirrors `replayToJson` in
/// lobby_main.cpp; every optional field is optional because a row for a file
/// the lobby could not open carries only `file`/`bytes`/`ok`/`error`.
export interface ReplayListing {
    file: string;
    bytes: number;
    ok: boolean;
    error?: string;
    game?: string;
    game_version?: string;
    map?: string;
    room_id?: number;
    recorded_at?: string;
    /// File mtime in unix seconds. The fallback date for a recording written
    /// before `recorded_at` had a producer.
    modified_at?: number;
    start_frame?: number;
    end_frame?: number;
    truncated?: boolean;
    codec?: string;
    records?: number;
    hash_points?: number;
    checkpoints?: number;
    players?: { username: string; team: number; start_pos: number }[];
    ai_slots?: { ai_id: string; team: number; start_pos: number }[];
    modoptions?: Record<string, string>;
    outcome?: { declared: boolean; frame?: number; winning_ally_teams?: number[] };
    /// Set when this recording already has a live cast — watching joins it.
    watching_room?: number;
}

export interface ReplayEntryModel {
    /// Headline: map and game, falling back to the filename when the header
    /// could not be read at all.
    title: string;
    /// `m:ss`, or '' when the recording carries no frames to measure.
    duration: string;
    /// Short outcome badge — the §5 column that had no source until the
    /// container grew an outcome block.
    outcome: string;
    /// Roster line: humans first, then AI slots.
    players: string;
    /// Everything else worth a glance, joined with ' · '.
    detail: string;
    /// Button text. 'Join cast' when someone is already watching this file.
    watchLabel: string;
    /// True when the row cannot be watched (the lobby could not read the file).
    disabled: boolean;
}

function clock(frames: number): string {
    const s = Math.max(0, Math.floor(frames / SIM_HZ));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/// ISO-8601 → a short local date/time. The recorder writes UTC; a viewer
/// wants to know which evening it was, not which instant.
function shortDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function humanBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeReplayEntry(r: ReplayListing): ReplayEntryModel {
    if (!r.ok) {
        // Deliberately still a row. The server keeps unreadable files in the
        // list rather than dropping them, and the browser has to show the same
        // thing, or a corrupt recording just looks like one that was never made.
        return {
            title: r.file,
            duration: '',
            outcome: 'unreadable',
            players: '',
            detail: r.error ?? 'this file could not be read',
            watchLabel: 'Unreadable',
            disabled: true,
        };
    }

    const span = Math.max(0, (r.end_frame ?? 0) - (r.start_frame ?? 0));
    const humans = (r.players ?? []).map(p => p.username);
    const ais = (r.ai_slots ?? []).map(a => `AI:${a.ai_id}`);
    const roster = [...humans, ...ais];

    let outcome: string;
    if (r.outcome?.declared) {
        const winners = r.outcome.winning_ally_teams ?? [];
        outcome = winners.length === 0 ? 'draw'
            : winners.length === 1 ? `team ${winners[0]} won`
                : `teams ${winners.join(', ')} won`;
    } else if (r.truncated) {
        // The two "no outcome" cases are NOT the same sentence: a truncated
        // file means the recorder died, which is a fact about the server, and
        // a clean file with no outcome means the match was stopped, which is a
        // fact about the game.
        outcome = 'recording cut short';
    } else {
        outcome = 'no result';
    }

    const detail: string[] = [];
    // The header's own stamp when it has one, the file's mtime when it does
    // not. Recordings made before `recordedAt` had a producer are the whole
    // reason for the fallback, and they are exactly the ones already on disk.
    const when = r.recorded_at
        ? shortDate(r.recorded_at)
        : (r.modified_at ? shortDate(new Date(r.modified_at * 1000).toISOString()) : '');
    if (when) detail.push(when);
    if (span > 0) detail.push(clock(span));
    detail.push(humanBytes(r.bytes));
    if (r.truncated) detail.push('truncated');
    if ((r.hash_points ?? 0) === 0) detail.push('no hash track');
    // §7.15 T4b-1: without checkpoints the playback bar can only run forwards.
    // Saying so here means the refusal at the bar is not the first the viewer
    // hears of it.
    if ((r.checkpoints ?? 0) === 0) detail.push('forward seek only');

    return {
        title: r.map ? `${r.map}${r.game ? ` · ${r.game}` : ''}` : r.file,
        duration: span > 0 ? clock(span) : '',
        outcome,
        players: roster.length > 0 ? roster.join(', ') : 'no roster',
        detail: detail.join(' · '),
        watchLabel: r.watching_room !== undefined ? 'Join cast' : 'Watch',
        disabled: false,
    };
}

/// The frame a `?watch=<file>&frame=N` deep link should start at. Returns 0
/// (start of the recording) for anything that is not a positive integer —
/// a bad deep link plays the game from the beginning rather than refusing,
/// because the recording is what the person came for.
export function parseWatchFrame(raw: string | null): number {
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
