// The war browser — PLAN-metalstorm-lobby.md §4, task 6.
//
// §4: "Players choose a *war to join*, not a lobby to fill, and the default
// view is **wars where my faction is fighting**." A room browser answers "is
// there a game?"; a war browser answers a different question — "is there room
// for ME, on my side, in a war worth walking into" — and the fields that
// answer it are per-faction, not per-room.
//
// ── Two sources, and which fact comes from which is load-bearing ──────────
// The `war` block on a room row (lobby_main.cpp) is deliberately half durable
// and half live:
//
//   * `bound` / `open` come from `war_player_bindings` — a seat held by a
//     player who is offline is NOT free, and a war whose server is not even
//     running still lists with its sides and its capacity (task 3).
//   * `online` / `ais` / `regions` / `spectators` / `control` / `uptime_sec`
//     come from the digest a running server publishes, and are simply absent
//     otherwise. `live` says which of the two you are looking at.
//
// So every formatter here has to read correctly with the live half missing.
// That is not a defensive nicety: "the server is down" is a state a
// persistent war spends real time in, and it is the state in which a player
// most wants to see the war and rejoin it.

import type { WarSeatKey } from './join-preview';

/// One side of a war, as the room JSON carries it. Field names are the wire's.
export interface WarSide {
    team: number;
    /// Faction key, lowercased by the engine's own side derivation.
    faction: string;
    /// Humans holding a seat on this side, online or not (durable).
    bound: number;
    /// Seats left, derived from `bound` — never from `online`.
    open: number;
    /// This side's own capacity (§6, task 7). Sides are sized independently —
    /// a war seeded for a faction with a player surplus gives that faction the
    /// bigger side — so the war-level `capacity_per_side` is only the fallback
    /// for a side that declares none.
    capacity?: number;
    /// True when this side has no cap at all. Stated rather than encoded as a
    /// number, because `open: 0` is what FULL looks like and an uncapped side
    /// is the one that can never be full.
    unlimited?: boolean;
    /// Humans connected right now. Absent when no server is publishing.
    online?: number;
    ais?: number;
    regions?: number;
}

/// What a war IS at this instant — `warresume::ToString(WarState)`, verbatim.
/// Absent on a lobby older than PLAN-persistence task 3b, which is why every
/// reader here falls back to the `live` flag rather than assuming a word.
export type WarStateKey =
    'not_a_war' | 'live' | 'resuming' | 'hibernated' | 'crashed' | 'fresh' |
    'unresumable';

/// `warresume::ToString(ResumeEligibility)`, verbatim.
export type ResumeEligibilityKey =
    'no_history' | 'resumable' | 'engine_changed' | 'map_changed' |
    'unknown_binary';

/// The `war` block of a room row.
export interface WarInfo {
    /// True when a running server published a digest in the last 30s.
    live: boolean;
    capacity_per_side: number;
    sides: WarSide[];
    spectators?: number;
    frame?: number;
    uptime_sec?: number;
    control?: { total: number; contested: number; neutral: number };
    /// ── The hibernation datums (PLAN-persistence tasks 3b/3c) ──────────────
    /// `live` above is one bit: is a digest being published. `state` is what
    /// the war IS, which is a different question with answers `live` cannot
    /// give — a resume in flight, a checkpointed world, a lost tail.
    state?: WarStateKey;
    /// The frame the world would come back at. Published whenever the store
    /// holds any history, INCLUDING while the war is live (there it is the
    /// last durable point, not the current frame — `frame` above is that).
    frozen_frame?: number;
    /// Unix seconds when that snapshot was written.
    frozen_at?: number;
    /// Whether `frozen_frame` is a promise or a loss (E1 pre-flight).
    resume_eligibility?: ResumeEligibilityKey;
    /// The operator-facing prose behind a refusal — engine/map hashes and all.
    /// Shown as a tooltip, never as the card's own sentence: see
    /// `formatResumeRefusal`.
    resume_blocked_reason?: string;
}

/// A room row narrowed to what the war browser needs.
export interface WarRow {
    id: number;
    name: string;
    mapId: string;
    /// Room state — 3+ means the war is loading/running.
    state: number;
    war: WarInfo;
    /// True when this account already holds a seat in this war (from the
    /// join preview, which is the only per-account source).
    returning?: boolean;
    /// True when this account asked to WATCH this war (§3).
    watching?: boolean;
    /// True when this account is ENLISTED in this war — it holds a binding,
    /// whether or not a join would seat it back on the same team. This, not
    /// `returning`, is what "My wars" means (task 4c). Absent on a lobby
    /// older than task 4c, and every reader falls back to `returning` there.
    enlisted?: boolean;
    /// What happened to that binding (`RejoinSeatKey`).
    seat?: WarSeatKey;
    /// Seconds since this account was last seen in this war. Only ever present
    /// for an enlisted account — the lobby sends it with the digest.
    awaySec?: number;
    /// The faction key of the side this account would fight for here.
    mySide?: string;
}

/// Which wars the browser is showing. `my-faction` is the default because it
/// is the question §4 says a player is actually asking.
export type WarFilter = 'my-faction' | 'my-wars' | 'friends-here' | 'all';

export const WAR_FILTER_LABELS: Record<WarFilter, string> = {
    'my-faction': 'My faction',
    'my-wars': 'My wars',
    'friends-here': 'Friends here',
    'all': 'All wars',
};

/// The side of `war` this faction fields, or undefined when the war declares
/// none. A war with no side for you is not "full" — it is a war you can only
/// ever watch, and the two read very differently on a card.
export function sideForFaction(war: WarInfo, faction: string): WarSide | undefined {
    if (!faction) return undefined;
    return war.sides.find(s => s.faction === faction);
}

/// Can this account take a seat in this war right now? The decisive field of
/// §4 — "my-faction's open-slot count ... is there room for *me*".
///
/// Deliberately NOT a re-derivation of the seating rule: the authoritative
/// answer for a specific account is the join preview, which composes the same
/// functions the game server seats with. This is the list-level filter, and
/// it answers the coarser question the filter chip asks.
export function hasRoomForFaction(war: WarInfo, faction: string): boolean {
    const side = sideForFaction(war, faction);
    if (!side) return false;
    return side.unlimited === true || side.open > 0;
}

/// `friendRooms` is the set of war rooms a mutual friend is fighting in right
/// now (`friendWarRooms`, task 9a). Optional because every other filter is a
/// function of the rows alone, and a caller with no friends list — a lobby
/// older than the friends routes, or a fetch that failed — must get the same
/// answer it always did rather than an empty browser.
export function filterWars(
    wars: WarRow[], filter: WarFilter, faction: string,
    friendRooms?: ReadonlySet<number>,
): WarRow[] {
    switch (filter) {
        case 'my-faction':
            // Wars my faction FIELDS A SIDE IN — not wars I can squeeze into.
            // A full war my faction is fighting is still my war to watch, and
            // hiding it would hide the thing that is happening in the world.
            return wars.filter(w => !!sideForFaction(w.war, faction));
        case 'my-wars':
            // ENLISTMENT, not seating (task 4c). `returning` is the answer to
            // "would a join put you back on your team", and it goes false when
            // the war's sides stop seating your faction on the team your
            // binding records — at which point this list dropped the war a
            // player has a week of history in. The fallback keeps a client
            // ahead of its lobby working on the old bit.
            return sortMyWars(wars.filter(w => w.enlisted ?? w.returning));
        case 'friends-here':
            // §4's friends filter (task 9a). PRESENCE, not the social graph:
            // the row belongs here because a friend is standing in this war
            // this minute, which is a fact with a 150 s freshness window on
            // the server. A war a friend fought in yesterday is not "here",
            // and no filter chip should imply it is.
            //
            // Not narrowed to wars this account can be seated in: a friend
            // fighting in a war closed to your faction is exactly the case
            // §8's join has to be able to REFUSE out loud, and hiding the war
            // hides the refusal too.
            return wars.filter(w => friendRooms?.has(w.id) ?? false);
        case 'all':
            return wars;
    }
}

/// Where a war sits in "My wars". Lower sorts first.
///
/// The ordering is the whole reason this list is not just a filtered browser:
/// these are the player's OWN worlds, and the question they answer it with is
/// "which of mine needs me". A war being played right now outranks one that is
/// waiting, and a war that is waiting outranks one that never started.
function myWarRank(row: WarRow): number {
    switch (row.war.state) {
        case 'live':        return 0;
        case 'resuming':    return 1;
        case 'crashed':     return 2;   // ahead of a clean freeze: it lost frames
        case 'hibernated':  return 3;
        case 'unresumable': return 4;
        case 'fresh':       return 5;
        default:            return row.war.live ? 0 : 3;
    }
}

/// "My wars", ordered. Within a rank, the war whose world was frozen most
/// recently comes first — that is the one the player was last in — and a war
/// with no snapshot at all sorts last within its rank rather than first, which
/// is what reading its absence as "no older than anything" would do. (The `-1`
/// is the honest spelling of that, not a behavioural difference from `0`: unix
/// seconds are never negative, so only a sentinel at the TOP of the range —
/// "never frozen, therefore newest" — actually reorders the list.) Ties break
/// on id so the list does not reshuffle between ticks.
export function sortMyWars(wars: WarRow[]): WarRow[] {
    return [...wars].sort((a, b) => {
        const r = myWarRank(a) - myWarRank(b);
        if (r !== 0) return r;
        const fa = a.war.frozen_at ?? -1;
        const fb = b.war.frozen_at ?? -1;
        if (fa !== fb) return fb - fa;
        return a.id - b.id;
    });
}

/// The line that says what is YOURS in this war — the one sentence the war
/// browser could not say before task 4c.
///
/// Three facts, in the order a returning player asks for them: which side is
/// mine, how long I have been gone, and how much world is waiting. The frame
/// is quoted as sim time by `formatFrozenFrame` for the same reason the card
/// does it — a player has no intuition for "frame 226 800".
///
/// Returns '' for a war this account is not enlisted in, so it renders on
/// exactly the rows "My wars" holds and on those rows in every filter.
export function formatYourWar(row: WarRow): string {
    if (!(row.enlisted ?? row.returning)) return '';
    const parts: string[] = [];
    // A superseded seat is stated first and stated plainly: the account still
    // has a history here, but the seat it remembers is gone, and a card that
    // said "Your side: Union" next to a Fight button that seats them somewhere
    // else would be lying about the one thing this line exists to tell them.
    if (row.seat === 'superseded') {
        parts.push('your old seat here no longer exists — the sides were ' +
                   're-drawn, and a join gives you a new one');
    } else if (row.mySide) {
        parts.push(`your side: ${factionLabel(row.mySide)}`);
    }
    if (row.awaySec !== undefined && row.awaySec >= 90)
        parts.push(`away ${formatAway(row.awaySec)}`);
    // The frozen frame, on a war that is not running. On a LIVE war the card's
    // own detail line already carries the current frame, and `frozen_frame`
    // there is the last durable point — quoting it as "waiting for you" would
    // describe a war that is being played as one that is parked.
    if (!row.war.live && row.war.frozen_frame !== undefined && row.war.frozen_frame > 0)
        parts.push(`${formatFrozenFrame(row.war.frozen_frame)} waiting for you`);
    if (parts.length === 0) return '';
    return parts.join(' · ');
}

/// How long "away" was, in the coarsest unit that is still true. The same
/// wording the digest heading uses (`war-digest.ts`), duplicated in neither
/// direction: this module owns the card's own line and imports nothing from
/// the digest, so the two spell one rule once each. Kept in step by a test
/// that asserts both against the same seconds.
function formatAway(sec: number): string {
    const mins = Math.floor(sec / 60);
    if (mins < 60) return `${mins} minutes`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs} hours`;
    return `${Math.floor(hrs / 24)} days`;
}

/// Title-case a faction key for display. The keys are lowercased by the
/// engine's `SideParser::StringToLower(name)` derivation (task 0), so there is
/// no cased spelling to recover — only the key.
export function factionLabel(key: string): string {
    if (!key) return '';
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/// "Compact 2/8" — and "Compact 2/8 (1 online)" when the war is live and the
/// two numbers differ, which is the case a player has to be able to see: a
/// side can be full of people who are not there.
/// `capacity` is the war-level fallback; a side that states its own wins, and
/// an unlimited side shows a bare count because there is no denominator to
/// print (task 7 — sides of one war are no longer the same size).
export function formatSide(side: WarSide, capacity: number, live: boolean): string {
    const cap = side.unlimited ? 0 : (side.capacity ?? capacity);
    const seats = cap > 0 ? `${side.bound}/${cap}` : `${side.bound}`;
    let s = `${factionLabel(side.faction)} ${seats}`;
    const extras: string[] = [];
    if (live && side.online !== undefined && side.online !== side.bound)
        extras.push(`${side.online} online`);
    if (live && side.ais) extras.push(`${side.ais} AI`);
    if (extras.length) s += ` (${extras.join(', ')})`;
    return s;
}

/// "up 14m" / "up 3h 02m". Coarse on purpose: the browser is answering "has
/// this been going a while", not timing anything.
export function formatUptime(sec: number): string {
    if (sec < 60) return 'just started';
    const mins = Math.floor(sec / 60);
    if (mins < 60) return `up ${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `up ${hrs}h ${String(mins % 60).padStart(2, '0')}m`;
}

/// The war's front, in one clause: "11 regions · 2 contested". Empty when the
/// map publishes no regions at all (not every map has the gadget) rather than
/// printing a row of zeroes that reads like a stalled war.
export function formatControl(war: WarInfo): string {
    const c = war.control;
    if (!c || c.total === 0) return '';
    const parts = [`${c.total} regions`];
    if (c.contested > 0) parts.push(`${c.contested} contested`);
    if (c.neutral > 0) parts.push(`${c.neutral} neutral`);
    return parts.join(' · ');
}

/// "3h ago" / "just now". `now` is injected rather than read from the clock so
/// the caller owns the tick and a test owns the answer.
export function formatAgo(unixSec: number, nowSec: number): string {
    const d = Math.max(0, Math.floor(nowSec - unixSec));
    if (d < 60) return 'just now';
    const mins = Math.floor(d / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

/// How much world a frozen frame is, said as sim time rather than as a frame
/// number. A player has no intuition for "frame 226 800"; "2h 06m of war" is
/// the same fact in the units they played it in. GAME_SPEED is 30.
export function formatFrozenFrame(frame: number): string {
    const sec = Math.max(0, Math.floor(frame / 30));
    if (sec < 60) return `${sec}s of war`;
    const mins = Math.floor(sec / 60);
    if (mins < 60) return `${mins}m of war`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m of war`;
}

/// The badge in the card's header. One word per `WarState`, plus the CSS class
/// that colours it.
///
/// The three no-process states are deliberately NOT one grey "Idle": a
/// hibernated war is a promise, a crashed one lost its tail, and an
/// unresumable one is going back to frame 0. Those are three different things
/// to walk into, and the old badge said the same word for all three.
export function warStateBadge(war: WarInfo): { label: string; cls: string } {
    switch (war.state) {
        case 'live':        return { label: 'Live',        cls: 'war-badge-live' };
        case 'resuming':    return { label: 'Resuming',    cls: 'war-badge-resuming' };
        case 'hibernated':  return { label: 'Hibernated',  cls: 'war-badge-idle' };
        case 'crashed':     return { label: 'Interrupted', cls: 'war-badge-crashed' };
        case 'unresumable': return { label: 'Restarting',  cls: 'war-badge-crashed' };
        case 'fresh':       return { label: 'Not started', cls: 'war-badge-idle' };
        default:
            // `not_a_war`, or a lobby that publishes no `state` at all. Fall
            // back to the one bit that has always been there.
            return war.live
                ? { label: 'Live', cls: 'war-badge-live' }
                : { label: 'Idle', cls: 'war-badge-idle' };
    }
}

/// What a join would do to this war, in one clause. Empty when the war is
/// live (the live half of `formatWarDetail` already says what is happening).
export function formatWarStatus(war: WarInfo, nowSec: number): string {
    const frozen = war.frozen_frame !== undefined && war.frozen_frame >= 0
        ? formatFrozenFrame(war.frozen_frame)
        : '';
    const when = war.frozen_at ? ` (${formatAgo(war.frozen_at, nowSec)})` : '';
    switch (war.state) {
        case 'live':
            return '';
        case 'resuming':
            // The state E5's second joiner waits on. Named, because a card
            // that said "no server running" here would invite a second spawn.
            return frozen
                ? `resuming — bringing back ${frozen}${when}`
                : 'resuming — the server is starting';
        case 'hibernated':
            return frozen
                ? `hibernated with ${frozen}${when} — a join brings it back`
                : 'hibernated — a join brings it back';
        case 'crashed':
            // Never "hibernated": there was no exit checkpoint, so the newest
            // snapshot is older than the world was. Saying which frames survive
            // is the whole point — a player is about to lose the rest.
            return frozen
                ? `the server stopped without saving — a join resumes from ` +
                  `${frozen}${when}, and anything after it is lost`
                : 'the server stopped without saving — a join restarts the war';
        case 'unresumable':
            return frozen
                ? `${frozen}${when} is frozen in the store, but ${formatResumeRefusal(war)}`
                : formatResumeRefusal(war);
        case 'fresh':
            return 'never run — a join starts it';
        default:
            // A lobby with no `state` field, or a room that is not a war.
            return war.live ? '' : 'no server running — a join restarts it';
    }
}

/// The sentence that tells a player their frozen world is going back to frame
/// 0, and why.
///
/// Deliberately NOT `resume_blocked_reason` itself: that string is written for
/// an operator and names two 16-hex engine stamps, which on a card is noise
/// wrapped around the one fact that matters. The raw reason is not dropped —
/// `renderWarList` hangs it on the row's `title`, so the operator sentence is
/// one hover away and the log line and the card still agree.
export function formatResumeRefusal(war: WarInfo): string {
    switch (war.resume_eligibility) {
        case 'engine_changed':
            return 'the game has been updated since — this war restarts at the beginning';
        case 'map_changed':
            return 'the map has changed since — this war restarts at the beginning';
        default:
            return 'it cannot be loaded — this war restarts at the beginning';
    }
}

/// The line under a war's name: map, every side's population, spectators,
/// uptime. Sides always; the rest only when a server is publishing.
export function formatWarDetail(row: WarRow, nowSec: number): string {
    const parts: string[] = [];
    if (row.mapId) parts.push(row.mapId);
    for (const side of row.war.sides)
        parts.push(formatSide(side, row.war.capacity_per_side, row.war.live));
    if (row.war.live) {
        if (row.war.spectators) parts.push(`${row.war.spectators} watching`);
        if (row.war.uptime_sec !== undefined)
            parts.push(formatUptime(row.war.uptime_sec));
    }
    // Said plainly rather than omitted. A war with no server is a real state
    // that a join RESUMES (task 3) — a card that just goes quiet reads as a
    // broken row.
    const status = formatWarStatus(row.war, nowSec);
    if (status) parts.push(status);
    return parts.join(' · ');
}

/// The answer from `POST /api/wars/deploy` (§6, task 7). Field names are the
/// wire's; the outcome vocabulary is `DeployOutcomeToString`'s.
export interface DeployResult {
    outcome: 'join' | 'return' | 'seed' | 'no_faction';
    faction: string;
    /// How far my side is outnumbered in the war it picked, 0 when it is not.
    underdog_by: number;
    room_id?: number;
    room_name?: string;
}

/// What Deploy tells the player it did, and why.
///
/// The *why* is not decoration. Deploy moves a player into a war they did not
/// pick, and a recommendation that does not say what it optimised for reads as
/// a random one — especially when it declines to send them to the busiest war
/// on the list because their side there is outnumbered by nobody.
export function formatDeploy(d: DeployResult): string {
    const where = d.room_name ? `“${d.room_name}”` : 'a war';
    switch (d.outcome) {
        case 'return':
            return `You already hold a seat in ${where} — returning to it.`;
        case 'join':
            return d.underdog_by > 0
                ? `Deploying to ${where}: your side is outnumbered there by ` +
                  `${d.underdog_by}, and needs you most.`
                : `Deploying to ${where}.`;
        case 'seed':
            // Not a refusal, and it must not read as one: every side for this
            // faction is taken, so the answer is a new world rather than a
            // place in a line (WarDeploy.h's no-queue design call).
            return 'Every war fielding your faction is full — create a new ' +
                   'war and its sides will be sized for you.';
        case 'no_faction':
            return 'Your account has no faction, so no side can be chosen ' +
                   'for it. You can still watch any war.';
    }
}

/// The label on the primary button. A war you already hold a seat in is a
/// rejoin, and that is the word a returning player is looking for.
export function fightLabel(row: WarRow): string {
    return row.returning ? 'Rejoin' : 'Fight';
}
