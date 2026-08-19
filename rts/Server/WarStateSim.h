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

#include <cstdint>
#include <string>
#include <vector>

#include "WarLog.h"
#include "WarOutcome.h"
#include "WarPlayerBindings.h"
#include "WarSummary.h"
#include "WarTermination.h"

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

/// The live seat census the war browser reads (task 6): every player row the
/// sim holds, spectators included. Separated from BuildWarSummary so the
/// digest itself stays a pure function of values — this is the one impure
/// half, and it is three lines against a handler the tests cannot build.
std::vector<WarSummaryPlayer> GatherWarSummaryPlayers();

/// Region ownership as `game_regions.lua` publishes it: one entry per
/// `region_<key>_team` gameRulesParam, with the matching `_contested` flag.
///
/// Discovered by scanning the param map for the key shape rather than by
/// asking the gadget for its region list, because the summary is written on a
/// wall-clock heartbeat from the server loop and must not call into synced
/// Lua to do it. A map with no regions gadget contributes an empty vector and
/// the browser simply shows no control line.
std::vector<WarSummaryRegion> GatherWarSummaryRegions();

/// Drain `game_warlog.lua`'s strategic event ring — everything after
/// `watermark`, in order (PLAN-persistence task 4b). The reading half is the
/// same shape as GatherWarSummaryRegions() and for the same reason: it runs on
/// the war-summary heartbeat, off the server loop, and must not call into
/// synced Lua. The arithmetic that decides whether the drain missed anything
/// is `warlog::Drain`, which is pure and tested; this function is only the
/// param lookups it needs.
///
/// A war with no warlog gadget publishes no head and drains nothing.
warlog::DrainResult DrainWarLog(int64_t watermark);

/// The per-side foothold census (wars §7 faction elimination, task 4): how
/// many of its DECLARED start regions each side still holds, as
/// `game_gameover.lua` publishes it. The sim COUNTS; the Director DECIDES
/// (`EvaluateWarTermination`).
///
/// Returns EMPTY when the census is unusable — no scenario, a scenario that
/// declares no starting regions, or a war whose gameover gadget is not loaded.
/// The caller reads that as "cannot tell", never as "everybody is eliminated":
/// ending a war because a census was unavailable is the one failure mode worth
/// making unrepresentable.
std::vector<WarSideFootholds> GatherWarFootholds(const WarSides& sides);

/// §5's "highest-stakes" ranking key: the authority riding on this war's
/// UNRESOLVED objectives. Summed off `objective_<id>_reward`, which the
/// objectives gadget already publishes with the staked bounties folded in, so
/// there is no second adder to drift from it.
double GatherWarStakes();

/// The war's ENDING, for the durable `war_outcome` row — winner, final frame,
/// the war-end settlement's two halves, and the final scoreboard with the
/// players NAMED (only this process holds the playerNum↔name mapping, and
/// player numbers are recycled).
///
/// Returns false while the war is still `active`, when no gameover gadget
/// publishes `war_state` at all, and — the part that is not obvious — for every
/// heartbeat of the 300-frame WIND-DOWN grace, during which the war has left
/// `active` but has settled nothing. `IsPublishableWarOutcome` (WarOutcome.h)
/// owns that rule; publishing early archives a war with `final_frame=0` and
/// every stake still in escrow. A scenario-less war has no terminal condition
/// (§7.1) and must not be recorded as having ended.
bool GatherWarOutcome(const WarSides& sides, WarOutcomeRecord& out);

/// `war_state` as the sim publishes it right now: "" when no gameover gadget is
/// loaded, else one of "active" / "winding_down" / "resolving" / "over".
///
/// Exists for the hibernation gate (`hibernate::ShouldIdleHibernate`): a war
/// that has DECLARED its ending is in the middle of a 300-frame settlement it
/// is the only process that can finish, and an idle timer that fires inside
/// that window truncates it permanently. Everything else about the war's state
/// machine is the Director's; this is the one bit the server needs to know
/// about its own life.
std::string GatherWarSimState();

/// Restore the participation counters. Lifetime statistics rather than
/// resources, so they are handed back on every rejoin regardless of how long
/// the absence was; the gadget takes the max of saved and live so a restore
/// can never lower a counter.
bool RestoreWarPlayerScore(int playerNum, const WarPlayerState& state);
