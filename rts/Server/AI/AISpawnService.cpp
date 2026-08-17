#define LOG_SECTION "ai-spawn"

#include "AISpawnService.h"

#include "AISpawn.h"
#include "AIRuntimePool.h"
#include "Server/Database.h"
#include "Server/GameServerContext.h"
#include "Server/PlayerOnboarding.h"
#include "Server/ReplayPlayer.h"
#include "Server/RuntimeAIRoster.h"
#include "Server/Simulation.h"
#include "Game/Players/Player.h"
#include "Game/Players/PlayerHandler.h"
#include "Sim/Misc/TeamHandler.h"
#include "System/SpringLog/SpringLog.h"

#include <ctime>
#include <string>

namespace {

// An AI already on the side is the reason a caretaker must NOT be spawned: it
// upgrades itself to the full-side goal the moment the humans are gone
// (game_teams.lua refreshCoCommanders / roles.lua), so a second brain would
// contend with the first for one authority pool and one set of org groups.
// Counted over the virtual players rather than over AIRuntimePool, because the
// pool has no team index and a LuaAI has no pool entry at all.
bool TeamHasActiveAI(int teamId)
{
    for (int i = 0; i < playerHandler.ActivePlayers(); ++i) {
        const CPlayer* p = playerHandler.Player(i);
        if (p != nullptr && p->active && p->isAI && p->team == teamId)
            return true;
    }
    return false;
}

// Is this sim playerNum already held by an ACTIVE player in this process? Asked
// of the resume path only, where the launch roster has already been staged: the
// stored seat wants its own number back (every synced key about it is scoped by
// that number) and a collision must refuse rather than double-book.
//
// A gap stub — PlayerHandler::AddPlayer fills the space below an explicit
// playerNum with inactive spectator stubs — is deliberately NOT a collision:
// that is precisely the hole a resumed seat slots back into.
bool PlayerNumTaken(int playerNum)
{
    if (playerNum < 0 || playerNum >= playerHandler.ActivePlayers())
        return false;
    const CPlayer* p = playerHandler.Player(playerNum);
    return p != nullptr && p->active;
}

// Write the seat down, so a war that hibernates with this AI resumes with a
// brain behind it (RuntimeAIRoster.h). Recorded at the point the VIRTUAL PLAYER
// exists rather than after AIRuntimePool::AddAI succeeds, deliberately: from
// here on the synced state carries this playerNum (its pool, its groups, its
// directives), so the seat is a durable fact even in the case where the VM
// failed to init — that case is a side with a brainless identity, which is
// exactly what a resume should be given the chance to repair.
void RecordRuntimeSeat(GameServerContext& ctx, const std::string& aiId,
                       int teamId, int playerNum)
{
    if (ctx.roomId == 0) {
        // No room owns this process (a bare/scenario/headless boot). Nothing
        // will ever resume it, and room 0 is the id every such boot shares, so
        // a row here would be inherited by an unrelated run rather than kept.
        return;
    }
    RuntimeAISeat seat;
    seat.roomId      = ctx.roomId;
    seat.playerNum   = playerNum;
    seat.aiId        = aiId;
    seat.team        = teamId;
    seat.seatedFrame = ctx.sim.GetFrameNum();
    seat.createdAt   = static_cast<int64_t>(std::time(nullptr));
    if (!RuntimeAIRoster::Record(ctx.db.Handle(), seat)) {
        // Loud, and at ERROR: a lost row is a war that comes back with this
        // side's pool and orders in the world and nothing driving them. The
        // seat itself is unaffected and stays live for this session.
        SLOG(SPRING_LOG_ERROR,
            "could not record runtime AI seat '%s' (team %d, player #%d) for "
            "room %u — this side will resume without a runtime",
            aiId.c_str(), teamId, playerNum, ctx.roomId);
    }
}

} // namespace

void ServiceAISpawns(GameServerContext& ctx)
{
    std::vector<AISpawnRequest> requests = aiSpawnRelay.Drain();
    if (requests.empty())
        return;

    for (const AISpawnRequest& rq : requests) {
        const bool validTeam = teamHandler.IsActiveTeam(rq.teamId);
        const AISpawnVerdict verdict =
            DecideAISpawn(validTeam ? rq.teamId : -1, rq.aiId,
                          validTeam && TeamHasActiveAI(rq.teamId),
                          ctx.sim.HasGameStarted());

        if (verdict != AISpawnVerdict::Spawn) {
            SLOG(SPRING_LOG_NOTICE,
                "AI spawn request '%s' on team %d: %s",
                rq.aiId.c_str(), rq.teamId, AISpawnVerdictName(verdict));
            continue;
        }

        ResolvedAIPlugin plugin;
        std::string err;
        if (!ResolveAIPlugin(ctx.aiSpawnEnv.enginePath, ctx.aiSpawnEnv.gamePath,
                             rq.aiId, plugin, err)) {
            SLOG(SPRING_LOG_ERROR,
                "AI spawn request '%s' on team %d failed: %s",
                rq.aiId.c_str(), rq.teamId, err.c_str());
            continue;
        }
        if (plugin.isLuaAI) {
            // A LuaAI's brain is the game's own synced gadgets, dispatched on
            // Spring.GetTeamLuaAI(teamId) — which is set up from the roster at
            // start-up and is not a thing this hook can install. Refusing
            // loudly beats registering a virtual player with nothing behind it.
            SLOG(SPRING_LOG_WARNING,
                "AI spawn request '%s' on team %d: LuaAI entries cannot be "
                "seated mid-game (their runtime is the game's own gadgets)",
                rq.aiId.c_str(), rq.teamId);
            continue;
        }

        // ── The virtual player (AI3) ────────────────────────────────────────
        // Registered on BOTH the live and the replay path: it is synced state
        // derived from synced state, so a replay that skipped it would run the
        // recorded AI's commands against a player that does not exist and
        // charge them to nobody. Its number comes off the same counter a
        // dynamic human joiner draws from, so the two interleave in declaration
        // order and a replay re-derives the identical numbering.
        const int pNum = ctx.nextPlayerNum++;
        CPlayer p;
        p.name      = "AI:" + plugin.id + "@t" + std::to_string(rq.teamId);
        p.team      = rq.teamId;
        p.active    = true;
        p.spectator = false;
        p.isAI      = true;
        p.playerNum = pNum;
        playerHandler.AddPlayer(p);

        // Same onboarding contract a mid-war human joiner gets
        // (PlayerOnboarding.h): PlayerAdded is UNSYNCED by classification, so
        // the server delivers it into synced Lua by hand. Without it the AI has
        // no authority pool — game_authority.lua mints pools from PlayerAdded
        // and from its own GameStart roster loop, and GameStart is long past —
        // and an AI with no pool plans directives it can never pay for and
        // sits there emitting nothing (the SG1 task-5 finding, verbatim).
        FireSyncedPlayerAdded(pNum);

        if (!replay::IsReplaying()) {
            // Durability (RuntimeAIRoster.h). Not on the replay path: a replay
            // re-declares this seat from the recording every time it runs, so a
            // row would be a second, weaker copy of a fact the stream already
            // owns — and a replay room is not a war anything resumes.
            RecordRuntimeSeat(ctx, plugin.id, rq.teamId, pNum);
        }

        if (replay::IsReplaying()) {
            // The AI's output is an INPUT (PLAN-replay §7.1) and is fed from
            // the recording at the drain in TickAI. Booting a second copy of
            // the brain here would have it observe a world it never saw live
            // and push commands the replay then discards — cost with no effect,
            // and a needless divergence surface. The virtual player above IS
            // registered, because that is what the recorded commands are
            // attributed to.
            SLOG(SPRING_LOG_NOTICE,
                "replay: seated AI virtual player #%d '%s' on team %d without "
                "its runtime — the recorded command stream is authoritative",
                pNum, p.name.c_str(), rq.teamId);
            continue;
        }

        // allyTeam mirrors the start-up block: teams are their own ally until
        // a real alliance concept exists.
        if (ctx.aiPool.AddAI(plugin.id, rq.teamId, rq.teamId, plugin.code,
                             plugin.folderPath, ctx.aiSpawnEnv.mapDataDir,
                             ctx.aiSpawnEnv.defExportDir, pNum)) {
            SLOG(SPRING_LOG_NOTICE,
                "seated AI '%s' (%s) on team %d mid-game as virtual player #%d",
                plugin.displayName.c_str(), plugin.id.c_str(), rq.teamId, pNum);
        } else {
            // The player stays registered: it already took a number, synced Lua
            // already saw it join, and retracting it would be a second synced
            // change nothing recorded. It simply has no brain, which the log
            // says outright.
            SLOG(SPRING_LOG_ERROR,
                "failed to init AI '%s' on team %d (virtual player #%d is "
                "seated but has no runtime)",
                plugin.id.c_str(), rq.teamId, pNum);
        }
    }
}

void RestoreRuntimeAISeats(GameServerContext& ctx)
{
    // Only ever called on the resume path (server_main, right after
    // hibernate::DoResume succeeded). A fresh stage has no seats to restore by
    // definition, and a replay feeds this hook's declarations from its own
    // stream — see RecordRuntimeSeat.
    const std::vector<RuntimeAISeat> seats =
        RuntimeAIRoster::ForRoom(ctx.db.Handle(), ctx.roomId);
    if (seats.empty())
        return;

    for (const RuntimeAISeat& seat : seats) {
        const bool teamActive = teamHandler.IsActiveTeam(seat.team);
        const RuntimeAIRestoreVerdict verdict = DecideRuntimeAIRestore(
            seat, teamActive, PlayerNumTaken(seat.playerNum),
            teamActive && TeamHasActiveAI(seat.team));

        if (verdict != RuntimeAIRestoreVerdict::Restore) {
            // NOTICE and not WARNING: every refusal here is a legitimate shape
            // of a war whose roster changed while it was frozen. The row is
            // left alone — the seat is still what the restored synced state is
            // keyed by, and deleting it would hide the mismatch from the next
            // resume too.
            SLOG(SPRING_LOG_NOTICE,
                "runtime AI seat '%s' (team %d, player #%d, seated frame %d): %s",
                seat.aiId.c_str(), seat.team, seat.playerNum, seat.seatedFrame,
                RuntimeAIRestoreVerdictName(verdict));
            continue;
        }

        ResolvedAIPlugin plugin;
        std::string err;
        if (!ResolveAIPlugin(ctx.aiSpawnEnv.enginePath, ctx.aiSpawnEnv.gamePath,
                             seat.aiId, plugin, err)) {
            SLOG(SPRING_LOG_ERROR,
                "runtime AI seat '%s' (team %d, player #%d) cannot be restored: "
                "%s — this side resumes with its state and no runtime",
                seat.aiId.c_str(), seat.team, seat.playerNum, err.c_str());
            continue;
        }
        if (plugin.isLuaAI) {
            SLOG(SPRING_LOG_WARNING,
                "runtime AI seat '%s' (team %d) is a LuaAI entry and cannot be "
                "restored (its runtime is the game's own gadgets)",
                seat.aiId.c_str(), seat.team);
            continue;
        }

        // The virtual player comes back at its RECORDED number, not from the
        // counter: the resumed world's synced state is keyed by it
        // (`authority_player_<n>`, the ledger's spend identity), so minting a
        // fresh one would strand this AI's pool and orders under the retired
        // number — the same rule D16 imposes on a reconnecting human.
        // AddPlayer fills any gap below it with inactive stubs.
        CPlayer p;
        p.name      = "AI:" + plugin.id + "@t" + std::to_string(seat.team);
        p.team      = seat.team;
        p.active    = true;
        p.spectator = false;
        p.isAI      = true;
        p.playerNum = seat.playerNum;
        playerHandler.AddPlayer(p);
        // Keep the counter ahead of every restored number, or the next dynamic
        // joiner (human or caretaker) is handed a number this AI already holds.
        if (seat.playerNum >= ctx.nextPlayerNum)
            ctx.nextPlayerNum = seat.playerNum + 1;

        // Same hand-delivered onboarding a live seat gets, and idempotent by
        // construction: game_authority.lua's PlayerAdded returns early when
        // `authority_granted_<n>` is already set, and the resumed snapshot
        // brought that flag back with the pool. So this MINTS a pool only in
        // the case where the snapshot has none for this number, and never
        // top-ups a restored one.
        FireSyncedPlayerAdded(seat.playerNum);

        if (ctx.aiPool.AddAI(plugin.id, seat.team, seat.team, plugin.code,
                             plugin.folderPath, ctx.aiSpawnEnv.mapDataDir,
                             ctx.aiSpawnEnv.defExportDir, seat.playerNum)) {
            SLOG(SPRING_LOG_NOTICE,
                "restored runtime AI '%s' (%s) on team %d as virtual player #%d "
                "(seated frame %d before the freeze)",
                plugin.displayName.c_str(), plugin.id.c_str(), seat.team,
                seat.playerNum, seat.seatedFrame);
        } else {
            SLOG(SPRING_LOG_ERROR,
                "failed to init restored AI '%s' on team %d (virtual player #%d "
                "is seated but has no runtime)",
                plugin.id.c_str(), seat.team, seat.playerNum);
        }
    }
}
