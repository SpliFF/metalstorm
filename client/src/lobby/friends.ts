/**
 * Friends panel — the client half of task 9a (PLAN-metalstorm-lobby.md §8).
 *
 * The server half landed as `1f88886514`: four routes
 * (`/api/friends/{list,add,remove,join}`), presence derived from three real
 * sources, and a join that *answers* instead of seating. This file is the
 * model behind the panel that reads them, kept pure and away from the DOM for
 * the same reason `replay-browser.ts` is — every interesting decision here is
 * about what an ABSENCE means, and those are worth asserting rather than
 * eyeballing.
 *
 * Two rules the server states and the client must not quietly undo:
 *
 *  1. **Presence belongs to mutual friends only.** A non-mutual row arrives as
 *     `presence: "unknown"`, and `unknown` is not a synonym for offline. A
 *     panel that renders the pending row as "Offline" republishes exactly the
 *     surveillance the server refused to hand out: "add them and watch when
 *     they log in". So an unanswered request renders the REQUEST, never a
 *     presence word.
 *  2. **`join` answers, it does not seat.** `/api/friends/join` names the war
 *     and the side; the ordinary `/api/rooms/join` does the seating. The one
 *     thing this layer owes the player is the sentence: on a cross-faction
 *     friend the click succeeds and puts you OPPOSITE them (§1b makes a
 *     faction permanent and §2.3 makes the side follow it), and a button that
 *     says "join Bob" and seats you against Bob is the most confusing control
 *     in the lobby.
 */

import { factionLabel } from './war-browser.js';

/// `FriendEdgeToString` (Friends.h), verbatim.
export type FriendEdgeKey = 'none' | 'outgoing' | 'incoming' | 'mutual';

/// `PresenceStateToString` (FriendPresence.h), verbatim, plus the `unknown`
/// the route substitutes for every non-mutual row.
export type PresenceKey = 'unknown' | 'offline' | 'online' | 'staging' | 'fighting';

/// One row of `POST /api/friends/list`. Everything past `edge` is optional
/// because the route omits rather than defaults: no faction key for an account
/// that never chose one, no war fields for a friend who is not in one, and no
/// `war_name` when the war's room is not in this lobby process.
export interface FriendRow {
    account_id: number;
    username: string;
    faction?: string;
    edge: FriendEdgeKey;
    /// Unix seconds the first of the two edges was written.
    since: number;
    presence: PresenceKey;
    war_room_id?: number;
    war_name?: string;
    team?: number;
}

/// What `/api/friends/join` replies. `room_id`/`team` are present only for the
/// two outcomes `FriendJoinSeats` accepts.
export interface FriendJoinResult {
    outcome: 'no_faction' | 'not_in_a_war' | 'faction_absent' | 'side_full'
           | 'same_side' | 'opposing_side';
    friend: string;
    room_id?: number;
    room_name?: string;
    team?: number;
    friend_team?: number;
}

/// The button a row offers, as the panel renders it. `kind` is the wiring key
/// and `label` the word; `primary` is the one action the row exists for.
export interface FriendAction {
    kind: 'accept' | 'decline' | 'cancel' | 'remove' | 'join';
    label: string;
    primary: boolean;
}

/// Ordering rank. Lower sorts first.
///
/// An INCOMING request outranks every friendship, online or not, because it is
/// the only row in the list that is asking the player a question — and a list
/// that buries it under a fought-in war means the answer never comes. After
/// that the list is presence-ordered (the friend in a war is the one you can
/// act on, then staging, then merely online), and an outgoing request sorts
/// last: it is a row the player already answered, and nobody else has.
function rank(f: FriendRow): number {
    if (f.edge === 'incoming') return 0;
    if (f.edge === 'outgoing') return 9;
    switch (f.presence) {
        case 'fighting': return 1;
        case 'staging':  return 2;
        case 'online':   return 3;
        default:         return 4;
    }
}

/// The list, in the order the panel shows it. Ties break on username so the
/// panel does not reshuffle between polls.
export function sortFriends(rows: FriendRow[]): FriendRow[] {
    return [...rows].sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        return a.username.localeCompare(b.username);
    });
}

/// The row's one line under the name.
///
/// For a mutual friend that is a presence sentence; for a pending edge it is
/// the request, in whichever direction it points (rule 1 above). `fighting`
/// names the war because "Fighting" alone answers a question nobody asked —
/// the whole point of the row is WHERE, so the join button has somewhere to
/// go.
export function friendStatusLine(f: FriendRow): string {
    if (f.edge === 'incoming') return 'wants to be your friend';
    if (f.edge === 'outgoing') return 'friend request sent — not answered yet';
    switch (f.presence) {
        case 'fighting':
            return f.war_name
                ? `fighting in ${f.war_name}`
                : 'fighting in a war';
        case 'staging': return 'in a room';
        case 'online':  return 'in the lobby';
        case 'offline': return 'offline';
        default:
            // A mutual row should never carry `unknown`, but a client one
            // version ahead of its lobby is a real state and "offline" would
            // be a claim we have no source for.
            return 'presence unknown';
    }
}

/// The faction chip, or '' for an account that never chose one (dev accounts
/// and pre-§1b guests). Never rendered for a non-mutual row: a faction is a
/// fact about a person, and a pending request has not agreed to publish one.
export function friendFactionLabel(f: FriendRow): string {
    if (f.edge !== 'mutual') return '';
    return factionLabel(f.faction ?? '');
}

/// The buttons this row gets.
///
/// Accept is `add` from the other end and decline is `remove` — the server has
/// one verb for each pair (Friends.h: "accept IS add"), so the panel must not
/// invent a third route for a word the UI happens to spell differently.
/// Join appears only on a friend who is actually in a war; on anyone else the
/// route can only answer `not_in_a_war`, and D41's rule stands — a button
/// whose only possible reply is "this does nothing for you" is worse than no
/// button.
export function friendActions(f: FriendRow): FriendAction[] {
    switch (f.edge) {
        case 'incoming':
            return [
                { kind: 'accept',  label: 'Accept',  primary: true },
                { kind: 'decline', label: 'Decline', primary: false },
            ];
        case 'outgoing':
            return [{ kind: 'cancel', label: 'Cancel', primary: false }];
        case 'mutual':
            return [
                ...(f.presence === 'fighting'
                    ? [{ kind: 'join' as const, label: 'Join war', primary: true }]
                    : []),
                { kind: 'remove', label: 'Remove', primary: false },
            ];
        default:
            return [];
    }
}

/// How many friends are waiting on an answer — the badge on the panel's
/// header, and the reason a collapsed panel is still worth opening.
export function pendingRequestCount(rows: FriendRow[]): number {
    return rows.filter(f => f.edge === 'incoming').length;
}

/// The war rooms a mutual friend is fighting in right now.
///
/// This is the whole input to the "Friends here" war filter (§4). Built from
/// `fighting` rows only: `staging` means a lobby ROOM, which may be a war's
/// room but is not the war holding them on a side, and a war browser row that
/// claimed a friend who is merely staging would empty itself the moment the
/// player looked.
export function friendWarRooms(rows: FriendRow[]): Set<number> {
    const out = new Set<number>();
    for (const f of rows) {
        if (f.edge !== 'mutual' || f.presence !== 'fighting') continue;
        if (f.war_room_id) out.add(f.war_room_id);
    }
    return out;
}

/// "Bob and Kez are fighting here" — the war card's own line, so the filter
/// has a visible reason on every row it keeps. Returns '' when no friend is in
/// this war, so it renders in every filter and marks nothing it should not.
export function formatFriendsHere(rows: FriendRow[], roomId: number): string {
    const names = rows
        .filter(f => f.edge === 'mutual' && f.presence === 'fighting'
                     && f.war_room_id === roomId)
        .map(f => f.username)
        .sort((a, b) => a.localeCompare(b));
    if (names.length === 0) return '';
    if (names.length === 1) return `${names[0]} is fighting here`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are fighting here`;
    return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more ` +
           `${names.length - 2 === 1 ? 'friend is' : 'friends are'} fighting here`;
}

/// Does this answer have to be CONFIRMED before the client seats the player?
///
/// Only `opposing_side`, and the reason is what the panel looked like without
/// it: the sentence was written into the message line and the room screen
/// replaced it in the same tick, so the one warning this feature exists to
/// give was on screen for a frame. "Told" has to mean "had the chance to stop"
/// — a click that says "join Bob" and drops the player onto the far side of
/// Bob's front line is exactly the confusion §8 asks us not to ship. Every
/// other outcome either refuses (nothing to confirm) or is what the player
/// asked for.
export function friendJoinNeedsConfirm(outcome: FriendJoinResult['outcome']): boolean {
    return outcome === 'opposing_side';
}

/// The sentence for a `/api/friends/join` answer, and whether the click should
/// go on to `/api/rooms/join`.
///
/// `opposing_side` is a SUCCESS that has to read like a warning: the join
/// happens, and the player has to know before the map loads that their friend
/// is on the other side of it.
export function formatFriendJoin(r: FriendJoinResult): { text: string; seats: boolean } {
    const who = r.friend;
    const war = r.room_name ? `“${r.room_name}”` : 'their war';
    switch (r.outcome) {
        case 'same_side':
            return { text: `Joining ${war} — you fight beside ${who}.`, seats: true };
        case 'opposing_side':
            return {
                text: `Joining ${war} — but your faction fights AGAINST ${who} ` +
                      `here. Your side is set by your faction and cannot be changed.`,
                seats: true,
            };
        case 'not_in_a_war':
            return { text: `${who} is not in a war right now.`, seats: false };
        case 'faction_absent':
            return {
                text: `${who}'s war fields no side for your faction, so there ` +
                      `is no seat in it for you — you can still watch.`,
                seats: false,
            };
        case 'side_full':
            return { text: `Your side of ${who}'s war is full.`, seats: false };
        case 'no_faction':
            return {
                text: `Your account has no faction, so it has no side to be ` +
                      `seated on — you can watch ${who}'s war.`,
                seats: false,
            };
        default:
            return { text: `Could not join ${who}.`, seats: false };
    }
}
