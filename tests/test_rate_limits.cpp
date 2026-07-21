#include <doctest/doctest.h>

#include "Server/ClientSession.h"
#include "Server/HttpAuth.h"

#include <chrono>

// PLAN-security-hardening task 4 (G6/G13/G16): LuaRulesMsg/LuaUIMsg and
// PathRequest previously had no rate limit at all, unlike PlayerCommand's
// existing token bucket (which also had no test coverage until now). These
// exercise the token-bucket mechanics directly — burst admits N, the
// (N+1)th is dropped, and the counters + drop tallies behave as documented
// in ClientSession.h.
//
// E3 (§4): server-side AI submits through the sim's order queues directly,
// never through ClientMessageHandler's WebTransport dispatch — it has no
// ClientSession/ClientID at all, so these per-connection buckets structurally
// cannot apply to it. There is nothing to unit-test for that exemption
// beyond this architectural fact (AI never reaches the code under test).

TEST_CASE("SessionManager.TryConsumeLuaMsgBudget admits a burst then drops") {
    ClientSession session;
    session.clientId = 1;

    int admitted = 0;
    for (int i = 0; i < (int)SessionManager::LUA_MSG_BURST_CAP; i++) {
        if (SessionManager::TryConsumeLuaMsgBudget(session)) admitted++;
    }
    CHECK(admitted == (int)SessionManager::LUA_MSG_BURST_CAP);
    CHECK(session.luaMsgRateLimitDrops == 0);

    // Burst exhausted — the next call in the same instant is dropped.
    CHECK_FALSE(SessionManager::TryConsumeLuaMsgBudget(session));
    CHECK(session.luaMsgRateLimitDrops == 1);
}

TEST_CASE("SessionManager.TryConsumePathRequestBudget admits a burst then drops") {
    ClientSession session;
    session.clientId = 2;

    int admitted = 0;
    for (int i = 0; i < (int)SessionManager::PATH_REQ_BURST_CAP; i++) {
        if (SessionManager::TryConsumePathRequestBudget(session)) admitted++;
    }
    CHECK(admitted == (int)SessionManager::PATH_REQ_BURST_CAP);
    CHECK(session.pathReqRateLimitDrops == 0);

    CHECK_FALSE(SessionManager::TryConsumePathRequestBudget(session));
    CHECK(session.pathReqRateLimitDrops == 1);
}

TEST_CASE("SessionManager.TryConsumeLuaMsgBudget and PathRequest budgets are independent") {
    ClientSession session;
    session.clientId = 3;

    // Draining one bucket must not affect the other.
    for (int i = 0; i < (int)SessionManager::LUA_MSG_BURST_CAP; i++)
        SessionManager::TryConsumeLuaMsgBudget(session);
    CHECK_FALSE(SessionManager::TryConsumeLuaMsgBudget(session));

    CHECK(SessionManager::TryConsumePathRequestBudget(session));
}

TEST_CASE("SessionManager.TryConsumeCommandBudget admits a burst then drops (pre-existing limiter, previously untested)") {
    ClientSession session;
    session.clientId = 4;

    int admitted = 0;
    for (int i = 0; i < (int)SessionManager::MSG_BURST_CAP; i++) {
        if (SessionManager::TryConsumeCommandBudget(session, /*squadOrderCount=*/0)) admitted++;
    }
    CHECK(admitted == (int)SessionManager::MSG_BURST_CAP);
    CHECK_FALSE(SessionManager::TryConsumeCommandBudget(session, 0));
    CHECK(session.rateLimitDrops == 1);
}

TEST_CASE("SessionManager.TryConsumeCommandBudget drains the order bucket by squad count") {
    ClientSession session;
    session.clientId = 5;

    // A single message claiming more squads than the order burst cap allows
    // must be rejected outright — it should not partially succeed.
    const int tooMany = (int)SessionManager::ORDER_BURST_CAP + 1;
    CHECK_FALSE(SessionManager::TryConsumeCommandBudget(session, tooMany));
    // Message-token bucket must be untouched by the rejected order — still
    // usable for a legitimately-sized command right after.
    CHECK(SessionManager::TryConsumeCommandBudget(session, 1));
}

// HttpAuth::LoginLimiter (PLAN-security-hardening task 3): the fail counter
// must get a fresh threshold once a lockout has elapsed. Before the
// sliding-window reset, failCount only ever grew, so after the first
// 5-failure lockout every single further failure re-tripped a full 60s lock
// — one bad login per minute was a permanent lockout DoS on the account.
// Time is injected via the optional `now` parameter; the wall clock is never
// consulted here.

TEST_CASE("HttpAuth.LoginLimiter locks after kMaxFailures and unlocks once the lockout elapses") {
    using Clock = HttpAuth::LoginLimiter::Clock;
    HttpAuth::LoginLimiter limiter;
    const auto t0 = Clock::now();

    for (int i = 0; i < HttpAuth::LoginLimiter::kMaxFailures; i++) {
        CHECK_FALSE(limiter.IsLocked("alice", t0));
        limiter.RecordFailure("alice", t0);
    }
    CHECK(limiter.IsLocked("alice", t0));

    // Lock expired → IsLocked is false again, so a correct password reaches
    // the verify step and succeeds (the login handler only 429s on IsLocked).
    const auto expired = t0 + std::chrono::seconds(HttpAuth::LoginLimiter::kLockoutSeconds + 1);
    CHECK_FALSE(limiter.IsLocked("alice", expired));

    // A success clears the entry entirely.
    limiter.RecordSuccess("alice");
    CHECK_FALSE(limiter.IsLocked("alice", expired));
}

TEST_CASE("HttpAuth.LoginLimiter requires kMaxFailures fresh failures to re-lock after expiry") {
    using Clock = HttpAuth::LoginLimiter::Clock;
    HttpAuth::LoginLimiter limiter;
    const auto t0 = Clock::now();

    for (int i = 0; i < HttpAuth::LoginLimiter::kMaxFailures; i++)
        limiter.RecordFailure("bob", t0);
    CHECK(limiter.IsLocked("bob", t0));

    const auto expired = t0 + std::chrono::seconds(HttpAuth::LoginLimiter::kLockoutSeconds + 1);

    // Post-expiry failures start from a fresh threshold: the first
    // kMaxFailures-1 must NOT re-trip the lock...
    for (int i = 0; i < HttpAuth::LoginLimiter::kMaxFailures - 1; i++) {
        limiter.RecordFailure("bob", expired);
        CHECK_FALSE(limiter.IsLocked("bob", expired));
    }
    // ...and the kMaxFailures-th does (burst semantics preserved).
    limiter.RecordFailure("bob", expired);
    CHECK(limiter.IsLocked("bob", expired));
}
