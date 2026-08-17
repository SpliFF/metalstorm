import { describe, it, expect } from 'vitest';
import {
    friendActions, friendFactionLabel, friendStatusLine, friendWarRooms,
    formatFriendJoin, formatFriendsHere, friendJoinNeedsConfirm, pendingRequestCount,
    sortFriends,
    type FriendJoinResult, type FriendRow,
} from './friends';

function row(over: Partial<FriendRow> & { username: string }): FriendRow {
    return {
        account_id: 1, edge: 'mutual', since: 0, presence: 'offline', ...over,
    };
}

describe('friend row ordering', () => {
    it('puts an unanswered incoming request above a friend in a war', () => {
        // The one row that is asking the player a question. A list that sorts
        // purely on presence buries it under every fought-in war.
        const sorted = sortFriends([
            row({ username: 'fighter', presence: 'fighting', war_room_id: 7 }),
            row({ username: 'asker', edge: 'incoming', presence: 'unknown' }),
        ]);
        expect(sorted.map(f => f.username)).toEqual(['asker', 'fighter']);
    });

    it('orders mutual friends by how reachable they are', () => {
        const sorted = sortFriends([
            row({ username: 'gone' }),
            row({ username: 'lobby', presence: 'online' }),
            row({ username: 'war', presence: 'fighting', war_room_id: 3 }),
            row({ username: 'room', presence: 'staging' }),
        ]);
        expect(sorted.map(f => f.username)).toEqual(['war', 'room', 'lobby', 'gone']);
    });

    it('sinks an outgoing request below even an offline friend', () => {
        const sorted = sortFriends([
            row({ username: 'pending', edge: 'outgoing', presence: 'unknown' }),
            row({ username: 'offline-friend' }),
        ]);
        expect(sorted.map(f => f.username)).toEqual(['offline-friend', 'pending']);
    });

    it('is stable across polls — ties break on name, not on arrival order', () => {
        const a = sortFriends([row({ username: 'bo' }), row({ username: 'al' })]);
        const b = sortFriends([row({ username: 'al' }), row({ username: 'bo' })]);
        expect(a.map(f => f.username)).toEqual(b.map(f => f.username));
    });

    it('does not mutate the list it was handed', () => {
        const rows = [row({ username: 'b' }), row({ username: 'a' })];
        sortFriends(rows);
        expect(rows.map(f => f.username)).toEqual(['b', 'a']);
    });
});

describe('a pending edge publishes no presence', () => {
    // The client half of the server's rule: presence is for MUTUAL friends
    // only, and `unknown` is not a synonym for offline. Rendering "Offline" on
    // an unanswered request republishes exactly the tracking the route refused
    // to hand out.
    it('renders the request, not a presence word, in both directions', () => {
        expect(friendStatusLine(row({ username: 'x', edge: 'incoming', presence: 'unknown' })))
            .toBe('wants to be your friend');
        expect(friendStatusLine(row({ username: 'x', edge: 'outgoing', presence: 'unknown' })))
            .toBe('friend request sent — not answered yet');
    });

    it('never says offline for a non-mutual row, even if the lobby did', () => {
        // A lobby that regressed and sent a real presence for a pending edge
        // must not be relayed: the client states the rule itself.
        for (const edge of ['incoming', 'outgoing'] as const) {
            const line = friendStatusLine(row({ username: 'x', edge, presence: 'online' }));
            expect(line).not.toMatch(/offline|lobby|fighting/);
        }
    });

    it('withholds the faction chip until the friendship is mutual', () => {
        expect(friendFactionLabel(row({ username: 'x', edge: 'incoming', faction: 'union' })))
            .toBe('');
        expect(friendFactionLabel(row({ username: 'x', faction: 'union' }))).toBe('Union');
    });

    it('says "presence unknown" rather than offline for a mutual row with no answer', () => {
        expect(friendStatusLine(row({ username: 'x', presence: 'unknown' })))
            .toBe('presence unknown');
    });
});

describe('the status line names the war', () => {
    it('quotes the war a friend is fighting in', () => {
        expect(friendStatusLine(row({
            username: 'x', presence: 'fighting', war_room_id: 4, war_name: 'Meridian Basin',
        }))).toBe('fighting in Meridian Basin');
    });

    it('still says fighting when the room is not in this lobby process', () => {
        // `war_name` comes from `rooms.GetRoom`, which can miss; the binding
        // that says they are fighting cannot.
        expect(friendStatusLine(row({ username: 'x', presence: 'fighting', war_room_id: 4 })))
            .toBe('fighting in a war');
    });
});

describe('the actions a row offers', () => {
    it('offers accept and decline on an incoming request', () => {
        const a = friendActions(row({ username: 'x', edge: 'incoming', presence: 'unknown' }));
        expect(a.map(x => x.kind)).toEqual(['accept', 'decline']);
        expect(a[0].primary).toBe(true);
    });

    it('offers only cancel on an outgoing one', () => {
        expect(friendActions(row({ username: 'x', edge: 'outgoing', presence: 'unknown' }))
            .map(a => a.kind)).toEqual(['cancel']);
    });

    it('offers Join war only to a friend who is actually in one', () => {
        // D41's rule: a button whose only possible reply is "this does nothing
        // for you" is worse than no button — and `not_in_a_war` is the only
        // answer the route can give for every other presence.
        expect(friendActions(row({ username: 'x', presence: 'fighting', war_room_id: 2 }))
            .map(a => a.kind)).toEqual(['join', 'remove']);
        for (const presence of ['staging', 'online', 'offline'] as const) {
            expect(friendActions(row({ username: 'x', presence })).map(a => a.kind))
                .toEqual(['remove']);
        }
    });

    it('gives a stranger nothing to click', () => {
        expect(friendActions(row({ username: 'x', edge: 'none', presence: 'unknown' })))
            .toEqual([]);
    });
});

describe('pendingRequestCount', () => {
    it('counts only what is waiting on THIS player', () => {
        expect(pendingRequestCount([
            row({ username: 'a', edge: 'incoming', presence: 'unknown' }),
            row({ username: 'b', edge: 'outgoing', presence: 'unknown' }),
            row({ username: 'c', presence: 'fighting', war_room_id: 1 }),
        ])).toBe(1);
    });
});

describe('the "Friends here" input', () => {
    it('collects the war rooms mutual friends are fighting in', () => {
        expect([...friendWarRooms([
            row({ username: 'a', presence: 'fighting', war_room_id: 5 }),
            row({ username: 'b', presence: 'fighting', war_room_id: 5 }),
            row({ username: 'c', presence: 'fighting', war_room_id: 9 }),
        ])]).toEqual([5, 9]);
    });

    it('ignores a friend who is merely STAGING in a war\'s room', () => {
        // `staging` is lobby-room membership; `fighting` is a sim holding the
        // account on a side. A filter built on the former empties itself the
        // moment the player looks at it.
        expect(friendWarRooms([
            row({ username: 'a', presence: 'staging', war_room_id: 5 }),
        ]).size).toBe(0);
    });

    it('ignores a pending edge that somehow carries a war', () => {
        expect(friendWarRooms([
            row({ username: 'a', edge: 'incoming', presence: 'fighting', war_room_id: 5 }),
        ]).size).toBe(0);
    });
});

describe('formatFriendsHere', () => {
    const inWar = (name: string, id: number) =>
        row({ username: name, presence: 'fighting', war_room_id: id });

    it('is empty for a war with no friend in it — so it renders on no other row', () => {
        expect(formatFriendsHere([inWar('bob', 5)], 6)).toBe('');
    });

    it('names one friend, and both of two', () => {
        expect(formatFriendsHere([inWar('bob', 5)], 5)).toBe('bob is fighting here');
        expect(formatFriendsHere([inWar('kez', 5), inWar('bob', 5)], 5))
            .toBe('bob and kez are fighting here');
    });

    it('counts the tail past two rather than growing the card', () => {
        const rows = ['al', 'bo', 'cy', 'di'].map(n => inWar(n, 5));
        expect(formatFriendsHere(rows, 5)).toBe('al, bo and 2 more friends are fighting here');
        expect(formatFriendsHere(rows.slice(0, 3), 5))
            .toBe('al, bo and 1 more friend is fighting here');
    });
});

describe('formatFriendJoin', () => {
    const r = (over: Partial<FriendJoinResult>): FriendJoinResult =>
        ({ outcome: 'same_side', friend: 'bob', ...over });

    it('seats and says you fight beside them', () => {
        const out = formatFriendJoin(r({ outcome: 'same_side', room_name: 'Meridian' }));
        expect(out.seats).toBe(true);
        expect(out.text).toMatch(/beside bob/);
    });

    it('seats on the opposing side and SAYS SO before the map loads', () => {
        // The reason the route has five outcomes instead of an `ok` boolean:
        // the click succeeds and the player must know they will be fighting
        // their friend, not standing beside them.
        const out = formatFriendJoin(r({ outcome: 'opposing_side', room_name: 'Meridian' }));
        expect(out.seats).toBe(true);
        expect(out.text).toMatch(/AGAINST bob/);
        expect(out.text).not.toMatch(/beside/);
    });

    it('refuses without seating, and each refusal names its own reason', () => {
        for (const [outcome, pattern] of [
            ['not_in_a_war', /not in a war/],
            ['faction_absent', /no side for your faction/],
            ['side_full', /full/],
            ['no_faction', /no faction/],
        ] as const) {
            const out = formatFriendJoin(r({ outcome }));
            expect(out.seats, outcome).toBe(false);
            expect(out.text, outcome).toMatch(pattern);
        }
    });

    it('makes the cross-faction join — and only that one — ask twice', () => {
        // Found in the browser: the warning was written into the message line
        // and the room screen replaced it in the same tick. A warning nobody
        // can read is not a warning, so `opposing_side` costs a second click
        // and nothing else does.
        expect(friendJoinNeedsConfirm('opposing_side')).toBe(true);
        for (const o of ['same_side', 'not_in_a_war', 'faction_absent',
                         'side_full', 'no_faction'] as const)
            expect(friendJoinNeedsConfirm(o), o).toBe(false);
    });

    it('falls back to a refusal on an outcome this client does not know', () => {
        // A client older than its lobby must not seat somebody off a word it
        // cannot read: an unknown outcome is not a licence to join.
        const out = formatFriendJoin(r({ outcome: 'something_new' as never }));
        expect(out.seats).toBe(false);
    });
});
