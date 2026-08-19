#include <doctest/doctest.h>

#include <sqlite3.h>

#include "Server/Chat.h"
#include "Server/SSETickets.h"

// PLAN-lobby.md §3, task 9b — the one chat service.
//
// What the blocks below are actually defending:
//
//   * **the target is canonical.** Two players in a PM must be provably in
//     ONE conversation, and an ally channel's team must come off the roster
//     rather than off the request — both are properties of the string the
//     server builds, so they are tested as string identities.
//   * **ignore is enforced on delivery AND on backfill.** A filter applied to
//     the live fan-out and not to the history is a filter you defeat by
//     reloading the page.
//   * **a room's channels die with the room.** Room ids are reused
//     (RoomManager::DeleteRoomFromDb's own comment), so an inherited chat log
//     is not a stale row, it is the previous war's conversation appearing in
//     the next one's scrollback.
//   * **flood control is a state machine with a clock**, so it is told the
//     time; every rung of §3.4's "drop + warn, repeat = timed mute" is a
//     boundary rather than a sleep.

namespace {

struct TestDb {
    sqlite3* db = nullptr;
    TestDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        Chat::EnsureTables(db);
    }
    ~TestDb() { sqlite3_close(db); }

    int64_t say(ChatScope scope, const std::string& target, int64_t from,
                const std::string& text, int64_t ts = 1000) {
        return Chat::Append(db, scope, target, from, "user" + std::to_string(from),
                            text, ts);
    }

    int count(const char* where) {
        std::string sql = std::string("SELECT COUNT(*) FROM chat_messages WHERE ") + where;
        sqlite3_stmt* s = nullptr;
        REQUIRE(sqlite3_prepare_v2(db, sql.c_str(), -1, &s, nullptr) == SQLITE_OK);
        int n = 0;
        if (sqlite3_step(s) == SQLITE_ROW) n = sqlite3_column_int(s, 0);
        sqlite3_finalize(s);
        return n;
    }
};

}  // namespace

// ── Canonical targets ──────────────────────────────────────────────────────

TEST_CASE("task 9b: a conversation has ONE name, whichever end asks") {
    // The whole point of PmTarget. If the two ends could file under different
    // strings, both players would see a working chat window and neither would
    // be reading the other's.
    CHECK(Chat::PmTarget(4, 9) == Chat::PmTarget(9, 4));
    CHECK(Chat::PmTarget(4, 9) == "4:9");

    const auto p = Chat::PmParticipants(Chat::PmTarget(9, 4));
    CHECK(p.first == 4);
    CHECK(p.second == 9);

    // Not a PM target: the delivery path must get {0,0} rather than a
    // plausible-looking pair it would then send somebody's private message to.
    CHECK(Chat::PmParticipants("main").first == 0);
    CHECK(Chat::PmParticipants("7/ally/2").first == 0);
}

TEST_CASE("task 9b: an ally target carries the team, a room target does not") {
    CHECK(Chat::RoomTarget(7) == "7");
    CHECK(Chat::AllyTarget(7, 2) == "7/ally/2");
    CHECK(Chat::SpectatorTarget(7) == "7/spec");
    // Two teams in one room are two channels, not one.
    CHECK(Chat::AllyTarget(7, 0) != Chat::AllyTarget(7, 1));
}

TEST_CASE("task 9b: a channel name is normalised or refused, never sanitised") {
    CHECK(Chat::NormalizeChannel("#Help") == "help");
    CHECK(Chat::NormalizeChannel("help") == "help");
    CHECK(Chat::NormalizeChannel("dev_2-a") == "dev_2-a");
    // Refused, not stripped: `#help!` must not silently become `#help` — two
    // spellings of one room is exactly the bug canonical targets exist to
    // prevent.
    CHECK(Chat::NormalizeChannel("help!") == "");
    CHECK(Chat::NormalizeChannel("has space") == "");
    CHECK(Chat::NormalizeChannel("") == "");
    CHECK(Chat::NormalizeChannel("#") == "");
    CHECK(Chat::NormalizeChannel(std::string(25, 'a')) == "");
    CHECK(Chat::NormalizeChannel(std::string(24, 'a')).size() == 24);
}

// ── Text ───────────────────────────────────────────────────────────────────

TEST_CASE("task 9b: a message cannot end its own SSE frame") {
    std::string out, err;
    // `\n\n` is the SSE event separator. A sender who could put one in a
    // message body could append a second, forged event to the frame — with
    // any `from` they liked, on any scope the client renders.
    REQUIRE(Chat::ValidateText("hi\n\ndata: {\"from\":\"admin\"}", out, err));
    CHECK(out.find('\n') == std::string::npos);
    CHECK(out == "hidata: {\"from\":\"admin\"}");

    CHECK(Chat::ValidateText("  spaced  ", out, err));
    CHECK(out == "spaced");

    CHECK_FALSE(Chat::ValidateText("   ", out, err));
    CHECK_FALSE(Chat::ValidateText("", out, err));
    CHECK_FALSE(Chat::ValidateText(std::string(kChatMaxTextBytes + 1, 'x'), out, err));
    CHECK(Chat::ValidateText(std::string(kChatMaxTextBytes, 'x'), out, err));

    // A message that is ONLY control characters is empty, not a blank line.
    CHECK_FALSE(Chat::ValidateText("\n\t\r", out, err));
}

// ── Store + history ────────────────────────────────────────────────────────

TEST_CASE("task 9b: history pages newest-first on ids, not on time") {
    TestDb t;
    // Same second, five messages: a timestamp cannot order them and an id can.
    // (Chat is the one subsystem where "two messages in the same second" is
    // the common case rather than the edge case.)
    for (int i = 0; i < 5; i++)
        t.say(ChatScope::Main, "main", 1, "m" + std::to_string(i), 1000);

    auto page = Chat::History(t.db, ChatScope::Main, "main", 1, 0, 3);
    REQUIRE(page.size() == 3);
    CHECK(page[0].text == "m4");
    CHECK(page[2].text == "m2");

    auto older = Chat::History(t.db, ChatScope::Main, "main", 1, page.back().id, 3);
    REQUIRE(older.size() == 2);
    CHECK(older[0].text == "m1");
    CHECK(older[1].text == "m0");
}

TEST_CASE("task 9b: a conversation is scoped by BOTH scope and target") {
    TestDb t;
    t.say(ChatScope::Room, "7", 1, "in the room");
    t.say(ChatScope::Ally, "7/ally/0", 1, "to my team");
    t.say(ChatScope::Channel, "7", 1, "in a channel that happens to be named 7");

    // The room and the channel share a target string and must not share a
    // conversation — the scope column is not decoration.
    auto room = Chat::History(t.db, ChatScope::Room, "7", 1, 0, 50);
    REQUIRE(room.size() == 1);
    CHECK(room[0].text == "in the room");
    auto ally = Chat::History(t.db, ChatScope::Ally, "7/ally/0", 1, 0, 50);
    REQUIRE(ally.size() == 1);
    CHECK(ally[0].scope == ChatScope::Ally);
}

TEST_CASE("task 9b: the sender's name is a record, not a lookup") {
    TestDb t;
    const int64_t id = Chat::Append(t.db, ChatScope::Main, "main", 5, "oldname",
                                    "said it under this name", 1000);
    REQUIRE(id > 0);
    auto page = Chat::History(t.db, ChatScope::Main, "main", 1, 0, 10);
    REQUIRE(page.size() == 1);
    // Denormalised deliberately (Chat.h): task 8c's guest upgrade renames an
    // account, and re-labelling what somebody said last week rewrites history
    // rather than correcting it.
    CHECK(page[0].fromName == "oldname");
    CHECK(page[0].fromId == 5);
}

// ── Ignore ─────────────────────────────────────────────────────────────────

TEST_CASE("task 9b: ignore is enforced on the backfill as well as the fan-out") {
    TestDb t;
    t.say(ChatScope::Main, "main", 1, "from one");
    t.say(ChatScope::Main, "main", 2, "from two");
    Chat::Append(t.db, ChatScope::Main, "main", 0, "", "player two joined", 1000,
                 /*system=*/true);

    REQUIRE(Chat::SetIgnore(t.db, 1, 2, true));

    // Live delivery.
    auto deliver = Chat::FilterIgnored(t.db, 2, {1, 3, 4});
    REQUIRE(deliver.size() == 2);
    CHECK(deliver[0] == 3);
    CHECK(deliver[1] == 4);
    // …and the sender's own other audience is untouched.
    CHECK(Chat::FilterIgnored(t.db, 1, {1, 2, 3}).size() == 3);

    // Backfill. Without this half, "ignore" means "until I reload".
    auto seen = Chat::History(t.db, ChatScope::Main, "main", 1, 0, 50);
    REQUIRE(seen.size() == 2);
    for (const auto& m : seen) CHECK(m.fromId != 2);
    // A system line is not ignorable — it is the channel talking about itself.
    bool sawSystem = false;
    for (const auto& m : seen) sawSystem = sawSystem || m.system;
    CHECK(sawSystem);

    // The ignorer's view is the only one that changes.
    CHECK(Chat::History(t.db, ChatScope::Main, "main", 3, 0, 50).size() == 3);

    REQUIRE(Chat::SetIgnore(t.db, 1, 2, false));
    CHECK(Chat::History(t.db, ChatScope::Main, "main", 1, 0, 50).size() == 3);
}

TEST_CASE("task 9b: you cannot ignore yourself") {
    TestDb t;
    CHECK_FALSE(Chat::SetIgnore(t.db, 4, 4, true));
    CHECK(Chat::IgnoreList(t.db, 4).empty());
    // The recipient list of a message must always contain its sender —
    // FilterIgnored is the path that could have dropped them.
    CHECK(Chat::FilterIgnored(t.db, 4, {4, 5}).size() == 2);
}

// ── Retention ──────────────────────────────────────────────────────────────

TEST_CASE("task 9b: a room's channels die with the room, and only that room's") {
    TestDb t;
    t.say(ChatScope::Room, Chat::RoomTarget(1), 1, "room one");
    t.say(ChatScope::Ally, Chat::AllyTarget(1, 0), 1, "team zero");
    t.say(ChatScope::Spectator, Chat::SpectatorTarget(1), 1, "spectators");
    // Room 12 is the trap: its target STARTS WITH the digit room 1 uses, and
    // a prefix match would take a live war's chat with a dead one's.
    t.say(ChatScope::Room, Chat::RoomTarget(12), 2, "room twelve");
    t.say(ChatScope::Ally, Chat::AllyTarget(12, 0), 2, "twelve's team zero");
    t.say(ChatScope::Main, "main", 1, "lobby chatter");

    const int deleted = Chat::DeleteRoom(t.db, 1);
    CHECK(deleted == 3);
    CHECK(t.count("scope='room' AND target='1'") == 0);
    CHECK(t.count("scope='ally' AND target='1/ally/0'") == 0);
    CHECK(t.count("scope='spectator'") == 0);
    CHECK(t.count("scope='room' AND target='12'") == 1);
    CHECK(t.count("scope='ally' AND target='12/ally/0'") == 1);
    CHECK(t.count("scope='main'") == 1);
}

TEST_CASE("task 9b: retention keeps #main bounded by count and channels by age") {
    TestDb t;
    const int64_t now = 2'000'000'000;
    for (int i = 0; i < kMainRingBuffer + 5; i++)
        t.say(ChatScope::Main, "main", 1, "m", now);
    t.say(ChatScope::Channel, "help", 1, "old", now - kNamedChannelRetentionSec - 1);
    t.say(ChatScope::Channel, "help", 1, "fresh", now);
    t.say(ChatScope::Pm, "1:2", 1, "ancient", 1);
    t.say(ChatScope::Room, "9", 1, "orphaned", now - kOrphanRoomRetentionSec - 1);

    const int deleted = Chat::Prune(t.db, now);
    CHECK(deleted == 7);  // 5 over the ring + 1 aged channel + 1 orphan room
    CHECK(t.count("scope='main'") == kMainRingBuffer);
    CHECK(t.count("scope='channel'") == 1);
    CHECK(t.count("scope='room'") == 0);
    // PMs are kept "until both parties delete" (§3.3) and no delete verb
    // exists yet — an age sweep here would silently be that verb.
    CHECK(t.count("scope='pm'") == 1);

    // A second pass on an already-pruned store deletes nothing: the ring
    // buffer is a floor, not a decay.
    CHECK(Chat::Prune(t.db, now) == 0);
}

TEST_CASE("task 9b: a quiet channel is not emptied by the ring buffer") {
    TestDb t;
    for (int i = 0; i < 10; i++) t.say(ChatScope::Main, "main", 1, "m", 1000);
    CHECK(Chat::Prune(t.db, 2'000'000'000) == 0);
    CHECK(t.count("scope='main'") == 10);
}

// ── Channel membership ─────────────────────────────────────────────────────

TEST_CASE("task 9b: channel membership is a property of a connected client") {
    ChatChannels ch;
    ch.Join(1, "main");
    ch.Join(2, "main");
    ch.Join(2, "help");
    ch.Join(2, "help");  // idempotent

    CHECK(ch.Members("main").size() == 2);
    CHECK(ch.Members("help").size() == 1);
    CHECK(ch.IsMember(2, "help"));
    CHECK_FALSE(ch.IsMember(1, "help"));
    // Nobody is in a channel nobody joined — not an empty channel that exists.
    CHECK(ch.Members("dev").empty());

    auto mine = ch.ChannelsFor(2);
    REQUIRE(mine.size() == 2);
    CHECK(mine[0] == "help");
    CHECK(mine[1] == "main");

    ch.Leave(2, "help");
    CHECK(ch.Members("help").empty());
    CHECK(ch.ChannelsFor(2).size() == 1);

    ch.LeaveAll(2);
    CHECK(ch.ChannelsFor(2).empty());
    CHECK(ch.Members("main").size() == 1);
    CHECK(ch.Members("main")[0] == 1);
}

// ── Flood control ──────────────────────────────────────────────────────────

TEST_CASE("task 9b: the bucket allows a burst and then refills at one a second") {
    ChatFlood f;
    // Four in hand (§3.4's burst), at the same instant.
    for (int i = 0; i < (int)kChatBurstTokens; i++)
        CHECK(f.Check(1, 100.0) == ChatSendVerdict::Allow);
    CHECK(f.Check(1, 100.0) == ChatSendVerdict::Dropped);

    // A second later, exactly one more.
    CHECK(f.Check(1, 101.0) == ChatSendVerdict::Allow);
    CHECK(f.Check(1, 101.0) == ChatSendVerdict::Dropped);

    // Buckets are per account: one flooder must not silence the room.
    CHECK(f.Check(2, 101.0) == ChatSendVerdict::Allow);
}

TEST_CASE("task 9b: keeping it up past the warnings is a timed mute") {
    ChatFlood f;
    for (int i = 0; i < (int)kChatBurstTokens; i++)
        REQUIRE(f.Check(1, 100.0) == ChatSendVerdict::Allow);

    // Four refusals are warnings; the fifth is the mute (§3.4's "repeat").
    for (int i = 0; i < kChatDropsBeforeMute - 1; i++)
        CHECK(f.Check(1, 100.0) == ChatSendVerdict::Dropped);
    CHECK(f.Check(1, 100.0) == ChatSendVerdict::Muted);
    CHECK(f.MutedUntil(1) == 100 + kChatMuteSec);

    // Still muted a second before it expires, whatever the bucket says —
    // a mute that a refill could out-wait would be a rate limit again.
    CHECK(f.Check(1, 100.0 + kChatMuteSec - 1) == ChatSendVerdict::Muted);

    // Served: the bucket comes back FULL, so the first thing they say after a
    // minute of silence is not dropped for having been said too soon.
    CHECK(f.Check(1, 100.0 + kChatMuteSec) == ChatSendVerdict::Allow);
    CHECK(f.MutedUntil(1) == 0);
    for (int i = 0; i < (int)kChatBurstTokens - 1; i++)
        CHECK(f.Check(1, 100.0 + kChatMuteSec) == ChatSendVerdict::Allow);
}

TEST_CASE("task 9b: a refused message costs no token") {
    ChatFlood f;
    for (int i = 0; i < (int)kChatBurstTokens; i++)
        REQUIRE(f.Check(1, 100.0) == ChatSendVerdict::Allow);
    // Three refusals inside the same second…
    for (int i = 0; i < 3; i++) CHECK(f.Check(1, 100.0) == ChatSendVerdict::Dropped);
    // …and one second later there is exactly one token, not one minus the
    // hammering. Charging for a drop turns a burst into an unbounded silence.
    CHECK(f.Check(1, 101.0) == ChatSendVerdict::Allow);
}

// ── Stream tickets ─────────────────────────────────────────────────────────

TEST_CASE("task 9b: a stream ticket is short-lived, sliding, and revocable") {
    SSETickets t;
    t.Mint("abc", 42, 1000);
    CHECK(t.Redeem("abc", 1000) == 42);
    CHECK(t.Redeem("nope", 1000) == 0);

    // Sliding: EventSource reconnects on its own and re-fetches the same URL,
    // so redeeming has to extend the window or every browser-initiated
    // reconnect would fail once the original window closed.
    CHECK(t.Redeem("abc", 1000 + kSSETicketTtlSec - 1) == 42);
    CHECK(t.Redeem("abc", 1000 + kSSETicketTtlSec * 2 - 2) == 42);

    // Expired, and dropped rather than left to be redeemed by a later clock.
    SSETickets t2;
    t2.Mint("xyz", 7, 1000);
    CHECK(t2.Redeem("xyz", 1000 + kSSETicketTtlSec) == 0);
    CHECK(t2.Size() == 0);

    // Logout must take the stream credential with it.
    SSETickets t3;
    t3.Mint("one", 5, 1000);
    t3.Mint("two", 5, 1000);
    t3.Mint("other", 6, 1000);
    CHECK(t3.RevokeAccount(5) == 2);
    CHECK(t3.Redeem("one", 1000) == 0);
    CHECK(t3.Redeem("other", 1000) == 6);
}

TEST_CASE("task 9b: the ticket is read from the query string, not guessed at") {
    CHECK(SSETickets::TicketFromQuery("ticket=abc") == "abc");
    CHECK(SSETickets::TicketFromQuery("x=1&ticket=abc&y=2") == "abc");
    CHECK(SSETickets::TicketFromQuery("x=1&y=2") == "");
    CHECK(SSETickets::TicketFromQuery("") == "");
    // A parameter that merely ENDS in "ticket" is a different parameter — a
    // suffix match here would let `?notticket=` authenticate a stream.
    CHECK(SSETickets::TicketFromQuery("notticket=abc") == "");
}

// ── Moderator mutes (§3.4's roles half, task 9c) ────────────────────────────
//
// What these defend:
//
//   * **a mute is a ROW, and the row's absence is the only "not muted".**
//     `until = 0` therefore means "until lifted" rather than "no mute" — the
//     one encoding where a permanent mute cannot be written as a timed one
//     that has already expired.
//   * **an expired mute stops biting without a sweep having run.** Enforcement
//     that depends on the maintenance tick is enforcement that is wrong for
//     however long the tick is late.
//   * **speaking and hearing are different questions**, so ActiveMute (may I
//     talk here) and ScopedMute (may I come back in) read different rows.
//   * **the policy is a pure function**, so every rung of §3.4's role map is
//     a case rather than a live lobby with four accounts in it.

namespace {

ChatMute Mute(int64_t account, const std::string& scopeKey, int64_t until,
              int64_t now = 1000) {
    ChatMute m;
    m.accountId = account;
    m.scopeKey = scopeKey;
    m.until = until;
    m.reason = "spam";
    m.byId = 99;
    m.byName = "mod";
    m.createdAt = now;
    return m;
}

}  // namespace

TEST_CASE("task 9c: a mute with no expiry is permanent, not already expired") {
    TestDb t;
    const std::string key = Chat::MuteKey(ChatScope::Channel, "help");
    REQUIRE(Chat::SetMute(t.db, Mute(4, key, 0)));

    // The whole encoding hangs on this: 0 is the open-ended case, and a
    // reader that treated it as a past timestamp would let every permanent
    // mute through on the first send.
    auto m = Chat::ActiveMute(t.db, 4, key, /*now=*/5'000'000);
    REQUIRE(m.has_value());
    CHECK(m->Permanent());
    CHECK(m->byName == "mod");
    CHECK(m->reason == "spam");

    // …and an account with no row is not muted, in any scope.
    CHECK_FALSE(Chat::ActiveMute(t.db, 5, key, 1000).has_value());
}

TEST_CASE("task 9c: a served mute stops biting before anything sweeps it") {
    TestDb t;
    const std::string key = Chat::MuteKey(ChatScope::Main, "main");
    REQUIRE(Chat::SetMute(t.db, Mute(4, key, /*until=*/1060)));

    CHECK(Chat::ActiveMute(t.db, 4, key, 1059).has_value());
    // One second past expiry the row is still on disk and must already be
    // inert: Prune is hygiene, never enforcement.
    CHECK_FALSE(Chat::ActiveMute(t.db, 4, key, 1060).has_value());
    CHECK(Chat::Mutes(t.db, 1060).empty());

    // The sweep then removes it — and only the served one.
    REQUIRE(Chat::SetMute(t.db, Mute(5, key, 0)));
    CHECK(Chat::Prune(t.db, 1060) == 1);
    CHECK(Chat::Mutes(t.db, 1060).size() == 1);
}

TEST_CASE("task 9c: the account-level mute outranks the channel it overlaps") {
    TestDb t;
    const std::string key = Chat::MuteKey(ChatScope::Channel, "help");
    REQUIRE(Chat::SetMute(t.db, Mute(4, Chat::GlobalMuteKey(), /*until=*/0)));
    REQUIRE(Chat::SetMute(t.db, Mute(4, key, /*until=*/1060)));

    // Both are in force; the player must be told the bigger one, or the mute
    // they are shown expires while they are still silent.
    auto m = Chat::ActiveMute(t.db, 4, key, 1000);
    REQUIRE(m.has_value());
    CHECK(m->scopeKey == Chat::GlobalMuteKey());
    CHECK(m->Permanent());
}

TEST_CASE("task 9c: a global mute silences, it does not lock the door") {
    TestDb t;
    const std::string key = Chat::MuteKey(ChatScope::Channel, "help");
    REQUIRE(Chat::SetMute(t.db, Mute(4, Chat::GlobalMuteKey(), 0)));

    // ScopedMute is the re-join question. Answering it with ActiveMute would
    // turn every account-level mute into a ban from every named channel — a
    // policy nobody wrote, arrived at by reusing one query for two questions.
    CHECK(Chat::ActiveMute(t.db, 4, key, 1000).has_value());
    CHECK_FALSE(Chat::ScopedMute(t.db, 4, key, 1000).has_value());

    // The channel's own row is what refuses the door.
    REQUIRE(Chat::SetMute(t.db, Mute(4, key, /*until=*/2000)));
    CHECK(Chat::ScopedMute(t.db, 4, key, 1000).has_value());
    CHECK_FALSE(Chat::ScopedMute(t.db, 4, key, 2000).has_value());
}

TEST_CASE("task 9c: re-muting the same scope replaces, it does not accumulate") {
    TestDb t;
    const std::string key = Chat::MuteKey(ChatScope::Channel, "help");
    REQUIRE(Chat::SetMute(t.db, Mute(4, key, /*until=*/1060)));
    REQUIRE(Chat::SetMute(t.db, Mute(4, key, /*until=*/9000)));

    // Two rows would be two answers, settled by whichever the reader saw
    // first — and the extension would be defeated by the shorter one.
    auto all = Chat::Mutes(t.db, 1000);
    REQUIRE(all.size() == 1);
    CHECK(all[0].until == 9000);
    CHECK(Chat::ActiveMute(t.db, 4, key, 5000).has_value());
}

TEST_CASE("task 9c: lifting a mute reports whether it lifted anything") {
    TestDb t;
    const std::string help = Chat::MuteKey(ChatScope::Channel, "help");
    const std::string dev = Chat::MuteKey(ChatScope::Channel, "dev");
    REQUIRE(Chat::SetMute(t.db, Mute(4, help, 0)));

    // The usual cause of an unmute that matched nothing is a moderator
    // lifting in the wrong scope, which "ok" would hide until the player
    // reported still being muted.
    CHECK_FALSE(Chat::ClearMute(t.db, 4, dev));
    CHECK_FALSE(Chat::ClearMute(t.db, 5, help));
    CHECK(Chat::ClearMute(t.db, 4, help));
    CHECK_FALSE(Chat::ActiveMute(t.db, 4, help, 1000).has_value());
}

TEST_CASE("task 9c: a mute is filed under the CANONICAL target, so it cannot "
          "be spelled around") {
    TestDb t;
    // An ally channel and its room are different conversations, and a mute in
    // one is not a mute in the other. Both keys come off the same builders
    // History pages on, so there is no second spelling to slip through.
    const std::string ally = Chat::MuteKey(ChatScope::Ally, Chat::AllyTarget(7, 1));
    const std::string room = Chat::MuteKey(ChatScope::Room, Chat::RoomTarget(7));
    CHECK(ally != room);
    REQUIRE(Chat::SetMute(t.db, Mute(4, ally, 0)));
    CHECK(Chat::ActiveMute(t.db, 4, ally, 1000).has_value());
    CHECK_FALSE(Chat::ActiveMute(t.db, 4, room, 1000).has_value());

    CHECK(Chat::MuteKeyScope(ally) == "ally");
    CHECK(Chat::MuteKeyScope(room) == "room");
    CHECK(Chat::MuteKeyScope(Chat::GlobalMuteKey()) == "");
}

// ── The role map ───────────────────────────────────────────────────────────

TEST_CASE("task 9c: a room host ops their own room's channels and nothing else") {
    const std::string room = Chat::MuteKey(ChatScope::Room, Chat::RoomTarget(7));
    const std::string ally = Chat::MuteKey(ChatScope::Ally, Chat::AllyTarget(7, 1));
    const std::string spec = Chat::MuteKey(ChatScope::Spectator, Chat::SpectatorTarget(7));
    const std::string help = Chat::MuteKey(ChatScope::Channel, "help");
    const std::string main = Chat::MuteKey(ChatScope::Main, Chat::MainTarget());

    for (const auto& key : {room, ally, spec}) {
        CHECK(ChatCanModerate(key, ChatRole::RoomHost, false, false) ==
              ChatModerationRight::Allowed);
    }
    // Opening a room must not be a way to become a moderator: neither the
    // server's channels nor — the one that matters — the account-level key.
    CHECK(ChatCanModerate(help, ChatRole::RoomHost, false, false) ==
          ChatModerationRight::NotAnOp);
    CHECK(ChatCanModerate(main, ChatRole::RoomHost, false, false) ==
          ChatModerationRight::NotAnOp);
    CHECK(ChatCanModerate(Chat::GlobalMuteKey(), ChatRole::RoomHost, false, false) ==
          ChatModerationRight::NotAnOp);

    // An ordinary player ops nothing, including the room they are sitting in.
    CHECK(ChatCanModerate(room, ChatRole::Player, false, false) ==
          ChatModerationRight::NotAnOp);
    // An admin ops all of it.
    for (const auto& key : {room, ally, spec, help, main, Chat::GlobalMuteKey()}) {
        CHECK(ChatCanModerate(key, ChatRole::Admin, false, false) ==
              ChatModerationRight::Allowed);
    }
}

TEST_CASE("task 9c: an admin cannot be muted, and nobody moderates themselves") {
    const std::string help = Chat::MuteKey(ChatScope::Channel, "help");

    // Immunity is a property of the SUBJECT, so it is answered before the
    // actor's standing: an admin who could mute another admin makes the rule
    // depend on who moved first, and the loser can lift it back.
    CHECK(ChatCanModerate(help, ChatRole::Admin, /*subjectIsAdmin=*/true, false) ==
          ChatModerationRight::ImmuneSubject);
    CHECK(ChatCanModerate(help, ChatRole::RoomHost, true, false) ==
          ChatModerationRight::ImmuneSubject);

    // Self-moderation is refused before everything, including immunity: it is
    // how a moderator locks themselves out of the channel they run.
    CHECK(ChatCanModerate(help, ChatRole::Admin, false, /*selfTarget=*/true) ==
          ChatModerationRight::SelfTarget);
    CHECK(ChatCanModerate(help, ChatRole::Admin, true, true) ==
          ChatModerationRight::SelfTarget);

    // Every refusal has words a route can hand back; "allowed" is not one of
    // them by accident.
    CHECK(std::string(ChatModerationRightToString(ChatModerationRight::NotAnOp)) !=
          std::string(ChatModerationRightToString(ChatModerationRight::Allowed)));
    CHECK(std::string(ChatModerationRightToString(ChatModerationRight::ImmuneSubject)) !=
          std::string(ChatModerationRightToString(ChatModerationRight::SelfTarget)));
}

TEST_CASE("task 9c: a system line is stored as one, and is never ignorable") {
    TestDb t;
    // §3.1's "carries system lines". A moderation notice has no sender, so
    // there is nobody to ignore — and the channel telling you what happened
    // to it must reach the person who muted the account it is about.
    REQUIRE(Chat::SetIgnore(t.db, 4, 9, true));
    REQUIRE(t.say(ChatScope::Channel, "help", 9, "hello") != 0);
    REQUIRE(Chat::Append(t.db, ChatScope::Channel, "help", 0, "",
                         "user9 was muted by mod", 1001, /*system=*/true) != 0);

    auto seen = Chat::History(t.db, ChatScope::Channel, "help", 4, 0, 50);
    REQUIRE(seen.size() == 1);
    CHECK(seen[0].system);
    CHECK(seen[0].fromId == 0);
    CHECK(seen[0].text == "user9 was muted by mod");
}
