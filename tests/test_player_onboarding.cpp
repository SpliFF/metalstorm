#include <doctest/doctest.h>

#include "Server/PlayerOnboarding.h"

// PLAN-metalstorm-lobby.md §2.4, task 5 — the onboarding hook contract.
//
// Task 2 lets a non-roster account take a seat in a running war. It arrived at
// that seat with nothing: `gadget:PlayerAdded` never fired, so the join grant
// in `game_authority.lua` (which only ever ran from its own `GameStart` loop
// over `GetPlayerList()`) never reached a mid-war joiner, and they could not
// afford a single order. The mirror symptom is a leaver whose pool is never
// merged back into the team pool.
//
// The cause is not a forgotten call. The three player callins are declared
// `MANAGED_BIT | UNSYNCED_BIT` in `System/Events.def` — verbatim upstream — and
// `CEventHandler::InsertEvent` refuses the registration for any synced client,
// so `eventHandler.PlayerRemoved()` has always iterated a list the synced
// LuaRules handle cannot be in. The server therefore delivers the two callins
// to the synced handle explicitly at the sites that decide them. The full
// argument is in `PlayerOnboarding.h`; what is testable without an engine is
// the policy: WHICH seatings fire the hook.
//
// The delivery half (`FireSyncedPlayerAdded` / `FireSyncedPlayerRemoved`) needs
// a live `luaRules` and is verified on the running stack, not here.

TEST_CASE("onboarding hook fires for a mid-game joiner on a real team") {
    CHECK(DecideOnboardingHook(/*playerNum=*/3, /*team=*/0, /*spectator=*/false,
                               /*gameStarted=*/true) == OnboardingHook::Fire);
    // Any team, not just team 0 — the grant is per-player and the gadget
    // resolves the team itself.
    CHECK(DecideOnboardingHook(7, 4, false, true) == OnboardingHook::Fire);
}

TEST_CASE("a spectator is not onboarded") {
    // §3: a spectator holds no seat, so there is nothing to grant against —
    // the same reason task 4 writes them no war binding. This is the common
    // case, not an edge one: every declined dynamic join lands here.
    CHECK(DecideOnboardingHook(3, -1, /*spectator=*/true, true) ==
          OnboardingHook::SkipSpectator);
    // Spectator wins even when a team came along with it, so a stale team on a
    // spectating session cannot mint a grant.
    CHECK(DecideOnboardingHook(3, 0, /*spectator=*/true, true) ==
          OnboardingHook::SkipSpectator);
}

TEST_CASE("no team means nothing to grant against") {
    CHECK(DecideOnboardingHook(3, /*team=*/-1, false, true) ==
          OnboardingHook::SkipNoTeam);
}

TEST_CASE("pre-GameStart seatings are left to the GameStart roster loop") {
    // This is the one skip that is about ORDER rather than eligibility, and it
    // is load-bearing twice over. `gadget:GameStart` calls `PlayerAdded` for
    // every player in `GetPlayerList()`, so firing here as well would be a
    // second call for the same player — harmless on its own, because the
    // `authority_granted_<n>` guard is synced. But `GameStart` ALSO resets
    // every team pool to `STARTING_TEAM_AUTHORITY` first, so a grant issued
    // before it is a grant against pools that are about to be overwritten.
    CHECK(DecideOnboardingHook(0, 0, false, /*gameStarted=*/false) ==
          OnboardingHook::SkipBeforeGameStart);
    CHECK(DecideOnboardingHook(2, 1, false, /*gameStarted=*/false) ==
          OnboardingHook::SkipBeforeGameStart);
}

TEST_CASE("an unseated connection has no player number to onboard") {
    CHECK(DecideOnboardingHook(/*playerNum=*/-1, 0, false, true) ==
          OnboardingHook::SkipInvalidPlayer);
}

TEST_CASE("the skip checks are ordered so the log names the real reason") {
    // A replay spectator arrives as playerNum -1 AND spectator AND team -1.
    // The player-number check runs first deliberately: "no player number" is
    // the fact that stopped it, and reporting "spectator" would send an
    // operator looking at the seating rule instead.
    CHECK(DecideOnboardingHook(-1, -1, true, true) ==
          OnboardingHook::SkipInvalidPlayer);
    // And eligibility outranks timing: a spectator connecting during set-up
    // reports as a spectator, not as "the roster loop will handle them" — the
    // roster loop will not, and that would be a lie in the log.
    CHECK(DecideOnboardingHook(3, -1, true, /*gameStarted=*/false) ==
          OnboardingHook::SkipSpectator);
}

TEST_CASE("every outcome names itself for the operator log") {
    // A join that silently does not happen is indistinguishable from a
    // spectator who meant to spectate — task 2's finding, and the reason each
    // outcome carries text rather than being a bare bool.
    for (OnboardingHook h : {OnboardingHook::Fire,
                             OnboardingHook::SkipSpectator,
                             OnboardingHook::SkipNoTeam,
                             OnboardingHook::SkipInvalidPlayer,
                             OnboardingHook::SkipBeforeGameStart}) {
        const char* s = OnboardingHookToString(h);
        REQUIRE(s != nullptr);
        CHECK(std::string(s) != "unknown");
        CHECK(std::string(s).size() > 0);
    }
}
