// WarStateSim — the two directions between a running war's sim and the durable
// per-player war state in `war_player_bindings`.
//
// PLAN-metalstorm-lobby.md §2.5/§5.1, task 4. The store (WarPlayerBindings.h)
// and the policy (WarRejoinPolicy.h) are both deliberately free of the sim;
// this is the one place that knows where a player's pool and participation
// credit actually live, so there is exactly one file to change if they move.
//
// ── Capture reads state; restore does NOT write it back the same way ────────
// Capture is a plain read of rules params — the pool is a teamRulesParam
// (`authority_player_<n>`, team-scoped so it does not stream to enemies) and
// the score keys are gameRulesParams published by game_teams.lua.
//
// Restore cannot be the mirror image, and the reason is worth stating because
// the symmetric version looks obviously right: writing `authority_player_<n>`
// straight into the team's params would MINT authority. Two separate things
// make it wrong. game_authority.lua is supposed to merge a departing player's
// pool into the TEAM pool (its PlayerRemoved), so the saved value is already in
// the team's hands; and in the live build that merge does not actually fire, so
// a reconnecting player often still HOLDS the pool being restored. Restore
// therefore goes through the gadget that owns the invariant
// (`GG.Authority.RestorePool`, which tops the player back up to the remembered
// LEVEL, funded from the team pool, minting nothing and doing nothing at all
// when the sim never lost it), and likewise for the scoreboard tables, which
// game_teams.lua re-publishes from its own state every tick and would overwrite
// a direct param write within the frame.
//
// Both calls are made from the sim thread, into the synced LuaRules state, and
// carry no client-supplied data — deliberately NOT over `RecvLuaMsg`, which
// any connected client can forge with Spring.SendLuaRulesMsg and which would
// therefore hand every player a "restore my pool to N" verb.
#pragma once

#include "WarPlayerBindings.h"

/// Read the per-player war state for `playerNum` on `team` out of the live sim.
/// Returns zeros for an unknown team or a player with no params yet — a player
/// who has genuinely earned nothing and one the sim has never heard of are the
/// same value here, which is why the caller stamps `state_saved_at` separately
/// rather than inferring "saved" from a non-zero field.
WarPlayerState CaptureWarPlayerState(int team, int playerNum);

/// Top `playerNum`'s own pool back up to `amount` (WarRejoinPolicy's
/// brief-absence case), funded from the team pool. Conserving and idempotent:
/// the gadget makes up the shortfall only, and only as far as the team can
/// fund it. No-op without LuaRules loaded. Returns false if the call could not
/// be made at all.
bool RestoreWarPlayerPool(int playerNum, double amount);

/// Grant the onboarding stipend to a returning player whose saved pool is
/// stale (§2.5: "rejoin re-grants a small onboarding stipend rather than
/// restoring a stale pool"). Sized by the war's own `authority_join_grant`
/// modoption — the same grant a first-time joiner gets — so a war that tunes
/// its economy tunes this with it, and applied as a top-up to that level rather
/// than a deposit, so a reconnect loop cannot farm it.
bool GrantWarRejoinStipend(int playerNum);

/// Restore the participation counters. Lifetime statistics rather than
/// resources, so they are handed back on every rejoin regardless of how long
/// the absence was; the gadget takes the max of saved and live so a restore
/// can never lower a counter.
bool RestoreWarPlayerScore(int playerNum, const WarPlayerState& state);
