// The while-you-were-away digest — PLAN-persistence.md §4, task 4b.
//
// A persistent war runs for weeks and is played in sessions. A player who
// closed the browser on Tuesday and comes back on Friday logs into a board
// that states only the CURRENT ownership, the CURRENT objectives and the
// CURRENT pacts — nothing anywhere says what happened in between, which is
// most of what they want to know and the entire point of a war that outlives
// its players' evenings.
//
// The events come from `POST /api/wars/join-preview` (the lobby's slice of the
// `game_events` table, cut at this account's own `last_seen_at`); the wording
// lives here because it is the only part worth testing without a server.
//
// ── One rule runs through all of it: say WHOSE ──────────────────────────────
// "A region changed hands" is not news. "Union took Ridge Crossing" is, and
// "You took Ridge Crossing" is different again — a player coming back after
// three days needs to know which of the things that happened were theirs.
// Every line below therefore resolves `team` against the war's own sides, and
// falls back to a sideless phrasing rather than printing a team NUMBER, which
// means nothing to anybody outside the sim.

import type { WarDigestEvent } from './join-preview';
import type { WarSide } from './war-browser';

/// Title-case a faction key. The keys are lowercased by the engine's own
/// `SideParser` derivation, so there is no cased spelling to recover.
function factionLabel(key: string): string {
    if (!key) return '';
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/// The name to call a team in a digest line: "You" for the reader's own side,
/// the faction otherwise, and '' when the war does not field that team at all
/// (a Gaia event, or a side that has since been re-authored away).
function teamLabel(team: number, sides: WarSide[], myTeam: number | undefined): string {
    if (team < 0) return '';
    if (myTeam !== undefined && myTeam >= 0 && team === myTeam) return 'You';
    const side = sides.find(s => s.team === team);
    return side ? factionLabel(side.faction) : '';
}

/// English for a subject that may be a proper name ("Ridge Crossing") or a
/// bare type key ("control"). Only the latter wants an article, and a grid
/// map's regions are keys like "3:4" — which read as neither, so they are
/// left exactly as the sim spelled them.
function objectiveNoun(subject: string): string {
    if (!subject) return 'An objective';
    // Sentence case, because this noun starts a sentence in two of its three
    // uses — the third lowercases the whole thing back for mid-sentence use.
    return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} objective`;
}

/// One digest line, or '' for an event this client has no wording for — a
/// lobby ahead of its client publishes kinds this build has never heard of,
/// and a war's history must degrade to fewer lines rather than to `undefined`.
export function formatDigestLine(
    e: WarDigestEvent,
    sides: WarSide[],
    myTeam?: number,
): string {
    const who = teamLabel(e.team, sides, myTeam);
    switch (e.kind) {
        case 'region':
            if (e.detail === 'lost' || e.team < 0)
                return `${e.subject} slipped out of anyone's control`;
            return who ? `${who} took ${e.subject}` : `${e.subject} changed hands`;
        case 'objective':
            switch (e.detail) {
                case 'complete':
                    return who
                        ? `${who} completed the ${objectiveNoun(e.subject).toLowerCase()}`
                        : `${objectiveNoun(e.subject)} was completed`;
                case 'failed':
                    return `${objectiveNoun(e.subject)} failed`;
                case 'expired':
                    return `${objectiveNoun(e.subject)} expired`;
                default:
                    return '';
            }
        case 'pact':
            switch (e.detail) {
                case 'made':
                    return `A ${e.subject} was agreed`;
                case 'broken':
                    // The breaker, not the proposer — see game_parley.lua's
                    // emit site. Without a named breaker the line still has to
                    // report the breach, which is the news.
                    return who ? `${who} broke a ${e.subject}` : `A ${e.subject} was broken`;
                case 'ended':
                    return `A ${e.subject} ran its course`;
                default:
                    return '';
            }
        case 'elided':
            // The server could not recover these — the sim's ring lapped
            // before the drain reached it. Said plainly: a digest that
            // silently drops events is a digest that cannot be trusted on the
            // ones it does show.
            return `${e.detail} earlier event(s) were not recorded`;
        default:
            return '';
    }
}

/// How long "away" was, in the coarsest unit that is still true. Only ever
/// approximate on purpose — the exact second a session dropped is not
/// something a player knows or cares about.
export function formatAway(sec: number): string {
    if (sec < 90) return '';                       // they never really left
    const mins = Math.floor(sec / 60);
    if (mins < 60) return `${mins} minutes`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs} hours`;
    return `${Math.floor(hrs / 24)} days`;
}

/// The whole digest: a heading and the lines under it.
///
/// Returns `null` when there is nothing to say, which is the ordinary case and
/// has to be distinguishable from "something happened but we have no wording
/// for it" — a card that renders an empty "While you were away" box on every
/// war a player holds a seat in is worse than no feature.
///
/// `total` is the true count before the server's cap, so `more` is a fact
/// rather than an inference from a list length. It counts what was cut off the
/// FRONT of the story — the caller renders it above the lines, not below.
export function formatDigest(
    events: WarDigestEvent[] | undefined,
    total: number | undefined,
    sides: WarSide[],
    opts: { awaySec?: number; myTeam?: number; maxLines?: number } = {},
): { heading: string; lines: string[]; more: number } | null {
    if (!events || events.length === 0) return null;
    const all = events
        .map(e => formatDigestLine(e, sides, opts.myTeam))
        .filter(s => s !== '');
    if (all.length === 0) return null;
    // Capped HERE rather than by a scrolling box, and that is a fix rather
    // than a preference: a `max-height` with `overflow-y: auto` hid the "and
    // N more" line under the fold on a month-long absence — the one line
    // whose whole job is to say the list is not the whole story. Found by
    // screenshotting the harness; every assertion was green.
    // The NEWEST `maxLines`, matching the cut the server already made for the
    // same reason: what a truncated story loses is its beginning.
    const maxLines = opts.maxLines ?? 5;
    const lines = all.slice(-maxLines);

    const away = opts.awaySec !== undefined ? formatAway(opts.awaySec) : '';
    const heading = away ? `While you were away (${away})` : 'While you were away';
    // Counted against what the SERVER had, not against what was rendered: a
    // line this build has no wording for is still an event that happened, and
    // folding it into "and N more" is the honest place for it.
    const more = Math.max(0, (total ?? events.length) - lines.length);
    return { heading, lines, more };
}
