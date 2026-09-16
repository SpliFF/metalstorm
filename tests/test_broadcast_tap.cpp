// Broadcast tap tests (PLAN-beta-broadcast.md lane S1).
//
// The tap's two decisions are the ones a doctest can hold: HOW OFTEN a
// keyframe is written (a watcher's worst-case seek distance) and WHEN the
// per-tick pipeline runs at all (a tapped mission must stream with nobody
// watching, or the log has a hole for every minute nobody was connected).
//
// What the doctest deliberately cannot cover — stated because it is the lane's
// real risk — is whether the join bundle behind a `K` is COMPLETE. That needs a
// live seek against a running mission; see the live recipe in the plan.

#include <doctest/doctest.h>

#include <filesystem>
#include <string>

#include <unistd.h>

#include "Server/BroadcastTap.h"
#include "Server/ReplayPlayer.h"

namespace {

std::string TapPath() {
    auto p = std::filesystem::temp_directory_path() /
             ("msbtap-" + std::to_string(::getpid()) + ".msb");
    return p.string();
}

}  // namespace

TEST_CASE("the tap client id is disjoint from every other id space") {
    // Real QUIC clients are allocated from 1 upward; replay's virtual
    // spectators live above kVirtualClientBase and are recognised by bit 30.
    // A collision on either side would route the tap's bytes to a real socket
    // or hand a replayed record the tap's session.
    CHECK(broadcast::kTapClientId != 0);
    CHECK_FALSE(replay::IsVirtualClient(broadcast::kTapClientId));
    CHECK(broadcast::kTapClientId > 0xFFFF);   // far above any live allocation
}

TEST_CASE("keyframe cadence is one per kKeyframeFrames, starting at the first frame") {
    CHECK(broadcast::ShouldKeyframe(0, -1));              // none yet → keyframe now
    CHECK_FALSE(broadcast::ShouldKeyframe(-1, -1));       // pre-start frames never do
    CHECK_FALSE(broadcast::ShouldKeyframe(1799, 0));
    CHECK(broadcast::ShouldKeyframe(1800, 0));
    CHECK(broadcast::ShouldKeyframe(4000, 0));            // a skipped cadence still fires
    CHECK_FALSE(broadcast::ShouldKeyframe(1800, 1800));
}

TEST_CASE("the tap writes exactly one K per cadence window and stamps records with the tick frame") {
    const std::string path = TapPath();
    broadcast::Tap tap;
    std::string err;
    replay::Header h;
    h.gameId = "metalstorm";
    REQUIRE(tap.Open(path, h, err));
    CHECK(tap.Active());

    const uint8_t payload[4] = {1, 2, 3, 4};
    int keyframes = 0;
    for (int f = 0; f <= 3600; f += 30) {
        tap.SetFrame(f);
        if (tap.MaybeKeyframe(f)) ++keyframes;
        tap.Sink(/*cls=*/1, /*lane=*/0, /*broadcast=*/false, payload, sizeof(payload));
    }
    CHECK(keyframes == 3);                       // frames 0, 1800, 3600
    CHECK(tap.Log().KeyframesWritten() == 3);
    CHECK(tap.Log().Written() == 121);
    tap.Close(3600);

    const auto sum = broadcast::LoadSummary(path);
    REQUIRE(sum.ok);
    CHECK_FALSE(sum.truncated);
    CHECK(sum.recordCount == 121);
    REQUIRE(sum.keyframes.size() == 3);
    CHECK(sum.keyframes[0].frame == 0);
    CHECK(sum.keyframes[1].frame == 1800);
    CHECK(sum.keyframes[2].frame == 3600);
    // SetFrame is what makes a record locatable: the funnel does not know the
    // frame, so a record stamped 0 for the whole run would defeat every seek.
    CHECK(sum.firstFrame == 0);
    CHECK(sum.lastFrame == 3600);

    std::filesystem::remove(path);
}

TEST_CASE("an inactive tap keyframes nothing and consumes nothing") {
    broadcast::Tap tap;                 // never Open()ed
    CHECK_FALSE(tap.Active());
    CHECK_FALSE(tap.MaybeKeyframe(0));
    const uint8_t payload[1] = {0};
    tap.Sink(1, 0, false, payload, sizeof(payload));   // no file, no crash
    CHECK(tap.Log().Written() == 0);
    tap.Close(0);
}

TEST_CASE("the stream-consumer gate keeps a tapped mission streaming with nobody connected") {
    const std::string path = TapPath();
    broadcast::Tap tap;
    std::string err;
    REQUIRE(tap.Open(path, replay::Header{}, err));

    CHECK(broadcast::HasStreamConsumers(0, &tap));     // the log IS the audience
    CHECK(broadcast::HasStreamConsumers(3, &tap));
    CHECK(broadcast::HasStreamConsumers(1, nullptr));  // untapped, one client
    CHECK_FALSE(broadcast::HasStreamConsumers(0, nullptr));  // untapped, idle: unchanged

    broadcast::Tap closed;
    CHECK_FALSE(broadcast::HasStreamConsumers(0, &closed));

    tap.Close(0);
    std::filesystem::remove(path);
}

TEST_CASE("registering the tap session yields a global-visibility spectator whose latches reset") {
    SessionManager sessions;
    broadcast::RegisterTapSession(sessions);

    ClientSession* s = sessions.GetSession(broadcast::kTapClientId);
    REQUIRE(s != nullptr);
    CHECK(s->role == "spectator");
    CHECK(s->spectatorVisibilityMode == SpectatorVisibilityMode::Global);
    CHECK(s->team == -1);
    // A spectator commands nothing, in every build — the tap can never become
    // an input path back into the sim.
    CHECK_FALSE(SessionManager::CanCommandTeam(*s, 0));

    s->rulesParamsSnapshotSent = true;
    s->rulesParamsKeyDictRev = 7;
    broadcast::ResetJoinLatches(*s);
    CHECK_FALSE(s->rulesParamsSnapshotSent);
    CHECK(s->rulesParamsKeyDictRev == 0);
}
