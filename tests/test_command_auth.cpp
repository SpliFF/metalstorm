#include <doctest/doctest.h>

#include "Server/ClientSession.h"

// PLAN-security-hardening task 10 (G4): the PlayerCommand / PlayerCommandBatch
// ownership check was `session.team >= 0 && unit->team != session.team`, which
// skipped the team check entirely when session.team == -1 — so any un-rostered
// session (dev smoketest, but also a spectator or an anomalous no-roster
// connection) could command every unit on every team. The decision now lives
// in SessionManager::CanCommandTeam; these exercise it directly.

static ClientSession MakeSession(const std::string& role, int team) {
    ClientSession s;
    s.clientId = 1;
    s.role = role;
    s.team = team;
    return s;
}

TEST_CASE("CanCommandTeam: a rostered player commands only its own team") {
    ClientSession s = MakeSession("player", 0);
    CHECK(SessionManager::CanCommandTeam(s, 0));         // own team
    CHECK_FALSE(SessionManager::CanCommandTeam(s, 1));   // enemy team
    CHECK_FALSE(SessionManager::CanCommandTeam(s, 2));   // third team

    ClientSession s2 = MakeSession("player", 3);
    CHECK(SessionManager::CanCommandTeam(s2, 3));
    CHECK_FALSE(SessionManager::CanCommandTeam(s2, 0));
}

TEST_CASE("CanCommandTeam: a spectator commands nothing, in every build") {
    // Spectators are the crux of G4: previously team==-1 (their team) opened
    // the "command anything" path. The role check bars them unconditionally,
    // independent of the SPRING_PROD dev-bypass below.
    ClientSession spec = MakeSession("spectator", -1);
    CHECK_FALSE(SessionManager::CanCommandTeam(spec, 0));
    CHECK_FALSE(SessionManager::CanCommandTeam(spec, 1));

    // Even a spectator that somehow carries a real team index commands nothing.
    ClientSession specTeamed = MakeSession("spectator", 0);
    CHECK_FALSE(SessionManager::CanCommandTeam(specTeamed, 0));
}

TEST_CASE("CanCommandTeam: an admin follows the same ownership rule, no PlayerCommand godmode") {
    // Admin privilege rides the separately-gated ConsoleCommand path, not
    // PlayerCommand — a rostered admin still only reaches its own team here.
    ClientSession admin = MakeSession("admin", 0);
    CHECK(SessionManager::CanCommandTeam(admin, 0));
    CHECK_FALSE(SessionManager::CanCommandTeam(admin, 1));
}

TEST_CASE("CanCommandTeam: team==-1 non-spectator is the dev-only escape hatch") {
    // Lobby-less launch (spring-test / manual dev runs) gives sessions team==-1
    // and relies on commanding every unit. That bypass exists ONLY in dev
    // builds; SPRING_PROD compiles it out so a team==-1 session commands
    // nothing. This test asserts whichever behaviour matches the build it was
    // compiled under.
    ClientSession dev = MakeSession("player", -1);
#ifdef SPRING_PROD
    CHECK_FALSE(SessionManager::CanCommandTeam(dev, 0));
    CHECK_FALSE(SessionManager::CanCommandTeam(dev, 1));
#else
    CHECK(SessionManager::CanCommandTeam(dev, 0));
    CHECK(SessionManager::CanCommandTeam(dev, 1));
    CHECK(SessionManager::CanCommandTeam(dev, 7));
#endif
}
