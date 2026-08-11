#include <doctest/doctest.h>

#include <sqlite3.h>

#include <map>
#include <string>

#include "Server/GameEventsDb.h"
#include "Server/WarLog.h"

// PLAN-persistence.md §4, task 4b — the while-you-were-away digest.
//
// A week-long war is played in sessions, and a player who comes back on Friday
// has no way to learn what the world did on Wednesday: the board states only
// the CURRENT ownership, the CURRENT objectives, the CURRENT pacts. The digest
// is the answer, and it is three pieces — a ring in synced Lua, a drain on the
// server's wall-clock heartbeat, and a durable table the lobby reads days
// later.
//
// What these tests pin down:
//
//  1. **The drain reports its own losses.** The ring is bounded (it is synced
//     state in a game designed to run for weeks, so it cannot be a log), which
//     means a burst between two heartbeats can overwrite events nobody has
//     read. The only unacceptable outcome is a SHORT history presented as a
//     complete one, so a lap produces a positioned `elided` row, not a silent
//     gap and not a dropped batch.
//  2. **A slot whose seq disagrees is not the event being asked for.** The
//     emitter writes the ring head LAST, so a drain that catches a mid-write
//     sees a slot from the previous lap wearing the fields of a different
//     event. It is counted as lost rather than stored as truth.
//  3. **The watermark survives the process, because the table does.** A war
//     that hibernates and comes back resumes its seq (the gadget's cursor
//     rides the snapshot); the server's in-memory cursor does not survive, and
//     recovering it from MAX(seq) is what stops a resumed war re-appending its
//     surviving ring — or, worse, filing an elision for a gap that is not
//     there.
//  4. **A truncated digest keeps the END of the story.** The cap is on the
//     card, not on the history: "and 40 more" is a true statement about a
//     month away, and the eight lines shown must be the newest eight.
//  5. **Append is idempotent.** A heartbeat that writes its rows and dies
//     before advancing its cursor re-offers them, by design — the drain
//     advances only after the write lands.

namespace {

using warlog::Event;

/// A ring backed by a plain map, standing in for the gameRulesParams the real
/// reader walks. Writing through Emit() reproduces the gadget's own slot
/// arithmetic, so a test cannot accidentally agree with the drain about a
/// layout neither shares with the shipped Lua.
struct FakeRing {
    int ringSize;
    int64_t head = 0;
    std::map<int, Event> slots;

    explicit FakeRing(int size) : ringSize(size) {}

    int64_t Emit(const std::string& kind, const std::string& subject,
                 const std::string& detail, int team, int32_t frame) {
        head++;
        Event e;
        e.seq = head;
        e.kind = kind;
        e.subject = subject;
        e.detail = detail;
        e.team = team;
        e.frame = frame;
        slots[static_cast<int>(head % ringSize)] = e;
        return head;
    }

    warlog::SlotReader Reader() const {
        return [this](int slot, Event& out) {
            const auto it = slots.find(slot);
            if (it == slots.end()) return false;
            out = it->second;
            return true;
        };
    }
};

struct TestDb {
    sqlite3* db = nullptr;
    TestDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        GameEventsDb::EnsureTable(db);
    }
    ~TestDb() { sqlite3_close(db); }
};

constexpr int64_t kT0 = 1'700'000'000;

Event Make(int64_t seq, const std::string& kind, const std::string& subject,
           const std::string& detail, int team = 0, int32_t frame = 0) {
    Event e;
    e.seq = seq;
    e.kind = kind;
    e.subject = subject;
    e.detail = detail;
    e.team = team;
    e.frame = frame;
    return e;
}

}  // namespace

TEST_CASE("warlog drain: an idle war produces nothing") {
    FakeRing ring(8);
    const auto r = warlog::Drain(ring.head, 0, ring.ringSize, ring.Reader());
    CHECK(r.events.empty());
    CHECK(r.elided == 0);
    CHECK(r.watermark == 0);
}

TEST_CASE("warlog drain: a war with no warlog gadget drains nothing") {
    // `warlog_ring` absent reads as 0 through ParamNumber, which is how a war
    // running content that does not ship the gadget presents itself. It must
    // not be read as "a ring of size zero" and divide by it.
    FakeRing ring(8);
    ring.Emit("region", "Ridge", "captured", 1, 300);
    const auto r = warlog::Drain(ring.head, 0, 0, ring.Reader());
    CHECK(r.events.empty());
    CHECK(r.elided == 0);
    CHECK(r.watermark == 0);
}

TEST_CASE("warlog drain: everything since the watermark, oldest first") {
    FakeRing ring(8);
    ring.Emit("region", "Ridge Crossing", "captured", 1, 300);
    ring.Emit("objective", "control", "complete", 0, 600);
    ring.Emit("pact", "ceasefire", "made", 1, 900);

    const auto r = warlog::Drain(ring.head, 0, ring.ringSize, ring.Reader());
    REQUIRE(r.events.size() == 3);
    CHECK(r.events[0].seq == 1);
    CHECK(r.events[0].subject == "Ridge Crossing");
    CHECK(r.events[1].kind == "objective");
    CHECK(r.events[2].detail == "made");
    CHECK(r.elided == 0);
    CHECK(r.watermark == 3);

    // A second drain at the new watermark is the ordinary heartbeat: the ring
    // still holds all three, and none of them is offered twice.
    const auto again = warlog::Drain(ring.head, r.watermark, ring.ringSize,
                                     ring.Reader());
    CHECK(again.events.empty());
    CHECK(again.watermark == 3);
}

TEST_CASE("warlog drain: a lapped ring files the gap it cannot recover") {
    FakeRing ring(4);
    for (int i = 0; i < 10; ++i)
        ring.Emit("region", "R" + std::to_string(i), "captured", 0, i);

    // 10 events, a 4-slot ring, nothing drained yet: 6 are gone.
    const auto r = warlog::Drain(ring.head, 0, ring.ringSize, ring.Reader());
    CHECK(r.elided == 6);
    REQUIRE(r.events.size() == 5);   // 1 gap marker + the 4 survivors
    CHECK(r.events[0].kind == warlog::kElidedKind);
    CHECK(r.events[0].detail == "6");
    // The marker sits WHERE the loss happened, so the digest reads
    // "…6 more…, R6, R7, R8, R9" rather than putting the apology at the end.
    CHECK(r.events[0].seq == 1);
    CHECK(r.events[1].subject == "R6");
    CHECK(r.events[4].subject == "R9");
    CHECK(r.watermark == 10);
}

TEST_CASE("warlog drain: exactly a full ring is not a lap") {
    // The boundary the obvious `>=` gets wrong: 4 events into a 4-slot ring
    // are all still there, and reporting one of them as lost would put a
    // permanent apology into every war that ever bursts to exactly capacity.
    FakeRing ring(4);
    for (int i = 0; i < 4; ++i)
        ring.Emit("region", "R" + std::to_string(i), "captured", 0, i);
    const auto r = warlog::Drain(ring.head, 0, ring.ringSize, ring.Reader());
    CHECK(r.elided == 0);
    REQUIRE(r.events.size() == 4);
    CHECK(r.events[0].subject == "R0");
}

TEST_CASE("warlog drain: a slot that was never written is not invented") {
    FakeRing ring(8);
    ring.Emit("region", "Ridge", "captured", 1, 300);
    ring.Emit("objective", "control", "complete", 0, 600);
    // The head says 3 but slot 3 has never been written — the emitter is
    // mid-write, or the head was read from a param map a fraction ahead of the
    // slots. Either way the drain must not invent an event.
    const auto r = warlog::Drain(3, 0, ring.ringSize, ring.Reader());
    REQUIRE(r.events.size() == 2);
    CHECK(r.elided == 1);
    // And it does not stall: the cursor advances past the dead slot, or every
    // heartbeat for the rest of the war re-walks it.
    CHECK(r.watermark == 3);
}

TEST_CASE("warlog drain: a slot wearing another event's seq is not stored") {
    // The case a "was it written at all" check cannot see, and the reason the
    // drain compares seqs rather than presence: every slot here HAS an event
    // in it, and the one at the asked-for index belongs to a previous lap. Its
    // fields would be stored under a seq that is not its own — a digest line
    // reporting the wrong thing, indistinguishable from a real one.
    FakeRing ring(4);
    for (int i = 1; i <= 5; ++i)
        ring.Emit("region", "R" + std::to_string(i), "captured", 0, i);

    // Head 6 with only 5 emitted: the drain is reading a param map caught
    // between the emitter's slot writes and its head write. seq 5 is in slot 1
    // and matches; seq 6 lands on slot 2, which still holds seq 2.
    const auto r = warlog::Drain(6, 4, ring.ringSize, ring.Reader());
    REQUIRE(r.events.size() == 1);
    CHECK(r.events[0].subject == "R5");
    CHECK(r.elided == 1);
    CHECK(r.watermark == 6);
}

TEST_CASE("warlog drain: a head behind the watermark is a rollback, not news") {
    // A GM rollback restores an older snapshot, and the gadget's cursor comes
    // back with it. Re-draining would duplicate the whole rolled-back stretch.
    FakeRing ring(8);
    ring.Emit("region", "Ridge", "captured", 1, 300);
    const auto r = warlog::Drain(1, 5, ring.ringSize, ring.Reader());
    CHECK(r.events.empty());
    CHECK(r.elided == 0);
    CHECK(r.watermark == 5);
}

TEST_CASE("game_events: append, read back, and the highest seq") {
    TestDb t;
    const std::vector<Event> batch = {
        Make(1, "region", "Ridge Crossing", "captured", 1, 300),
        Make(2, "objective", "control", "complete", 0, 600),
    };
    CHECK(GameEventsDb::Append(t.db, 7, batch, kT0) == 2);
    CHECK(GameEventsDb::HighestSeq(t.db, 7) == 2);
    // Another war's history is not this war's.
    CHECK(GameEventsDb::HighestSeq(t.db, 8) == 0);

    int total = 0;
    const auto got = GameEventsDb::Since(t.db, 7, kT0 - 1, 10, &total);
    REQUIRE(got.size() == 2);
    CHECK(total == 2);
    CHECK(got[0].seq == 1);
    CHECK(got[0].subject == "Ridge Crossing");
    CHECK(got[0].team == 1);
    CHECK(got[0].frame == 300);
    CHECK(got[1].kind == "objective");
}

TEST_CASE("game_events: re-appending a drained batch writes nothing new") {
    TestDb t;
    const std::vector<Event> batch = {Make(1, "region", "Ridge", "captured")};
    CHECK(GameEventsDb::Append(t.db, 7, batch, kT0) == 1);
    // The drain advances its cursor only after the write, so a heartbeat that
    // stored its rows and then died re-offers them on the next boot.
    CHECK(GameEventsDb::Append(t.db, 7, batch, kT0 + 60) == 0);
    int total = 0;
    GameEventsDb::Since(t.db, 7, 0, 10, &total);
    CHECK(total == 1);
}

TEST_CASE("game_events: the digest cursor is an instant, not a seq") {
    TestDb t;
    GameEventsDb::Append(t.db, 7, {Make(1, "region", "Before", "captured")}, kT0);
    GameEventsDb::Append(t.db, 7, {Make(2, "region", "After", "captured")},
                         kT0 + 3600);

    int total = 0;
    // A player who left at kT0 + 10 missed only the second one. Strictly
    // after: an event stamped at the same second the sweep recorded them as
    // present is one they were there for.
    const auto got = GameEventsDb::Since(t.db, 7, kT0 + 10, 10, &total);
    REQUIRE(got.size() == 1);
    CHECK(total == 1);
    CHECK(got[0].subject == "After");

    // And a player who never left sees nothing at all — which is what makes
    // the digest self-clearing, since the state sweep refreshes `last_seen_at`
    // every minute for everyone connected.
    const auto none = GameEventsDb::Since(t.db, 7, kT0 + 7200, 10, &total);
    CHECK(none.empty());
    CHECK(total == 0);
}

TEST_CASE("game_events: a truncated digest keeps the newest, in order") {
    TestDb t;
    for (int i = 1; i <= 20; ++i)
        GameEventsDb::Append(t.db, 7,
                             {Make(i, "region", "R" + std::to_string(i), "captured")},
                             kT0 + i);

    int total = 0;
    const auto got = GameEventsDb::Since(t.db, 7, kT0, 3, &total);
    REQUIRE(got.size() == 3);
    // The true count, so the card can say "and 17 more" rather than let three
    // lines read as the whole month.
    CHECK(total == 20);
    // Newest three, handed back oldest-first: the story runs forwards, but
    // what gets cut when it is too long is the beginning.
    CHECK(got[0].subject == "R18");
    CHECK(got[1].subject == "R19");
    CHECK(got[2].subject == "R20");
}

TEST_CASE("game_events: prune keeps the newest per room and spares the rest") {
    TestDb t;
    const int over = GameEventsDb::kRetainPerRoom + 25;
    for (int i = 1; i <= over; ++i)
        GameEventsDb::Append(t.db, 7,
                             {Make(i, "region", "R" + std::to_string(i), "captured")},
                             kT0 + i);
    GameEventsDb::Append(t.db, 8, {Make(1, "region", "Other", "captured")}, kT0);

    GameEventsDb::Prune(t.db, 7);

    int total = 0;
    GameEventsDb::Since(t.db, 7, 0, 1, &total);
    CHECK(total == GameEventsDb::kRetainPerRoom);
    // The head of the history survives; the tail is what goes.
    CHECK(GameEventsDb::HighestSeq(t.db, 7) == over);
    // A prune is per-room: another war's short history is not collateral.
    CHECK(GameEventsDb::HighestSeq(t.db, 8) == 1);

    // A room under the retention loses nothing.
    GameEventsDb::Prune(t.db, 8);
    CHECK(GameEventsDb::HighestSeq(t.db, 8) == 1);
}

TEST_CASE("game_events: a resumed war recovers its watermark from the table") {
    // The end-to-end shape of the hibernate/resume path. The gadget's seq
    // rides the snapshot, so the ring comes back holding events 5..8; the
    // server's in-memory cursor does not survive and is recovered from the
    // table. Without that recovery the fresh cursor (0) against a head of 8
    // and a ring of 4 would file FOUR events as lost — a gap that is not
    // there, sitting permanently in a war's history.
    TestDb t;
    for (int i = 1; i <= 4; ++i)
        GameEventsDb::Append(t.db, 7,
                             {Make(i, "region", "R" + std::to_string(i), "captured")},
                             kT0 + i);

    FakeRing ring(4);
    ring.head = 4;                 // the restored gadget cursor
    for (int i = 5; i <= 8; ++i)   // and four events since the resume
        ring.Emit("region", "R" + std::to_string(i), "captured", 0, i);

    const int64_t watermark = GameEventsDb::HighestSeq(t.db, 7);
    CHECK(watermark == 4);
    const auto r = warlog::Drain(ring.head, watermark, ring.ringSize, ring.Reader());
    CHECK(r.elided == 0);
    REQUIRE(r.events.size() == 4);
    CHECK(r.events[0].subject == "R5");

    CHECK(GameEventsDb::Append(t.db, 7, r.events, kT0 + 100) == 4);
    CHECK(GameEventsDb::HighestSeq(t.db, 7) == 8);
}

TEST_CASE("game_events: deleting a war deletes its history") {
    TestDb t;
    GameEventsDb::Append(t.db, 7, {Make(1, "region", "Ridge", "captured")}, kT0);
    GameEventsDb::Append(t.db, 8, {Make(1, "region", "Other", "captured")}, kT0);
    GameEventsDb::DeleteForRoom(t.db, 7);
    // A room id is recycled; a war's story must not be inherited by the next
    // war to land on the number.
    CHECK(GameEventsDb::HighestSeq(t.db, 7) == 0);
    CHECK(GameEventsDb::HighestSeq(t.db, 8) == 1);
}
