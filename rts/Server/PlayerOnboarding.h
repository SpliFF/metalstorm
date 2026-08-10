#pragma once

// PlayerOnboarding — the onboarding hook contract between the server and the
// game's synced Lua (PLAN-metalstorm-lobby.md §2.4, task 5).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS: `gadget:PlayerAdded` / `gadget:PlayerRemoved` cannot
// reach a SYNCED Lua handle, in this engine or in Recoil.
// ─────────────────────────────────────────────────────────────────────────────
//
// The three player callins are classified `MANAGED_BIT | UNSYNCED_BIT` in
// `System/Events.def` (verbatim upstream — `../RecoilEngine` declares them the
// same way), and `CEventHandler::InsertEvent` refuses the registration outright
// for any client that reports itself synced:
//
//     if (ec->GetSynced() && iter->second.HasPropBit(UNSYNCED_BIT))
//         return false;
//
// So `eventHandler.PlayerRemoved(pNum, reason)` — which the disconnect drain has
// always called, with a comment claiming it reached gadgets — iterates a list
// the synced LuaRules handle is not, and cannot be, in. Nothing is missing and
// no hook was forgotten: the event is *unsynced by classification*, and the
// fact that Metalstorm's gadgets define `PlayerAdded`/`PlayerRemoved` and were
// silently never called is the natural consequence.
//
// Two symptoms that look unrelated are this one cause: a mid-war dynamic joiner
// never receives the join grant (`game_authority.lua`'s `PlayerAdded` only ever
// ran from its own `GameStart` loop over `GetPlayerList()`), and a leaver's pool
// is never merged back into the team pool.
//
// The fix is NOT to clear `UNSYNCED_BIT`. Upstream's classification is about a
// peer-to-peer sim in which clients observe joins and leaves at different times,
// and relaxing it would let *any* synced handle take a callin whose ordering is
// not part of the synced stream. What is true HERE and not upstream is narrower:
// this engine is server-authoritative, there is exactly one synced Lua state (in
// this process), and a seat change is decided by this server and already written
// into the synced input journal (`RecordAuthIdentity` / `RecordDisconnect`).
// So the server delivers these two callins to the synced handle EXPLICITLY, at
// the sites that own the decision, as a named contract rather than as a
// side-effect of an event list. Replay re-executes those same journalled records
// through the same code, so the delivery is deterministic.
//
// FIDELITY-STANDIN: delivering PlayerAdded/PlayerRemoved into synced Lua is a
// deliberate deviation from Recoil's event classification, allowed by the
// client-server carve-out in the code-session contract and confined to the two
// call sites below. Recoil games get these callins in their unsynced half only.

/// What the server decided to do about the onboarding hook for one seating.
/// Every outcome names itself in the operator log: a join that silently did not
/// happen is indistinguishable from a spectator who meant to spectate, which is
/// the class of bug this lane keeps finding (task 2's rule, same shape).
enum class OnboardingHook {
    /// Deliver `PlayerAdded` into synced Lua — a human took a team seat in a
    /// game that is already running.
    Fire,
    /// Spectators hold no seat (§3) and get no grant. They also hold no war
    /// binding, for the same reason.
    SkipSpectator,
    /// No team to grant against. `game_authority.lua` resolves the pool through
    /// `Spring.GetPlayerInfo`, so a seat with no team has nowhere to put it.
    SkipNoTeam,
    /// Invalid player number — nothing addressable.
    SkipInvalidPlayer,
    /// The game has not started yet, so this player is part of the initial
    /// roster and `gadget:GameStart`'s own loop over `GetPlayerList()` will call
    /// `PlayerAdded` for them. Firing here as well would grant BEFORE
    /// `GameStart` resets every team pool to `STARTING_TEAM_AUTHORITY`, i.e.
    /// against pools that are about to be overwritten.
    SkipBeforeGameStart,
};

/// Pure decision — no engine state, no database, no socket, so the whole policy
/// is testable on its own (the shape `DynamicJoin.h` and `GameStartCoordinator.h`
/// already use in this lane).
///
/// Deliberately NOT idempotency-aware: the server does not remember whether it
/// has already onboarded this player. `game_authority.lua` guards the grant with
/// `authority_granted_<playerNum>`, which is synced state that survives a
/// reconnect and is the only thing that can tell a fresh join from a returning
/// one. A second server-side memory would be a second answer to the same
/// question, and the two would drift the first time a war was resumed.
inline OnboardingHook DecideOnboardingHook(int playerNum, int team,
                                           bool spectator, bool gameStarted) {
    if (playerNum < 0)  return OnboardingHook::SkipInvalidPlayer;
    if (spectator)      return OnboardingHook::SkipSpectator;
    if (team < 0)       return OnboardingHook::SkipNoTeam;
    if (!gameStarted)   return OnboardingHook::SkipBeforeGameStart;
    return OnboardingHook::Fire;
}

inline const char* OnboardingHookToString(OnboardingHook h) {
    switch (h) {
        case OnboardingHook::Fire:                return "onboarded";
        case OnboardingHook::SkipSpectator:       return "spectator, no seat to onboard";
        case OnboardingHook::SkipNoTeam:          return "no team, nothing to grant against";
        case OnboardingHook::SkipInvalidPlayer:   return "no player number";
        case OnboardingHook::SkipBeforeGameStart: return "pre-GameStart, the roster loop onboards them";
    }
    return "unknown";
}

// ── Delivery (implemented in PlayerOnboarding.cpp; needs the sim) ────────────

/// Call `PlayerAdded(playerNum)` on the SYNCED LuaRules state. Returns false if
/// LuaRules is not loaded (a test scene, or a server whose scripting failed).
bool FireSyncedPlayerAdded(int playerNum);

/// Call `PlayerRemoved(playerNum, reason)` on the SYNCED LuaRules state.
bool FireSyncedPlayerRemoved(int playerNum, int reason);
