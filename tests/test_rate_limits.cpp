#include <doctest/doctest.h>

#include "Server/ClientSession.h"

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
