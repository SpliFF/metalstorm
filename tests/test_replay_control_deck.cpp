// Tests for the replay playback-control policy (PLAN-replay task 4b).
//
// What is worth testing here is the POLICY, not the plumbing: who may drive a
// shared cast, what happens to the controls when the driver closes their tab,
// and which requests a re-execution can honestly serve. The engine-coupled
// half (turning an accepted decision into gs->paused / gs->wantedSpeedFactor /
// Feed().SetSeekTarget) is a three-line translation in ClientMessageHandler
// and is verified live; ControlDeck is pure precisely so the decisions above
// it can be stated rather than demonstrated in a browser.

#include <doctest/doctest.h>

#include "Server/ReplayControlDeck.h"

#include <cmath>

using namespace replay;

namespace {
ControlRequest Pause()  { ControlRequest r; r.action = ControlAction::Pause;  return r; }
ControlRequest Resume() { ControlRequest r; r.action = ControlAction::Resume; return r; }
ControlRequest Speed(float s) {
    ControlRequest r; r.action = ControlAction::SetSpeed; r.speed = s; return r;
}
ControlRequest Seek(int32_t f) {
    ControlRequest r; r.action = ControlAction::Seek; r.frame = f; return r;
}
ControlRequest Pov(int32_t t) {
    ControlRequest r; r.action = ControlAction::SetPovTeam; r.povTeam = t; return r;
}
}  // namespace

// ─────────────────────────── authority (§5 casting) ────────────────────────

TEST_CASE("the first spectator to attach holds the controls") {
    ControlDeck d;
    CHECK(d.Controller() == -1);
    d.Attach(200);
    CHECK(d.Controller() == 200);
    d.Attach(201);
    // Second watcher does NOT take the controls off the first.
    CHECK(d.Controller() == 200);
    CHECK(d.WatcherCount() == 2);
    CHECK(d.IsController(200));
    CHECK_FALSE(d.IsController(201));
}

TEST_CASE("re-attaching the controller does not hand the controls away") {
    ControlDeck d;
    d.Attach(200);
    d.Attach(201);
    d.Attach(200);            // e.g. a duplicated admission path
    CHECK(d.Controller() == 200);
    CHECK(d.WatcherCount() == 2);   // and does not double-count the watcher
}

TEST_CASE("control passes to the longest-attached survivor when the driver leaves") {
    ControlDeck d;
    d.Attach(200);
    d.Attach(201);
    d.Attach(202);
    d.Detach(200);
    // Not "nobody": a cast whose host closes their tab must not freeze for the
    // people still watching it.
    CHECK(d.Controller() == 201);
    d.Detach(202);            // a non-controller leaving changes nothing
    CHECK(d.Controller() == 201);
    d.Detach(201);
    CHECK(d.Controller() == -1);
    CHECK(d.WatcherCount() == 0);
}

TEST_CASE("a non-controller is refused, and told who is driving") {
    ControlDeck d;
    d.Attach(200);
    d.Attach(201);
    const ControlDecision r = d.Decide(201, Pause(), /*cur=*/100, /*end=*/6150);
    CHECK_FALSE(r.accepted);
    CHECK(r.reason.find("200") != std::string::npos);
    // and the refusal changed nothing
    CHECK_FALSE(d.Paused());
}

TEST_CASE("with nobody attached there is no controller to refuse on behalf of") {
    ControlDeck d;
    const ControlDecision r = d.Decide(200, Pause(), 100, 6150);
    CHECK_FALSE(r.accepted);
    CHECK(r.reason.find("no controller") != std::string::npos);
}

// ───────────────────────────── pause / resume ──────────────────────────────

TEST_CASE("pause and resume round-trip through the deck") {
    ControlDeck d;
    d.Attach(200);
    ControlDecision r = d.Decide(200, Pause(), 100, 6150);
    CHECK(r.accepted);
    CHECK(r.setPaused);
    CHECK(r.paused);
    CHECK(d.Paused());

    r = d.Decide(200, Resume(), 100, 6150);
    CHECK(r.accepted);
    CHECK(r.setPaused);
    CHECK_FALSE(r.paused);
    CHECK_FALSE(d.Paused());
}

// ──────────────────────────────── speed ────────────────────────────────────

TEST_CASE("playback speed is clamped to the watchable band") {
    ControlDeck d;
    d.Attach(200);
    ControlDecision r = d.Decide(200, Speed(2.0f), 100, 6150);
    CHECK(r.accepted);
    CHECK(r.speed == doctest::Approx(2.0f));
    CHECK(d.Speed() == doctest::Approx(2.0f));

    // Below the sim loop's own 0.05x clamp the control would be a no-op; above
    // kMaxSpeed a "speed" is a seek wearing a different hat.
    r = d.Decide(200, Speed(0.01f), 100, 6150);
    CHECK(r.accepted);
    CHECK(r.speed == doctest::Approx(kMinSpeed));
    r = d.Decide(200, Speed(20.0f), 100, 6150);
    CHECK(r.accepted);
    CHECK(r.speed == doctest::Approx(kMaxSpeed));
}

TEST_CASE("a nonsense speed is refused rather than clamped") {
    ControlDeck d;
    d.Attach(200);
    // Zero and negative would divide the tick interval into nothing; NaN
    // survives std::clamp untouched and busy-spins the sim loop, which is why
    // it is tested rather than assumed away.
    for (float bad : {0.0f, -1.0f, std::nanf(""), 1e9f}) {
        const ControlDecision r = d.Decide(200, Speed(bad), 100, 6150);
        CHECK_FALSE(r.accepted);
        CHECK_FALSE(r.reason.empty());
    }
    CHECK(d.Speed() == doctest::Approx(1.0f));   // unchanged by any of them
}

// ───────────────────────────────── seek ────────────────────────────────────

TEST_CASE("a forward seek inside the recording is accepted and un-pauses") {
    ControlDeck d;
    d.Attach(200);
    d.Decide(200, Pause(), 100, 6150);
    REQUIRE(d.Paused());

    const ControlDecision r = d.Decide(200, Seek(4800), /*cur=*/100, /*end=*/6150);
    CHECK(r.accepted);
    CHECK(r.setSeek);
    CHECK(r.seekTarget == 4800);
    // A seek out of a paused replay MUST un-pause: the fast-forward is the sim
    // ticking, so a paused seek moves the bar and nothing else.
    CHECK(r.setPaused);
    CHECK_FALSE(r.paused);
    CHECK_FALSE(d.Paused());
    CHECK(d.Seeking());
    CHECK(d.SeekTarget() == 4800);

    d.SeekFinished();
    CHECK_FALSE(d.Seeking());
}

TEST_CASE("a backward seek is refused with the reason, not silently clamped") {
    ControlDeck d;
    d.Attach(200);
    const ControlDecision r = d.Decide(200, Seek(50), /*cur=*/3000, /*end=*/6150);
    CHECK_FALSE(r.accepted);
    // The refusal names the missing capability (no checkpoints) and where
    // playback actually is, because "nothing happened" is the failure mode
    // this replaces.
    CHECK(r.reason.find("backwards") != std::string::npos);
    CHECK(r.reason.find("3000") != std::string::npos);
    CHECK_FALSE(d.Seeking());
}

TEST_CASE("seeking to the current frame is refused as a backward seek") {
    // Not a special case worth its own message: it is still "there is no way
    // to make the sim be at a frame it has passed", and accepting it would set
    // a target FastForwarding() can never satisfy.
    ControlDeck d;
    d.Attach(200);
    CHECK_FALSE(d.Decide(200, Seek(3000), 3000, 6150).accepted);
}

TEST_CASE("a seek past the end of the recording is refused") {
    ControlDeck d;
    d.Attach(200);
    const ControlDecision r = d.Decide(200, Seek(9999), 100, /*end=*/6150);
    CHECK_FALSE(r.accepted);
    CHECK(r.reason.find("6150") != std::string::npos);
    // The end frame itself is reachable.
    CHECK(d.Decide(200, Seek(6150), 100, 6150).accepted);
}

// ────────────────────────────────── POV ────────────────────────────────────

TEST_CASE("POV is per-client and needs no controller rights") {
    ControlDeck d;
    d.Attach(200);
    d.Attach(201);
    // 201 cannot pause, but it can absolutely choose its own fog.
    REQUIRE_FALSE(d.Decide(201, Pause(), 100, 6150).accepted);
    const ControlDecision r = d.Decide(201, Pov(4), 100, 6150);
    CHECK(r.accepted);
    CHECK(r.setPov);
    CHECK(r.povTeam == 4);
    // and it is not shared state — the deck records nothing about it
    CHECK_FALSE(r.setPaused);
    CHECK_FALSE(r.setSpeed);
    CHECK_FALSE(r.setSeek);
}

TEST_CASE("any negative POV team means the global view") {
    ControlDeck d;
    d.Attach(200);
    CHECK(d.Decide(200, Pov(-1), 100, 6150).povTeam == -1);
    CHECK(d.Decide(200, Pov(-7), 100, 6150).povTeam == -1);
}

TEST_CASE("POV works before anyone holds the controls") {
    // A watcher whose admission raced the controller assignment still gets to
    // pick a POV — the refusal path above must not catch it.
    ControlDeck d;
    const ControlDecision r = d.Decide(200, Pov(0), 100, 6150);
    CHECK(r.accepted);
    CHECK(r.povTeam == 0);
}
