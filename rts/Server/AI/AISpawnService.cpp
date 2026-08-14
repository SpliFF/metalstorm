#define LOG_SECTION "ai-spawn"

#include "AISpawnService.h"

#include "AISpawn.h"
#include "AIRuntimePool.h"
#include "Server/GameServerContext.h"
#include "Server/PlayerOnboarding.h"
#include "Server/ReplayPlayer.h"
#include "Server/Simulation.h"
#include "Game/Players/Player.h"
#include "Game/Players/PlayerHandler.h"
#include "Sim/Misc/TeamHandler.h"
#include "System/SpringLog/SpringLog.h"

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
