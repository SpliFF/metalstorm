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
    'finished' | 'unresumable';

/// `warresume::ToString(ResumeEligibility)`, verbatim.
export type ResumeEligibilityKey =
    'no_history' | 'resumable' | 'engine_changed' | 'map_changed' |
    'unknown_binary';

/// `WarDirector::WarStateToString`, verbatim — the war's META-lifecycle
/// (PLAN-metalstorm-wars.md §7), which is a different axis from `WarStateKey`
/// above: `state` says whether a PROCESS is serving the war, `phase` says
/// where the war is in its life. A hibernated war is an `active` war whose
/// process is a snapshot; an `archived` war is over whatever its process is.
///
/// PROPOSED server field (review 2026-09-10, war-surfaces): `roomToJson` does
/// not publish it yet — `/api/wars/deploy` already reads the Director row to
/// skip archived wars, so the browser lists wars Deploy refuses to send
/// anyone to. Every reader here treats an absent `phase` as "unknown", never
/// as "open".
export type WarPhaseKey =
    'seeding' | 'open' | 'active' | 'winding_down' | 'resolving' | 'archived';

/// One faction's escrowed force in this war (`WorldEscrow::EscrowJson`, the
/// fields the card needs). PROPOSED as `war.stakes.escrow[]` on the room row.
export interface WarEscrowStake {
    faction: string;
    transports: number;
    squads: number;
    /// `committed` | `engaged` | `settled`.
    state: string;
}

/// A filed claim on the POI this war is fought over (`world_poi_claims`).
/// PROPOSED as `war.stakes.claims[]` on the room row.
export interface WarClaimStake {
    faction: string;
    /// `open` | `won` | `lost` | `withdrawn` | `expired`.
    state: string;
}

/// What the world layer has riding on this battle. PROPOSED — see `WarInfo`.
export interface WarStakes {
    escrow?: WarEscrowStake[];
    claims?: WarClaimStake[];
}

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
    /// ── PROPOSED fields (not yet published by `roomToJson`) ────────────────
    /// The Director's meta-state. Absent = unknown; see `WarPhaseKey`.
    phase?: WarPhaseKey;
    /// The world POI this battle is fought over (`wars.poi_id`), so a card
    /// can hand the World screen a place rather than a room.
    poi_id?: string;
    /// Seconds until the next transport arrival the sim has scheduled
    /// (`game_transports`' next `arrival_frame` − current frame, over
    /// GAME_SPEED). Only meaningful on a live war.
    next_arrival_sec?: number;
    /// The world's stake in this battle.
    stakes?: WarStakes;
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
    'my-wars': 'My missions',
    'friends-here': 'Friends here',
    'all': 'All missions',
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
    if (!warAcceptsJoiners(war)) return false;
    const side = sideForFaction(war, faction);
    if (!side) return false;
    return side.unlimited === true || side.open > 0;
}

/// Is this war OVER — nothing left to fight for, only a result to read?
/// True for the three closing phases and for a process that reported the war
/// finished. A war with no `phase` and no `finished` state is not known to be
/// over, which is the only safe reading of silence.
export function warIsOver(war: WarInfo): boolean {
    return war.phase === 'winding_down' || war.phase === 'resolving' ||
           war.phase === 'archived' || war.state === 'finished';
}

/// Can a NEW fighter be seated here at all, before capacity is considered?
/// No while the Director is still seeding it (nothing to join yet — its own
/// comment says no token may be handed out) and no once it is over. Every
/// process state is joinable, including `unresumable` (a join restarts it)
/// and `crashed` (a join resumes what survived).
export function warAcceptsJoiners(war: WarInfo): boolean {
    if (war.phase === 'seeding') return false;
    return !warIsOver(war);
}

/// `friendRooms` is the set of war rooms a mutual friend is fighting in right
/// now (`friendWarRooms`, task 9a). Optional because every other filter is a
/// function of the rows alone, and a caller with no friends list — a lobby
/// older than the friends routes, or a fetch that failed — must get the same
/// answer it always did rather than an empty browser.
export function filterWars(
    wars: WarRow[], filter: WarFilter, faction: string,
    friendRooms?: ReadonlySet<number>,
    opts: { includeArchived?: boolean } = {},
): WarRow[] {
    // An archived war is history, not a destination (WarDeploy §7 makes the
    // same call). It stays in "My wars" — the player's own record is theirs
    // to read — and comes back everywhere else behind an explicit reveal.
    // Only `archived` is dropped: a war winding down or settling is still
    // something happening in the world, and still watchable.
    const wanted = opts.includeArchived || filter === 'my-wars'
        ? wars
        : wars.filter(w => w.war.phase !== 'archived');
    switch (filter) {
        case 'my-faction':
            // Wars my faction FIELDS A SIDE IN — not wars I can squeeze into.
            // A full war my faction is fighting is still my war to watch, and
            // hiding it would hide the thing that is happening in the world.
            return wanted.filter(w => !!sideForFaction(w.war, faction));
        case 'my-wars':
            // ENLISTMENT, not seating (task 4c). `returning` is the answer to
            // "would a join put you back on your team", and it goes false when
            // the war's sides stop seating your faction on the team your
            // binding records — at which point this list dropped the war a
            // player has a week of history in. The fallback keeps a client
            // ahead of its lobby working on the old bit.
            return sortMyWars(wanted.filter(w => w.enlisted ?? w.returning));
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
            return wanted.filter(w => friendRooms?.has(w.id) ?? false);
        case 'all':
            return wanted;
    }
}

/// How many wars a filter is hiding for being archived — the number the
/// reveal control shows, so "Show 3 archived" is a fact and not a guess.
export function archivedCount(wars: readonly WarRow[]): number {
    return wars.filter(w => w.war.phase === 'archived').length;
}

/// Where a war sits in "My wars". Lower sorts first.
///
/// The ordering is the whole reason this list is not just a filtered browser:
/// these are the player's OWN worlds, and the question they answer it with is
/// "which of mine needs me". A war being played right now outranks one that is
/// waiting, and a war that is waiting outranks one that never started.
function myWarRank(row: WarRow): number {
    // The Director's word outranks the process's: an archived war is over
    // whatever its last process said, and sorts below everything that is
    // not — including a `finished` war whose settlement is still being
    // written, which is the one thing a returning player is waiting on.
    if (row.war.phase === 'archived') return 7;
    switch (row.war.state) {
        case 'live':        return 0;
        case 'resuming':    return 1;
        case 'crashed':     return 2;   // ahead of a clean freeze: it lost frames
        case 'hibernated':  return 3;
        case 'unresumable': return 4;
        case 'fresh':       return 5;
        // A war that is OVER needs nothing from its player, so it sorts below
        // every war that does — but still inside "my wars", because it is
        // theirs and its result is what they came back to read.
        case 'finished':    return 6;
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
    if (sec < 60) return `${sec}s of mission`;
    const mins = Math.floor(sec / 60);
    if (mins < 60) return `${mins}m of mission`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m of mission`;
}

/// The badge in the card's header. One word per `WarState`, plus the CSS class
/// that colours it.
///
/// The three no-process states are deliberately NOT one grey "Idle": a
/// hibernated war is a promise, a crashed one lost its tail, and an
/// unresumable one is going back to frame 0. Those are three different things
/// to walk into, and the old badge said the same word for all three.
export function warStateBadge(war: WarInfo): { label: string; cls: string } {
    // The Director's phase outranks the process state wherever the two
    // disagree about whether there is a war to walk into: a `live` process on
    // an `archived` war is a server finishing its paperwork, not a battle.
    switch (war.phase) {
        case 'seeding':      return { label: 'Seeding',   cls: 'war-badge-resuming' };
        case 'winding_down': return { label: 'Ending',    cls: 'war-badge-resuming' };
        case 'resolving':    return { label: 'Settling',  cls: 'war-badge-resuming' };
        case 'archived':     return { label: 'Archived',  cls: 'war-badge-idle' };
        default: break;
    }
    switch (war.state) {
        case 'live':        return { label: 'Live',        cls: 'war-badge-live' };
        case 'resuming':    return { label: 'Resuming',    cls: 'war-badge-resuming' };
        case 'hibernated':  return { label: 'Hibernated',  cls: 'war-badge-idle' };
        case 'crashed':     return { label: 'Interrupted', cls: 'war-badge-crashed' };
        case 'unresumable': return { label: 'Restarting',  cls: 'war-badge-crashed' };
        case 'fresh':       return { label: 'Not started', cls: 'war-badge-idle' };
        case 'finished':    return { label: 'Ended',       cls: 'war-badge-idle' };
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
    // The meta-lifecycle first: none of the process sentences below is true
    // of a war that is being seeded or is over. "a join brings it back" on an
    // archived war is a promise nothing can keep.
    switch (war.phase) {
        case 'seeding':
            return 'being seeded — the server is being prepared, and a seat is not yet on offer';
        case 'winding_down':
            return 'the mission is ending — no new fighters are seated, but it can still be watched';
        case 'resolving':
            return 'combat is over — the settlement is being written';
        case 'archived':
            return 'archived — its settlement is in the mission digest';
        default: break;
    }
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
                : 'the server stopped without saving — a join restarts the mission';
        case 'unresumable':
            return frozen
                ? `${frozen}${when} is frozen in the store, but ${formatResumeRefusal(war)}`
                : formatResumeRefusal(war);
        case 'fresh':
            return 'never run — a join starts it';
        case 'finished':
            // The war ended. Not "the server stopped without saving", which is
            // what this card said for every correctly-finished war before D4 —
            // the server stopped because there was nothing left to serve.
            return 'this mission is over — its result is in your mission digest';
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
            return 'the game has been updated since — this mission restarts at the beginning';
        case 'map_changed':
            return 'the map has changed since — this mission restarts at the beginning';
        default:
            return 'it cannot be loaded — this mission restarts at the beginning';
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
    /// §5's rejoin fall-through: the account holds a seat somewhere, and that
    /// war could not take it back, so Deploy sent it elsewhere.
    rejoin_fell_through?: boolean;
    /// True when `room_id` is a war this call CREATED (PLAN-metalstorm-wars
    /// §4, demand-driven seeding). The outcome stays `seed`.
    seeded?: boolean;
    /// Why seeding failed, when it did. The outcome is still `seed` and there
    /// is no `room_id` — the player has to be told there is nowhere to go.
    seed_error?: string;
    /// `SlotReserveOutcomeToString`: whether a seat is HELD for this account
    /// in `room_id`. A war handed over without a held seat must be visible as
    /// such, or the join walks into the refusal the reservation prevents.
    reservation?: 'granted' | 'renewed' | 'already_seated' | 'side_full' |
                  'no_such_side' | 'error';
    reservation_expires_in?: number;
    /// The Director's underdog flag for my side there.
    incentivised?: boolean;
}

/// Does this answer name a war the account can walk into right now?
///
/// The room id alone is not enough: the server reports the reservation
/// "whatever it said", and `side_full` / `no_such_side` beside a room id mean
/// "here is the war, and you have no seat in it". An absent reservation is an
/// older lobby that never reserved, and its join was always best-effort.
export function deployIsEnterable(d: DeployResult): boolean {
    if (!d.room_id) return false;
    if (d.outcome === 'no_faction') return false;
    return d.reservation === undefined ||
           d.reservation === 'granted' || d.reservation === 'renewed' ||
           d.reservation === 'already_seated';
}

/// What Deploy tells the player it did, and why.
///
/// The *why* is not decoration. Deploy moves a player into a war they did not
/// pick, and a recommendation that does not say what it optimised for reads as
/// a random one — especially when it declines to send them to the busiest war
/// on the list because their side there is outnumbered by nobody.
export function formatDeploy(d: DeployResult): string {
    const where = d.room_name ? `“${d.room_name}”` : 'a mission';
    // The seat, said when it is NOT held: a player sent to a war without one
    // arrives as a watcher, and the sentence that sent them must say so.
    const unheld = d.room_id && !deployIsEnterable(d)
        ? ' No seat could be held for you there — you would arrive watching.'
        : '';
    const held = d.reservation_expires_in && deployIsEnterable(d)
        ? ` Your seat is held for ${Math.max(1, Math.round(d.reservation_expires_in / 60))} min.`
        : '';
    switch (d.outcome) {
        case 'return':
            return `You already hold a seat in ${where} — returning to it.${unheld}`;
        case 'join': {
            // The fall-through comes first: to the veteran it happens to, being
            // sent past their own front reads as a bug unless it is named.
            const why = d.rejoin_fell_through
                ? 'Your own mission could not seat you back, so: '
                : '';
            const base = d.underdog_by > 0
                ? `deploying to ${where}: your side is outnumbered there by ` +
                  `${d.underdog_by}, and needs you most.`
                : `deploying to ${where}.`;
            const sentence = why + base;
            return sentence.charAt(0).toUpperCase() + sentence.slice(1) + held + unheld;
        }
        case 'seed':
            // Three readings of one outcome. Seeding SUCCEEDED and there is a
            // war to point at (the common case since demand-driven seeding —
            // the old handler opened the Create Game form here and never
            // joined the war the server had just built); seeding failed and
            // said why; or an older lobby that never seeded, where the honest
            // answer is the Create Game form.
            if (d.room_id)
                return `Every mission fielding your faction was full, so a new one ` +
                       `was seeded for you: ${where}.${held}${unheld}`;
            if (d.seed_error)
                return `Every mission fielding your faction is full, and a new one ` +
                       `could not be seeded (${d.seed_error}). Pick a mission to ` +
                       `watch, or create one.`;
            return 'Every mission fielding your faction is full — create a new ' +
                   'mission and its sides will be sized for you.';
        case 'no_faction':
            return 'Your account has no faction, so no side can be chosen ' +
                   'for it. You can still watch any mission.';
    }
}

/// The label on the primary button. A war you already hold a seat in is a
/// rejoin, and that is the word a returning player is looking for.
export function fightLabel(row: WarRow): string {
    return row.returning ? 'Rejoin' : 'Fight';
}

/// The card's primary control, decided in one place.
///
/// `fight`/`rejoin` are seats; `watch` is the only offer on a war that is
/// over or not yet seeded, where a Fight button — even a disabled one — would
/// advertise a seat that no longer exists. `why` is the tooltip on a disabled
/// button: a refusal the player can walk into is worse than a control that
/// is not there (D41), and a control that is there but dead needs its reason.
export interface WarPrimaryAction {
    kind: 'fight' | 'rejoin' | 'watch';
    label: string;
    enabled: boolean;
    why: string;
}

export function primaryAction(row: WarRow, faction: string): WarPrimaryAction {
    if (!warAcceptsJoiners(row.war)) {
        return {
            kind: 'watch', label: 'Watch', enabled: true,
            why: row.war.phase === 'seeding'
                ? 'This mission is still being seeded.'
                : 'This mission is over — it can be watched, not joined.',
        };
    }
    if (row.returning)
        return { kind: 'rejoin', label: 'Rejoin', enabled: true, why: '' };
    if (!faction)
        return { kind: 'fight', label: 'Fight', enabled: false,
                 why: 'Your account has no faction, so it has no side here.' };
    const side = sideForFaction(row.war, faction);
    if (!side)
        return { kind: 'fight', label: 'Fight', enabled: false,
                 why: `${factionLabel(faction)} fields no side in this mission.` };
    if (!(side.unlimited === true || side.open > 0))
        return { kind: 'fight', label: 'Fight', enabled: false,
                 why: `Your side is full (${side.bound}/${side.capacity ?? row.war.capacity_per_side}).` };
    return { kind: 'fight', label: 'Fight', enabled: true, why: '' };
}

// ── The summary card and its drawer (drill-down, 2026-08-29 directive) ──────
//
// A war row used to be a paragraph: map, every side's population, the front,
// the digest, the preview, the friends line, all at once, on every row. The
// directive is that the list stays out of the way — a card says what a
// scanning player needs to pick a row, and the click says the rest. The two
// models below are what `lobby-ui` renders; every line on them is derived
// here so it can be asserted without a DOM.

/// Seconds → "in 2m" / "arriving now". Coarse above a minute.
export function formatEta(sec: number): string {
    if (sec <= 0) return 'arriving now';
    if (sec < 60) return `in ${Math.floor(sec)}s`;
    const mins = Math.floor(sec / 60);
    if (mins < 60) return `in ${mins}m`;
    return `in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/// One clause for what MY faction has riding on this war, or '' when the
/// lobby publishes no stakes (every lobby today) or my faction has none.
export function formatMyStake(war: WarInfo, faction: string): string {
    if (!faction || !war.stakes) return '';
    const parts: string[] = [];
    const escrow = (war.stakes.escrow ?? []).filter(e => e.faction === faction);
    const transports = escrow.reduce((n, e) => n + (e.transports || 0), 0);
    const squads = escrow.reduce((n, e) => n + (e.squads || 0), 0);
    if (transports > 0 || squads > 0) {
        const bits: string[] = [];
        if (squads > 0) bits.push(`${squads} squad${squads === 1 ? '' : 's'}`);
        if (transports > 0) bits.push(`${transports} transport${transports === 1 ? '' : 's'}`);
        parts.push(`${bits.join(' on ')} in escrow`);
    }
    const claims = (war.stakes.claims ?? []).filter(c => c.faction === faction && c.state === 'open');
    if (claims.length > 0) parts.push('a claim on the ground');
    return parts.join(' · ');
}

/// "Compact 2/8 vs Union 1/8" — the sides in one clause, seats only.
export function formatSidesLine(war: WarInfo): string {
    return war.sides.map(s => formatSide(s, war.capacity_per_side, false)).join(' vs ');
}

/// "3 seated · 2 online · 1 AI" — the war's population as one number per
/// fact, summed over sides. Online/AI only while a server publishes them.
export function formatSeated(war: WarInfo): string {
    const bound = war.sides.reduce((n, s) => n + s.bound, 0);
    const parts = [`${bound} seated`];
    if (war.live) {
        const online = war.sides.reduce((n, s) => n + (s.online ?? 0), 0);
        const ais = war.sides.reduce((n, s) => n + (s.ais ?? 0), 0);
        if (online !== bound) parts.push(`${online} online`);
        if (ais > 0) parts.push(`${ais} AI`);
        if (war.spectators) parts.push(`${war.spectators} watching`);
    }
    return parts.join(' · ');
}

export interface WarCardModel {
    id: number;
    title: string;
    mapId: string;
    badge: { label: string; cls: string };
    /// "Compact 2/8 vs Union 1/8".
    sides: string;
    /// The population clause.
    seated: string;
    /// "next arrival in 2m" — '' unless the lobby publishes the ETA.
    eta: string;
    /// "your side: Union · away 3 hours" — '' for a war that is not mine.
    yours: string;
    /// Whether `yours` is bad news (a superseded seat).
    yoursLost: boolean;
    /// "2 squads on 1 transport in escrow" — '' without published stakes.
    stake: string;
    /// The one status clause that matters when the war is not simply live.
    status: string;
    /// The operator sentence behind a resume refusal, for a tooltip.
    statusTitle: string;
    action: WarPrimaryAction;
}

/// The summary card. Deliberately small: no digest, no front, no friends
/// line — those are the drawer's. The card answers "which row", not "what
/// happened".
export function warCardModel(
    row: WarRow, faction: string, nowSec: number,
): WarCardModel {
    return {
        id: row.id,
        title: row.name || `Mission ${row.id}`,
        mapId: row.mapId,
        badge: warStateBadge(row.war),
        sides: formatSidesLine(row.war),
        seated: formatSeated(row.war),
        eta: row.war.live && row.war.next_arrival_sec !== undefined
            ? `next arrival ${formatEta(row.war.next_arrival_sec)}` : '',
        yours: formatYourWar(row),
        yoursLost: row.seat === 'superseded',
        stake: formatMyStake(row.war, faction),
        status: formatWarStatus(row.war, nowSec),
        statusTitle: row.war.resume_blocked_reason ?? '',
        action: primaryAction(row, faction),
    };
}

/// The detail drawer: everything the card left out, in the order a player
/// deciding whether to walk in asks for it.
export interface WarDrawerModel {
    id: number;
    title: string;
    mapId: string;
    badge: { label: string; cls: string };
    /// Per-side lines, live population and all.
    sideLines: string[];
    /// "11 regions · 2 contested" or ''.
    front: string;
    /// "up 3h 02m" or ''.
    uptime: string;
    eta: string;
    /// Every faction's escrowed force, one line each; [] without stakes.
    stakeLines: string[];
    /// Open claims, one line each; [] without stakes.
    claimLines: string[];
    yours: string;
    yoursLost: boolean;
    status: string;
    statusTitle: string;
    action: WarPrimaryAction;
    /// The POI the World screen should select, or '' when the lobby does not
    /// publish one (the event still carries the room and map ids).
    poiId: string;
}

export function warDrawerModel(
    row: WarRow, faction: string, nowSec: number,
): WarDrawerModel {
    const war = row.war;
    const stakeLines = (war.stakes?.escrow ?? [])
        .filter(e => e.transports > 0 || e.squads > 0)
        .map(e => `${factionLabel(e.faction)}: ${e.squads} squad${e.squads === 1 ? '' : 's'}` +
                  ` on ${e.transports} transport${e.transports === 1 ? '' : 's'}` +
                  (e.state && e.state !== 'committed' ? ` (${e.state})` : ''));
    const claimLines = (war.stakes?.claims ?? [])
        .filter(c => c.state === 'open')
        .map(c => `${factionLabel(c.faction)} has filed a claim`);
    return {
        id: row.id,
        title: row.name || `Mission ${row.id}`,
        mapId: row.mapId,
        badge: warStateBadge(war),
        sideLines: war.sides.map(s => formatSide(s, war.capacity_per_side, war.live)),
        front: formatControl(war),
        uptime: war.live && war.uptime_sec !== undefined ? formatUptime(war.uptime_sec) : '',
        eta: war.live && war.next_arrival_sec !== undefined
            ? `next arrival ${formatEta(war.next_arrival_sec)}` : '',
        stakeLines,
        claimLines,
        yours: formatYourWar(row),
        yoursLost: row.seat === 'superseded',
        status: formatWarStatus(war, nowSec),
        statusTitle: war.resume_blocked_reason ?? '',
        action: primaryAction(row, faction),
        poiId: war.poi_id ?? '',
    };
}

/// The custom event a war surface dispatches when the player asks to see a
/// war on the World screen. Contract (docs/lobby-war-surfaces.md): dispatched
/// on `window`, cancelable, `detail: WorldFocusDetail`; a listener that
/// handles it calls `preventDefault()`. The dispatcher falls back to opening
/// the World screen bare when nobody does, so the link is never dead.
export const WORLD_FOCUS_EVENT = 'springrts:world-focus';

export interface WorldFocusDetail {
    roomId: number;
    mapId: string;
    /// '' when the lobby publishes no `poi_id`; a listener then resolves the
    /// POI by `warRoomId` on its own graph.
    poiId: string;
}

export function worldFocusDetail(row: WarRow): WorldFocusDetail {
    return { roomId: row.id, mapId: row.mapId, poiId: row.war.poi_id ?? '' };
}
