#include <doctest/doctest.h>

#include "Server/WarStateEvents.h"

#include <set>
#include <string>
#include <vector>

// PLAN-persistence task 4d — the war-state TRANSITION, off-lobby.
//
// Tasks 3b/4a made a war's state visible on a card; nothing said that it had
// CHANGED. What these tests defend is the two ways a change-detector goes
// wrong, both of which are silent:
//
//   * it fires when nothing happened — a lobby restart re-observes every war
//     and every connected browser gets a burst of toasts about wars that did
//     not move (`Observe`'s first sight);
//   * it goes quiet when something did — the broadcast samples state every 5 s
//     and a resume takes about that long, so the middle state is often never
//     seen, and a detector written over adjacent state pairs would drop the
//     notification on exactly the FAST resumes (`Detect`'s destination rule).
//
// Every case therefore asserts the `Kind` for a whole ROW of origins, not one.

using warevents::Detect;
using warevents::Kind;
using warevents::Watcher;
using warresume::WarState;

namespace {

/// Every state a war can be observed in, so a case can assert over all of them
/// and a new `WarState` shows up here as a compile-time list to extend rather
/// than as a case nobody wrote.
const std::vector<WarState> kAllStates = {
    WarState::NotAWar,  WarState::Live,   WarState::Resuming,
    WarState::Hibernated, WarState::Crashed, WarState::Fresh,
    WarState::Unresumable,
};

}  // namespace

TEST_CASE("war events: nothing to report") {
    SUBCASE("no movement is not an event, from any state") {
        for (auto s : kAllStates)
            CHECK(Detect(s, s) == Kind::None);
    }
    SUBCASE("a room that is not a war has no transitions, either direction") {
        for (auto s : kAllStates) {
            CHECK(Detect(WarState::NotAWar, s) == Kind::None);
            CHECK(Detect(s, WarState::NotAWar) == Kind::None);
        }
    }
    SUBCASE("a war whose history vanished is not news") {
        // `Fresh` after something else means the store lost (or pruned) the
        // rows. The card already says the war has not started; a toast about it
        // would interrupt a player with a fact they cannot act on.
        for (auto s : kAllStates)
            CHECK(Detect(s, WarState::Fresh) == Kind::None);
    }
}

TEST_CASE("war events: the war came back") {
    SUBCASE("arriving Live is Back from every non-live origin") {
        // The whole point of the destination rule: `Hibernated -> Live` with the
        // `Resuming` window never sampled is the COMMON observation, not an
        // edge case, because the resume finishes inside one broadcast period.
        for (auto s : kAllStates) {
            if (s == WarState::Live || s == WarState::NotAWar) continue;
            CHECK(Detect(s, WarState::Live) == Kind::Back);
        }
    }
    SUBCASE("a resume in flight says so") {
        CHECK(Detect(WarState::Hibernated, WarState::Resuming) == Kind::Resuming);
        CHECK(Detect(WarState::Crashed, WarState::Resuming) == Kind::Resuming);
        CHECK(Detect(WarState::Unresumable, WarState::Resuming) == Kind::Resuming);
        CHECK(Detect(WarState::Fresh, WarState::Resuming) == Kind::Resuming);
        // A live war that stops serving with its process still up is a reload,
        // and it gets the same sentence: not playable this second, on its way
        // back. The alternative reading — silence — leaves a player clicking a
        // Fight button that cannot seat them.
        CHECK(Detect(WarState::Live, WarState::Resuming) == Kind::Resuming);
    }
}

TEST_CASE("war events: the war stopped") {
    SUBCASE("a clean sleep is reported only from a running war") {
        CHECK(Detect(WarState::Live, WarState::Hibernated) == Kind::Hibernated);
        CHECK(Detect(WarState::Resuming, WarState::Hibernated) == Kind::Hibernated);
        // A war that was already stopped gaining a checkpoint row is
        // bookkeeping (a GM checkpoint, a store repair) — the war did not go to
        // sleep, it was already asleep.
        CHECK(Detect(WarState::Crashed, WarState::Hibernated) == Kind::None);
        CHECK(Detect(WarState::Unresumable, WarState::Hibernated) == Kind::None);
        CHECK(Detect(WarState::Fresh, WarState::Hibernated) == Kind::None);
    }
    SUBCASE("a lost tail is reported, and never as a sleep") {
        CHECK(Detect(WarState::Live, WarState::Crashed) == Kind::Lost);
        CHECK(Detect(WarState::Resuming, WarState::Crashed) == Kind::Lost);
        // Task 3c's other loss: no process died, a DEPLOY moved the engine past
        // the war's own snapshots, so a world that was promised back this
        // morning is not coming back. Same sentence, and it must not be silent
        // just because the war was already stopped.
        CHECK(Detect(WarState::Hibernated, WarState::Unresumable) == Kind::Lost);
        CHECK(Detect(WarState::Fresh, WarState::Unresumable) == Kind::Lost);
        // Between the two lossy states there is nothing new to say.
        CHECK(Detect(WarState::Crashed, WarState::Unresumable) == Kind::None);
        CHECK(Detect(WarState::Unresumable, WarState::Crashed) == Kind::None);
    }
}

TEST_CASE("war events: the wire vocabulary and the prose") {
    SUBCASE("every kind has a distinct word and a sentence") {
        const std::vector<Kind> kinds = {Kind::Resuming, Kind::Back,
                                         Kind::Hibernated, Kind::Lost};
        std::set<std::string> words, sentences;
        for (auto k : kinds) {
            words.insert(warevents::ToString(k));
            const std::string h = warevents::Headline(k);
            CHECK(!h.empty());
            sentences.insert(h);
        }
        CHECK(words.size() == kinds.size());
        CHECK(sentences.size() == kinds.size());
    }
    SUBCASE("None carries no word to match on and no sentence to show") {
        CHECK(std::string(warevents::ToString(Kind::None)) == "none");
        CHECK(warevents::Headline(Kind::None).empty());
    }
    SUBCASE("a loss never wears the word that promises the world back") {
        // The one prose assertion worth pinning: `hibernated` is the word tasks
        // 3b/4a spent their design on NOT saying about a war that lost frames.
        const std::string lost = warevents::Headline(Kind::Lost);
        CHECK(lost.find("gone") != std::string::npos);
        CHECK(lost.find("hibernat") == std::string::npos);
        // And the clean sleep is the only one that gets to say the world is
        // saved — the two sentences are the pair that must not converge.
        const std::string slept = warevents::Headline(Kind::Hibernated);
        CHECK(slept.find("saved") != std::string::npos);
        CHECK(slept.find("gone") == std::string::npos);
    }
}

TEST_CASE("war events: the watcher remembers, seeds and forgets") {
    SUBCASE("first sight seeds and never fires") {
        Watcher w;
        // Every state, because "the lobby restarted while the war was X" is a
        // whole row of cases and the burst-of-toasts defect only needs one of
        // them to be wrong.
        uint32_t rid = 1;
        for (auto s : kAllStates)
            CHECK(w.Observe(rid++, s) == Kind::None);
        // ... and the seed is real: the SECOND observation of the same room
        // fires. A watcher that seeded with a default state instead would
        // report `Back` here for a war that never moved.
        Watcher w2;
        CHECK(w2.Observe(7, WarState::Live) == Kind::None);
        CHECK(w2.Observe(7, WarState::Live) == Kind::None);
        CHECK(w2.Observe(7, WarState::Hibernated) == Kind::Hibernated);
        CHECK(w2.Observe(7, WarState::Live) == Kind::Back);
    }
    SUBCASE("rooms are tracked independently") {
        Watcher w;
        CHECK(w.Observe(1, WarState::Hibernated) == Kind::None);
        CHECK(w.Observe(2, WarState::Live) == Kind::None);
        CHECK(w.Observe(1, WarState::Live) == Kind::Back);
        CHECK(w.Observe(2, WarState::Live) == Kind::None);
        CHECK(w.LastSeen(1) == WarState::Live);
        CHECK(w.LastSeen(2) == WarState::Live);
        CHECK(w.LastSeen(99) == WarState::NotAWar);
    }
    SUBCASE("a reused room id does not inherit the previous war's state") {
        // Room ids ARE reused (the same fact `DeleteForRoom` exists for). A war
        // that hibernated on room 4, then room 4 becoming a different war that
        // comes up live, must not report "your war is back".
        Watcher w;
        w.Observe(4, WarState::Hibernated);
        w.Forget(4);
        CHECK(w.Observe(4, WarState::Live) == Kind::None);
    }
    SUBCASE("Retain prunes departed rooms and keeps the rest") {
        Watcher w;
        w.Observe(1, WarState::Hibernated);
        w.Observe(2, WarState::Hibernated);
        w.Observe(3, WarState::Hibernated);
        CHECK(w.Size() == 3);
        w.Retain({1, 3});
        CHECK(w.Size() == 2);
        // Kept rooms keep their history — pruning is not a reset.
        CHECK(w.Observe(1, WarState::Live) == Kind::Back);
        // The pruned one is first-sight again.
        CHECK(w.Observe(2, WarState::Live) == Kind::None);
        // A lobby that stays up for weeks must not accumulate a row per room
        // ever created: an empty list empties the map.
        w.Retain({});
        CHECK(w.Size() == 0);
    }
}

// ── The toast a correctly-finished war used to get (wars task 4, D4) ───────

TEST_CASE("war events: a war that ENDED is never announced as lost") {
    using warresume::WarState;
    // Live evidence: after `archived, digest emitted`, both completed wars
    // logged `lost (state=crashed) — Your war stopped without saving its last
    // stretch — some of it is gone.` The player had already been told, by the
    // digest, that their war ended and who won.
    CHECK(warevents::Detect(WarState::Live, WarState::Finished) ==
          warevents::Kind::None);
    CHECK(warevents::Detect(WarState::Resuming, WarState::Finished) ==
          warevents::Kind::None);
    CHECK(warevents::Detect(WarState::Hibernated, WarState::Finished) ==
          warevents::Kind::None);

    // The crash sentence still fires for an actual crash — this is a fix to
    // the classification, not the removal of a notification.
    CHECK(warevents::Detect(WarState::Live, WarState::Crashed) ==
          warevents::Kind::Lost);

    // A finished war is not "up", so a later checkpoint row is bookkeeping and
    // not news; and if one somehow came back, that IS news.
    CHECK(warevents::Detect(WarState::Finished, WarState::Hibernated) ==
          warevents::Kind::None);
    CHECK(warevents::Detect(WarState::Finished, WarState::Live) ==
          warevents::Kind::Back);

    // A finished war observed twice says nothing at all — the sweep re-observes
    // it on every 5 s pass for as long as the room exists.
    warevents::Watcher w;
    CHECK(w.Observe(4, WarState::Live) == warevents::Kind::None);  // seeds
    CHECK(w.Observe(4, WarState::Finished) == warevents::Kind::None);
    CHECK(w.Observe(4, WarState::Finished) == warevents::Kind::None);
}
