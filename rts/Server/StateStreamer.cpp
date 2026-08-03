#include "StateStreamer.h"
#include "GameServerContext.h"

#include "Simulation.h"
#include "Protocol.h"
#include "ClientSession.h"
#include "EntityStateSerializer.h"
#include "PieceStateSerializer.h"
#include "BuildActivitySerializer.h"
#include "CombatEventCollector.h"
#include "Sim/Weapons/DamageField.h"
#include "GameOverState.h"
#include "DecalEventCollector.h"
#include "ServerDecalHandler.h"
#include "ServerTrackEmitter.h"
#include "SoundEventCollector.h"
#include "ProjectileEventCollector.h"
#include "IntelEventCollector.h"
#include "PlayerTeamEventCollector.h"
#include "UnitLifecycleCollector.h"
#include "FeatureLifecycleCollector.h"
#include "UnitCommandCollector.h"
#include "StandingOrders.h"
#include "OrgGroups.h"
#include "PerfMetrics.h"
#include "SyncedInputJournal.h"
#include "AI/AIRuntimePool.h"
#include "WebTransport/WebTransportServer.h"
#include "Lua/LuaRules.h"
#include "Lua/LuaHandleSynced.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/Team.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/Wind.h"
#include "Sim/Misc/ModInfo.h"
#include "Sim/Misc/GlobalConstants.h"
#include "Map/ReadMap.h"
#include "System/SpringLog/SpringLog.h"
#include "System/EventHandler.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <variant>
#include <type_traits>
#include <utility>

#define LOG_SECTION "server"

namespace {

// Convert a synced Param value into wire kind + value fields. Spring stores
// bool/float/string; the client rules-param mirror is number|string, so a
// bool is encoded as Number(0/1). CALLED-OUT divergence (see protocol.fbs
// RulesParamValueKind): a `false` reads back as 0 (truthy in Lua), not false.
void ParamToWire(const LuaRulesParams::Param& p,
                 SpringWeb::RulesParamValueKind& kind,
                 double& numVal, std::string& strVal) {
    kind = SpringWeb::RulesParamValueKind_Nil;
    numVal = 0.0;
    std::visit([&](auto&& v) {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, bool>) {
            kind = SpringWeb::RulesParamValueKind_Number; numVal = v ? 1.0 : 0.0;
        } else if constexpr (std::is_same_v<T, float>) {
            kind = SpringWeb::RulesParamValueKind_Number; numVal = static_cast<double>(v);
        } else if constexpr (std::is_same_v<T, std::string>) {
            kind = SpringWeb::RulesParamValueKind_String; strVal = v;
        }
    }, p.value);
}

// A changed key, carrying the LOS bitmask to filter it against per session.
// For adds/changes that's the NEW param's los; for deletions the OLD param's
// los (so exactly the sessions that could have had the key are told to drop it).
struct ChangedParam {
    std::string key;
    SpringWeb::RulesParamValueKind kind = SpringWeb::RulesParamValueKind_Nil;
    double numVal = 0.0;
    std::string strVal;
    int los = LuaRulesParams::RULESPARAMLOS_PRIVATE;
};

// Diff old→now: emit adds/changes (value OR los differs) and deletions.
void ComputeParamDelta(const LuaRulesParams::Params& oldParams,
                       const LuaRulesParams::Params& nowParams,
                       std::vector<ChangedParam>& out) {
    for (const auto& kv : nowParams) {
        const auto it = oldParams.find(kv.first);
        // A los change matters too: it can newly reveal/hide the key to a
        // scope, so treat it as a change and re-filter per session.
        if (it != oldParams.end() &&
            it->second.los == kv.second.los &&
            it->second.value == kv.second.value)
            continue;
        ChangedParam c;
        c.key = kv.first;
        c.los = kv.second.los;
        ParamToWire(kv.second, c.kind, c.numVal, c.strVal);
        out.push_back(std::move(c));
    }
    for (const auto& kv : oldParams) {
        if (nowParams.find(kv.first) != nowParams.end())
            continue;
        ChangedParam c;
        c.key = kv.first;
        c.los = kv.second.los;            // old los: who could have seen it
        c.kind = SpringWeb::RulesParamValueKind_Nil;  // delete on the client
        out.push_back(std::move(c));
    }
}

} // namespace

void StateStreamer::Tick(int /*frameNum*/) {
    // Post-game: everything below CheckWinCondition is a *producer* — it
    // streams state, evaluates standing orders, ticks the AI. Once the result
    // has gone out the sim is frozen (server_main's SimFrame gate) so none of
    // it has anything new to say, and re-running it on a stationary frame is
    // actively harmful: the cadence gates here are all `frame % N == 0`, so a
    // frame that happens to be divisible by 30 (14610 was) would fire every
    // "once a second" broadcast at the full 30 Hz tick rate for the whole
    // observation window. See PostGamePolicy.h for the freeze rationale.
    //
    // Latched *before* CheckWinCondition so the tick that declares the result
    // still runs the full pipeline once — clients get the final board state
    // streamed alongside the game-over GameInfo, not the state from up to
    // three frames earlier.
    const bool wasOver = gameOverSent;
    CheckWinCondition(0);
    if (wasOver)
        return;
    StreamResources(0);
    StreamCommandQueues(0);
    BroadcastGameInfo(0);
    StreamEntityState(0);
    StreamPieceState(0);
    StreamBuildActivity(0);
    EvaluateStandingOrders(0);
    TickAI(0);
    BroadcastCombatEvents(0);
    BroadcastEntityDeaths(0);
    BroadcastSensorUpdates(0);
    BroadcastDecals(0);
    BroadcastHeightmapUpdates(0);
    BroadcastSendToUnsynced(0);
    BroadcastPlayerTeamEvents(0);
    BroadcastTeamStats(0);
    BroadcastRulesParams(0);
    PumpLuaRulesMsgLoopback(0);
    BroadcastUnitLifecycle(0);
    BroadcastFeatureLifecycle(0);
    BroadcastUnitCommands(0);
    StreamLosBitmaps(0);
}

// Check win condition every ~1s (30 ticks) after frame 30.
// Skipped when cheats are enabled — scenarios intentionally
// leave AI slots empty (NullAI has no startunit) and rely on
// cheats to keep the sim running indefinitely. Without this
// guard the hardcoded "team 0 or 1 empty → other wins" check
// fires at frame 60 of any scenario, terminates the sim, and
// every subsequent /api/exec call times out waiting for the
// sim thread.
void StateStreamer::CheckWinCondition(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sim = ctx.sim;
    int frame = sim.GetFrameNum();
    if (gameOverSent)
        return;

    // 1. Lua-declared game over — a game gadget called Spring.GameOver(winners)
    //    (relayed here via GameOverState). This is the faithful path and must
    //    fire regardless of cheats / team count, so it's checked every tick and
    //    ahead of the hardcoded fallback below.
    {
        std::vector<uint8_t> winners;
        if (gameOverRelay.ConsumePending(winners)) {
            gameOverSent = true;
            SLOG(SPRING_LOG_NOTICE,
                "GAME OVER: Spring.GameOver declared, %zu winning allyteam(s) (frame %d)",
                winners.size(), frame);
            auto gameOver = Protocol::BuildGameInfo(
                ctx.mapId, ctx.gameId, gs->speedFactor,
                static_cast<uint32_t>(frame), gs->paused,
                0, 0, 0, 0, 0, modInfo.legacyCoordSystem, unitHandler.MaxUnits(),
                /*gameOver*/ true, winners);
            rtcServer.BroadcastStream(StreamClass::Control, gameOver.data(), gameOver.size(), kEventLaneControl);
            return;
        }
    }

    // 2. Hardcoded last-team-standing fallback for games/scenarios with no
    //    game_over gadget (2-team only, teams 0/1 specifically). See
    //    ShouldRunEliminationFallback (GameOverState.h) for the gate rationale:
    //    skipped under cheats, and skipped entirely for Metalstorm (its
    //    hardcoded team-0/1 indices don't match Metalstorm room layouts —
    //    human teams can sit at any index, and AI/NullAI filler slots with no
    //    start unit are normal and must not read as "eliminated").
    if (frame > 30 && (frame % 30) == 0 && winningTeam < 0
        && ShouldRunEliminationFallback(ctx.gameId, gs->cheatEnabled)) {
        // Count alive units per team
        int alive[2] = {0, 0};
        const auto& activeUnits = unitHandler.GetActiveUnits();
        for (CUnit* u : activeUnits) {
            if (u && !u->isDead && u->team >= 0 && u->team < 2)
                alive[u->team]++;
        }

        if (alive[0] == 0 && alive[1] > 0) winningTeam = 1;
        else if (alive[1] == 0 && alive[0] > 0) winningTeam = 0;

        if (winningTeam >= 0) {
            gameOverSent = true;
            // Map the winning team to its allyteam so the client can name the
            // winner (Spring winners are allyteams, not teams).
            std::vector<uint8_t> winners = {
                static_cast<uint8_t>(teamHandler.AllyTeam(winningTeam)) };
            SLOG(SPRING_LOG_NOTICE, "GAME OVER: team %d (allyteam %d) wins (frame %d)",
                winningTeam, teamHandler.AllyTeam(winningTeam), frame);
            // Latch the result in the relay even though this path builds its
            // own broadcast: `gameOverRelay` is what the sim freeze, the
            // post-game verb gate and the late-join replay all read, and a
            // fallback win has to stop the world exactly like a Lua-declared
            // one. ConsumePending is drained immediately — the broadcast is
            // right below, and the branch above is unreachable once
            // gameOverSent latches, so an un-drained `pending` would sit true
            // forever with nobody left to send it.
            gameOverRelay.Declare(winners, frame);
            { std::vector<uint8_t> drained; gameOverRelay.ConsumePending(drained); }
            // Broadcast GameInfo with game_over=true (NOT via paused — a normal
            // pause must not end the game) + the winning allyteam.
            auto gameOver = Protocol::BuildGameInfo(
                ctx.mapId, ctx.gameId, gs->speedFactor,
                static_cast<uint32_t>(frame), gs->paused,
                0, 0, 0, 0, 0, modInfo.legacyCoordSystem, unitHandler.MaxUnits(),
                /*gameOver*/ true, winners);
            rtcServer.BroadcastStream(StreamClass::Control, gameOver.data(), gameOver.size(), kEventLaneControl);
        }
    }
}

// Broadcast resource updates every 10 ticks (~0.33s)
void StateStreamer::StreamResources(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto& sim = ctx.sim;
    int curFrame = sim.GetFrameNum();
    if (curFrame >= 0 && (curFrame % 10) == 0 && rtcServer.GetClientCount() > 0) {
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            if (session.team < 0) return;
            CTeam* team = teamHandler.Team(session.team);
            if (!team) return;
            auto msg = Protocol::BuildResourceUpdate(
                static_cast<uint8_t>(session.team),
                team->res.metal,        team->resStorage.metal,
                team->res.energy,       team->resStorage.energy,
                team->resPrevIncome.metal,   team->resPrevIncome.energy,
                team->resPrevPull.metal,     team->resPrevPull.energy,
                team->resPrevExpense.metal,  team->resPrevExpense.energy,
                team->resShare.metal,        team->resShare.energy,
                team->resPrevSent.metal,     team->resPrevSent.energy,
                team->resPrevReceived.metal, team->resPrevReceived.energy,
                team->resPrevExcess.metal,   team->resPrevExcess.energy);
            rtcServer.SendReliable(clientId, msg.data(), msg.size());
        });
    }
}

// Broadcast unit command queues every 30 ticks (~1s). Queues
// change far slower than entity state, so a low cadence is
// fine; widgets that read GetUnitCommands tolerate the
// occasional stale frame.
//
// Visibility: queues are sent for any team allied with the
// session's team (own team + teammates). Build-command descs
// stay own-team only — they're meaningless for allied units
// the player can't actually issue build orders to.
void StateStreamer::StreamCommandQueues(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto& sim = ctx.sim;
    int curFrame = sim.GetFrameNum();
    if (curFrame >= 0 && (curFrame % 30) == 0 && rtcServer.GetClientCount() > 0) {
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            if (session.team < 0) return;

            // Gather units across every team in the session's
            // alliance. AlliedTeams handles asymmetric alliance
            // declarations correctly. teamHandler.AllyTeam(self)
            // is always self-allied so own units are included.
            std::vector<CUnit*> visibleUnits;
            const int activeTeams = teamHandler.ActiveTeams();
            for (int t = 0; t < activeTeams; ++t) {
                if (!teamHandler.AlliedTeams(session.team, t)) continue;
                const auto& tu = unitHandler.GetUnitsByTeam(t);
                visibleUnits.insert(visibleUnits.end(), tu.begin(), tu.end());
            }
            if (!visibleUnits.empty()) {
                auto msg = Protocol::BuildUnitCommandQueues(visibleUnits);
                rtcServer.SendReliable(clientId, msg.data(), msg.size());
            }

            // Cmd descs are scoped to the player's current
            // selection. Each entry is ~50 bytes × ~30 commands × N
            // selected units; sending the full own-team set every
            // tick would dwarf the entity stream. We fall back to
            // the full own-team list only when the client hasn't
            // sent any SelectionState yet (older clients).
            const auto& ownUnits = unitHandler.GetUnitsByTeam(session.team);
            std::vector<CUnit*> cmdDescTargets;
            if (!session.selectedUnits.empty()) {
                cmdDescTargets.reserve(session.selectedUnits.size());
                for (CUnit* u : ownUnits) {
                    if (u && session.selectedUnits.count(static_cast<uint32_t>(u->id))) {
                        cmdDescTargets.push_back(u);
                    }
                }
            } else if (session.lastSelectionSeq == 0) {
                cmdDescTargets = ownUnits;
            }
            if (!cmdDescTargets.empty()) {
                auto descs = Protocol::BuildUnitCmdDescs(cmdDescTargets);
                rtcServer.SendReliable(clientId, descs.data(), descs.size());
            }

            // Transport / self-destruct / stockpile / armored state.
            // All four piggy-back on the same allied-team unit set used
            // for command queues — emit each as a snapshot. The
            // Build*Update helpers internally skip units that have no
            // active state, so most ticks send tiny (often empty)
            // payloads.
            if (!visibleUnits.empty()) {
                auto transport = Protocol::BuildUnitTransportUpdate(visibleUnits);
                rtcServer.SendReliable(clientId, transport.data(), transport.size());

                auto selfd = Protocol::BuildUnitSelfDUpdate(visibleUnits);
                rtcServer.SendReliable(clientId, selfd.data(), selfd.size());

                auto stock = Protocol::BuildUnitStockpileUpdate(visibleUnits);
                rtcServer.SendReliable(clientId, stock.data(), stock.size());

                auto armor = Protocol::BuildUnitArmoredUpdate(visibleUnits);
                rtcServer.SendReliable(clientId, armor.data(), armor.size());
            }
        });
    }
}

// Broadcast periodic GameInfo every 30 ticks (~1s)
void StateStreamer::BroadcastGameInfo(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sim = ctx.sim;
    int curFrame = sim.GetFrameNum();
    if (curFrame >= 0 && (curFrame % 30) == 0 && rtcServer.GetClientCount() > 0 && !gameOverSent) {
        const float3& wv = envResHandler.GetCurrentWindVec();
        // gs->speedFactor is the live sim-speed multiplier (set by
        // the `speed <N>` server command via LuaExecEngine). Broadcast
        // it so the client's projectile integrator can scale its
        // wall-clock dt to sim-time — otherwise bolts overshoot at
        // slow-mo and fall short at fast-forward.
        auto msg = Protocol::BuildGameInfo(ctx.mapId, ctx.gameId, gs->speedFactor,
            static_cast<uint32_t>(curFrame), gs->paused,
            wv.x, wv.y, wv.z,
            envResHandler.GetCurrentWindStrength(),
            envResHandler.GetCurrentTidalStrength(),
            modInfo.legacyCoordSystem, unitHandler.MaxUnits());
        rtcServer.BroadcastStream(StreamClass::Control, msg.data(), msg.size(), kEventLaneControl);
    }
}

// Send entity state to connected clients every 3 ticks (~10 Hz)
// Full snapshot every 30 ticks (~1s), delta updates otherwise.
// Envelope: 0x02 = full snapshot, 0x03 = delta update.
void StateStreamer::StreamEntityState(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto& sim = ctx.sim;
    int curFrame = sim.GetFrameNum();
    if (curFrame >= 0 && (curFrame % 3) == 0 && rtcServer.GetClientCount() > 0) {
        bool isFullSnapshot = (curFrame % 30) == 0;

        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            // Map session->team to its ally team so the
            // visibility filter can skip enemy units that
            // aren't in this ally team's LOS.
            // Spectators: Global mode sees everything (-1),
            // Team mode sees spectatorVisibilityTeam's LOS.
            int viewerAllyTeam = -1;
            if (session.role == "spectator") {
                if (session.spectatorVisibilityMode == SpectatorVisibilityMode::Team
                    && session.spectatorVisibilityTeam >= 0
                    && teamHandler.IsValidTeam(session.spectatorVisibilityTeam)) {
                    viewerAllyTeam = teamHandler.AllyTeam(session.spectatorVisibilityTeam);
                }
                // else: Global mode or invalid team → viewerAllyTeam = -1 (see all)
            } else if (session.team >= 0 && teamHandler.IsValidTeam(session.team)) {
                viewerAllyTeam = teamHandler.AllyTeam(session.team);
            }

            // Collect candidate units (viewport-filtered or all)
            std::vector<CUnit*> candidates;
            if (session.HasViewport() && sim.HasMap()) {
                candidates = EntityState::CollectViewportUnits(
                    session.viewports.data(),
                    static_cast<int>(session.viewports.size()),
                    viewerAllyTeam);
            } else {
                candidates = EntityState::CollectAllUnits(viewerAllyTeam);
            }

            // (Def streaming removed — clients fetch the full def
            // set via HTTP at game start using AuthResponse's
            // defs_cache_key. See DefsCache::WriteIfMissing.)

            uint8_t envelope;
            std::vector<uint8_t> stateData;

            if (isFullSnapshot) {
                envelope = 0x02;
                stateData = EntityState::SerializeUnits(
                    candidates, EntityState::FIELD_ALL, viewerAllyTeam,
                    static_cast<uint32_t>(curFrame));
                session.deltaCache.Clear();
                for (CUnit* u : candidates)
                    session.deltaCache.Update(u, viewerAllyTeam);
            } else {
                std::vector<CUnit*> changed;
                for (CUnit* u : candidates) {
                    if (session.deltaCache.HasChanged(u, viewerAllyTeam))
                        changed.push_back(u);
                }
                for (CUnit* u : changed)
                    session.deltaCache.Update(u, viewerAllyTeam);

                envelope = 0x03;
                stateData = EntityState::SerializeUnits(
                    changed, EntityState::FIELD_ALL, viewerAllyTeam,
                    static_cast<uint32_t>(curFrame));
            }

            std::vector<uint8_t> frame;
            frame.reserve(1 + stateData.size());
            frame.push_back(envelope);
            frame.insert(frame.end(), stateData.begin(), stateData.end());
            // State tier, lane "entity": newest-wins against the prior entity
            // snapshot only. Piece state uses a separate lane (below) so the
            // two don't RESET each other before either transmits.
            rtcServer.SendUnreliable(clientId, frame.data(), frame.size(), kStateLaneEntity);
        });
    }
}

// Send animated piece transforms (envelope 0x05) at the same
// ~10 Hz cadence as projectiles. Piece animation is purely
// cosmetic so the lower rate is fine — the client interpolates.
// Visibility filtering reuses the per-session candidate list
// logic below by rebuilding it here; piece-transform fanout is
// small (only animated units appear in the payload), so the
// overhead is acceptable.
void StateStreamer::StreamPieceState(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto& sim = ctx.sim;
    int curFrame = sim.GetFrameNum();
    if (curFrame >= 0 && (curFrame % 3) == 0 && rtcServer.GetClientCount() > 0) {
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            int viewerAllyTeam = -1;
            if (session.role == "spectator") {
                if (session.spectatorVisibilityMode == SpectatorVisibilityMode::Team
                    && session.spectatorVisibilityTeam >= 0
                    && teamHandler.IsValidTeam(session.spectatorVisibilityTeam)) {
                    viewerAllyTeam = teamHandler.AllyTeam(session.spectatorVisibilityTeam);
                }
            } else if (session.team >= 0 && teamHandler.IsValidTeam(session.team)) {
                viewerAllyTeam = teamHandler.AllyTeam(session.team);
            }

            std::vector<CUnit*> candidates;
            if (session.HasViewport() && sim.HasMap()) {
                candidates = EntityState::CollectViewportUnits(
                    session.viewports.data(),
                    static_cast<int>(session.viewports.size()),
                    viewerAllyTeam);
            } else {
                candidates = EntityState::CollectAllUnits(viewerAllyTeam);
            }

            auto pieceData = PieceState::SerializeUnits(
                candidates, static_cast<uint32_t>(curFrame));
            if (pieceData.empty()) return;

            std::vector<uint8_t> pieceFrame;
            pieceFrame.reserve(1 + pieceData.size());
            pieceFrame.push_back(Protocol::ENVELOPE_PIECE_STATE);
            pieceFrame.insert(pieceFrame.end(), pieceData.begin(), pieceData.end());
            // State tier, lane "piece": newest-wins independently of entity.
            rtcServer.SendUnreliable(clientId, pieceFrame.data(), pieceFrame.size(),
                                     kStateLanePiece);
        });
    }
}

// Send build-activity snapshot (envelope 0x06) at the same
// ~10 Hz cadence. Per-session because enemy build activity
// respects LOS — the client treats the absence of an entry as
// "fade out the beam" so brief drops between snapshots don't
// pop. We send the snapshot even when no builders are active so
// the client can age out beams that completed or were cancelled
// since the last snapshot; SerializeAll returns a 6-byte header
// for the empty case, so the per-session bandwidth cost is ~7
// bytes every 3rd frame.
void StateStreamer::StreamBuildActivity(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto& sim = ctx.sim;
    int curFrame = sim.GetFrameNum();
    if (curFrame >= 0 && (curFrame % 3) == 0 && rtcServer.GetClientCount() > 0) {
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            int viewerAllyTeam = -1;
            if (session.role == "spectator") {
                if (session.spectatorVisibilityMode == SpectatorVisibilityMode::Team
                    && session.spectatorVisibilityTeam >= 0
                    && teamHandler.IsValidTeam(session.spectatorVisibilityTeam)) {
                    viewerAllyTeam = teamHandler.AllyTeam(session.spectatorVisibilityTeam);
                }
            } else if (session.team >= 0 && teamHandler.IsValidTeam(session.team)) {
                viewerAllyTeam = teamHandler.AllyTeam(session.team);
            }

            auto baData = BuildActivity::SerializeAll(
                static_cast<uint32_t>(curFrame), viewerAllyTeam);
            if (baData.empty()) return;

            std::vector<uint8_t> baFrame;
            baFrame.reserve(1 + baData.size());
            baFrame.push_back(Protocol::ENVELOPE_BUILD_ACTIVITY);
            baFrame.insert(baFrame.end(), baData.begin(), baData.end());
            // Vision tier (reliable uni, GW2): build progress must not be
            // dropped/superseded — the client ages beams off the snapshot, and
            // a skipped "build complete" frame would leave a ghost beam. Lower
            // priority than per-frame State so it never blocks entity updates.
            rtcServer.SendStream(clientId, StreamClass::Vision,
                                 baFrame.data(), baFrame.size());
        });
    }
}

// Evaluate standing orders every ~1s (30 ticks). Manager expires
// orders past their deadline against currentFrame and stamps
// notifications back through the change-notifier wired below.
void StateStreamer::EvaluateStandingOrders(int) {
    auto& sim = ctx.sim;
    if (sim.GetFrameNum() > 0 && (sim.GetFrameNum() % 30) == 0) {
        standingOrders.Evaluate(static_cast<uint32_t>(sim.GetFrameNum()));
        // Self-heal org rosters (dead squads leave; empty groups linger for
        // reinforcement — macro-orders §1) before the directive pass reads them.
        orgGroups.PruneDeadMembers();
        // Macro directives evaluate on the same ~1s cadence (strategic tempo,
        // change-driven broadcast — PLAN-macro-directives §1). Group-scoped
        // standing orders share the standingOrders pass above.
        directiveManager.Evaluate(static_cast<uint32_t>(sim.GetFrameNum()));
    }
}

namespace {
/// Flatten one drained AICommand into the journal's opaque payload
/// (PLAN-replay task 1). AICommand is not trivially copyable — it carries
/// three heap fields — so it cannot be memcpy'd into a record. The encoding
/// is deliberately dumb and self-describing-by-position rather than a
/// flatbuffer: nothing but the replay driver ever reads it back, it must not
/// acquire a schema dependency, and every field is fixed-width or
/// length-prefixed so a decoder is a mirror of this function.
///
/// Ordering note: the CreateGroup→IssueDirective token correlation is resolved
/// *within* a drained batch, so `groupToken`/`refToken` are meaningless across
/// batches. They are recorded anyway — a replay re-pushes the whole batch in
/// the same order and re-resolves them the same way.
std::vector<uint8_t> SerializeAICommand(const AICommand& c) {
    std::vector<uint8_t> out;
    out.reserve(96);
    auto putU8  = [&](uint8_t v)  { out.push_back(v); };
    auto putU32 = [&](uint32_t v) {
        for (int i = 0; i < 4; ++i) out.push_back(static_cast<uint8_t>(v >> (8 * i)));
    };
    auto putI32 = [&](int32_t v)  { putU32(static_cast<uint32_t>(v)); };
    auto putF32 = [&](float v)    {
        uint32_t bits; std::memcpy(&bits, &v, 4); putU32(bits);
    };

    putU8(static_cast<uint8_t>(c.kind));
    putI32(c.teamId);
    putI32(c.playerId);
    // UnitCommand fields
    putU32(c.unitId);
    putI32(c.commandId);
    putU8(c.options);
    const int nParams = (c.numParams < 0) ? 0
                      : (c.numParams > 8) ? 8 : c.numParams;
    putU8(static_cast<uint8_t>(nParams));
    for (int i = 0; i < nParams; ++i) putF32(c.params[i]);
    // Directive-shaped fields
    putU8(c.echelon);
    putU32(static_cast<uint32_t>(c.squadIds.size()));
    for (uint32_t id : c.squadIds) putU32(id);
    putU32(c.groupToken);
    putU32(c.groupId);
    putU32(c.refToken);
    putU8(c.directiveType);
    putU8(c.priority);
    putU8(c.shape);
    putU32(static_cast<uint32_t>(c.directiveParams.size()));
    for (float f : c.directiveParams) putF32(f);
    putU32(c.requestedStrength);
    putU32(c.expiresInFrames);
    putF32(c.withinX);
    putF32(c.withinZ);
    putF32(c.withinRadius);
    putU32(static_cast<uint32_t>(c.text.size()));
    out.insert(out.end(), c.text.begin(), c.text.end());
    return out;
}
} // namespace

// Tick AI runtime and drain AI commands.
//
// AI commands are applied here, on the sim thread, through the EXACT manager
// call + charge callin a human player's wire message hits (see
// ClientMessageHandler.cpp OrgGroupCreate / GroupDirective / GroupPosture) —
// one command path for humans and AI (PLAN-metalstorm-ai §1/§4, AI2). The AI
// has no CPlayer yet (AI3 unlanded), so its playerID is -1: the charge gadget
// maps that to nil → team-pool charging (game_authority_charge.lua), the
// interim "free-pass" the plan keeps until AI3 gives each AI slot a real pool.
void StateStreamer::TickAI(int) {
    auto& aiPool = ctx.aiPool;
    auto& sim = ctx.sim;
    aiPool.Tick(sim.GetFrameNum());

    auto aiCmds = aiPool.DrainCommands();
    if (aiCmds.empty()) return;

    const uint32_t frame = static_cast<uint32_t>(sim.GetFrameNum());
    // AI3: each AI slot is a real virtual player (its own playerID + pool), so
    // the charge callin is fed the command's own attributed playerId, not a
    // hardcoded -1. That routes the debit to authority_player_<id> (its own
    // pool) and lets the co-commander's own-pool-only flag be honoured — the
    // AI2+AI3 composition. A command with playerId == -1 (a test / unattributed
    // AI) still falls to the interim team-pool free-pass in the charge gadget.

    // createGroup→issueDirective correlation, resolved within this batch:
    // token → the real engine group id the create produced (0 if it failed).
    std::unordered_map<uint32_t, uint32_t> tokenToGroup;
    // §8 E6: clamp directive issue rate ≤ 1 / group / tick UNCONDITIONALLY —
    // a structural backstop below the planner so a defeated cost governor
    // (authority_cost_scale=0) still can't spam. Key: (team, groupKey), where
    // groupKey is the resolved group id for a group-scoped directive, else the
    // target area quantised to the region lookup cell for an area-scoped one
    // (its "group" analogue) — so distinct regions still each get a directive.
    std::unordered_set<uint64_t> directiveKeys;

    for (const auto& cmd : aiCmds) {
        // Journal chokepoint #4 of 5 (PLAN-replay task 1). AI output is an
        // INPUT to the sim, not a consequence of it: the AI runs in a separate
        // VM on its own threads, and which commands land on which tick depends
        // on that VM's scheduling — which is not part of the synced state and
        // is not reproducible by re-execution. So the drained command stream
        // must be recorded verbatim. Recorded before the switch, so all four
        // AICommandKinds are covered by one call site.
        const std::vector<uint8_t> aiBlob = SerializeAICommand(cmd);
        syncedinput::Journal().RecordAICommand(
            cmd.playerId, aiBlob.data(), aiBlob.size());

        switch (cmd.kind) {
            case AICommandKind::UnitCommand: {
                // Legacy generic per-unit path (test channel / non-Metalstorm
                // tactical AIs). The strategos actuator never emits this.
                CUnit* unit = unitHandler.GetUnit(cmd.unitId);
                if (unit == nullptr || unit->isDead) continue;
                if (unit->team != cmd.teamId) continue; // validate ownership
                Command simCmd(cmd.commandId, cmd.options);
                for (int i = 0; i < cmd.numParams; i++)
                    simCmd.PushParam(cmd.params[i]);
                unit->commandAI->GiveCommand(simCmd);
                break;
            }
            case AICommandKind::CreateGroup: {
                // Mirrors ClientMessageHandler OrgGroupCreate (no charge callin
                // exists for group create — the roster is free; the directive
                // that commits it is what charges).
                const uint32_t gid = orgGroups.Create(
                    cmd.teamId, static_cast<Echelon>(cmd.echelon), cmd.text,
                    cmd.squadIds, /*parentId*/ 0, frame);
                tokenToGroup[cmd.groupToken] = gid; // 0 on rejection (army tier)
                break;
            }
            case AICommandKind::IssueDirective: {
                // Resolve the target group: a same-batch token, a real id, or 0.
                uint32_t groupId = cmd.groupId;
                if (cmd.refToken != 0) {
                    auto it = tokenToGroup.find(cmd.refToken);
                    if (it == tokenToGroup.end() || it->second == 0)
                        continue;               // group create failed → drop
                    groupId = it->second;
                }
                // A group-scoped directive must target one this AI's team owns.
                if (groupId != 0) {
                    const OrgGroup* g = orgGroups.Get(groupId);
                    if (g == nullptr || g->team != cmd.teamId) continue;
                }

                // §8 E6 rate clamp (unconditional).
                uint64_t key;
                if (groupId != 0) {
                    key = (uint64_t(1) << 48) | groupId;
                } else if (cmd.directiveParams.size() >= 3) {
                    const int64_t qx = std::llround(cmd.directiveParams[0] / 256.0);
                    const int64_t qz = std::llround(cmd.directiveParams[2] / 256.0);
                    key = (uint64_t(2) << 48)
                        ^ (static_cast<uint64_t>(static_cast<uint32_t>(qx)) << 16)
                        ^  static_cast<uint64_t>(static_cast<uint32_t>(qz));
                } else {
                    key = (uint64_t(3) << 48);   // area, no anchor → one/team/tick
                }
                const uint64_t clampKey =
                    (static_cast<uint64_t>(static_cast<uint32_t>(cmd.teamId)) << 52) ^ key;
                if (!directiveKeys.insert(clampKey).second) continue; // already this tick

                // Same charge gate as a human GroupDirective create. A veto
                // (insufficient authority) drops the directive, exactly as the
                // wire handler replies 402 and does not create it.
                if (!eventHandler.AllowDirectiveCreate(
                        cmd.teamId, cmd.playerId, groupId,
                        cmd.directiveType, cmd.requestedStrength))
                    continue;

                StandingOrderConditions conds;
                conds.idleOnly = true;
                if (cmd.withinRadius > 0.0f) {
                    conds.withinCenter = float3(cmd.withinX, 0.0f, cmd.withinZ);
                    conds.withinRadius = cmd.withinRadius;
                }
                const uint32_t did = directiveManager.Create(
                    cmd.teamId, static_cast<DirectiveType>(cmd.directiveType),
                    cmd.priority, static_cast<OrderShape>(cmd.shape),
                    cmd.directiveParams, conds, groupId, cmd.requestedStrength,
                    /*phasesJson*/ std::string(), cmd.expiresInFrames, frame);
                SLOG(SPRING_LOG_DEBUG,
                    "AI directive: team=%d created directive %u type=%u group=%u "
                    "reqStrength=%u (planner-issued, same path as a human's)",
                    cmd.teamId, did, static_cast<unsigned>(cmd.directiveType),
                    groupId, cmd.requestedStrength);
                break;
            }
            case AICommandKind::SetPosture: {
                uint32_t groupId = cmd.groupId;
                if (cmd.refToken != 0) {
                    auto it = tokenToGroup.find(cmd.refToken);
                    if (it == tokenToGroup.end() || it->second == 0) continue;
                    groupId = it->second;
                }
                if (groupId == 0) continue;   // posture needs a real group
                orgGroups.SetPosture(groupId, cmd.teamId, cmd.text);
                break;
            }
        }
    }
}

// Broadcast combat events + projectile lifecycle events. Projectiles
// moved from per-tick state streaming (envelope 0x04) to event-based:
// Fired/Impact/Trajectory events let the client run its own ballistic
// simulation between sparse server updates. See PLAN-network.md.
//
// Per-session LOS / intel filter: each session only receives events
// whose position is in its ally-team's line-of-sight, OR whose owner
// team is allied to the viewer (so a player always sees their own
// and allied projectiles even if the impact lands in fog of war).
// Spectators and pre-auth sessions get the unfiltered stream.
void StateStreamer::BroadcastCombatEvents(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto& sim = ctx.sim;
    auto events = combatEvents.Drain();
    combatStats.Accumulate(events);  // PLAN-headless task 2: per-weapon totals
    auto projDrain = projectileEvents.Drain();
    auto soundDrain = soundEvents.Drain();
    auto volleyDrain = volleyOutcomes.Drain();
    auto fieldDrain = damageFieldManager.DrainEvents();
    auto seismicDrain = intelEvents != nullptr
        ? intelEvents->DrainSeismicPings()
        : std::vector<SeismicPingData>{};
    const bool hasAny = !events.empty()
        || !projDrain.fired.empty()
        || !projDrain.impacts.empty()
        || !projDrain.trajectories.empty()
        || !soundDrain.empty()
        || !volleyDrain.empty()
        || !fieldDrain.empty()
        || !seismicDrain.empty();
    if (hasAny && rtcServer.GetClientCount() > 0) {
        const uint32_t frameNo = static_cast<uint32_t>(sim.GetFrameNum());

        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            int viewerAllyTeam = -1;
            if (session.role == "spectator") {
                if (session.spectatorVisibilityMode == SpectatorVisibilityMode::Team
                    && session.spectatorVisibilityTeam >= 0
                    && teamHandler.IsValidTeam(session.spectatorVisibilityTeam)) {
                    viewerAllyTeam = teamHandler.AllyTeam(session.spectatorVisibilityTeam);
                }
            } else if (session.team >= 0 && teamHandler.IsValidTeam(session.team)) {
                viewerAllyTeam = teamHandler.AllyTeam(session.team);
            }

            // Predicate: is event-position visible to the viewer?
            // Spectator (viewerAllyTeam < 0) sees everything.
            auto posVisible = [&](const float3& p) -> bool {
                if (viewerAllyTeam < 0) return true;
                if (losHandler == nullptr) return true;
                return losHandler->InLos(p, viewerAllyTeam)
                    || losHandler->InAirLos(p, viewerAllyTeam)
                    || losHandler->InRadar(p, viewerAllyTeam);
            };

            // Predicate: is the owner team friendly to the viewer?
            // (Always show own/ally projectiles regardless of LOS.)
            auto teamFriendly = [&](uint8_t projTeam) -> bool {
                if (viewerAllyTeam < 0) return true;
                if (!teamHandler.IsValidTeam(projTeam)) return false;
                return teamHandler.AllyTeam(projTeam) == viewerAllyTeam;
            };

            std::vector<ProjectileFiredEventData> fired;
            fired.reserve(projDrain.fired.size());
            for (const auto& e : projDrain.fired) {
                // Fired: owner-friendly, OR launch in LOS, OR target in LOS
                // (so a player sees an incoming missile at the moment its
                // trajectory grazes their LOS bubble).
                if (teamFriendly(e.team)
                    || posVisible(e.pos)
                    || posVisible(e.targetPos))
                    fired.push_back(e);
            }

            std::vector<ProjectileImpactEventData> impacts;
            impacts.reserve(projDrain.impacts.size());
            for (const auto& e : projDrain.impacts) {
                if (teamFriendly(e.team) || posVisible(e.pos))
                    impacts.push_back(e);
            }

            std::vector<ProjectileTrajectoryEventData> trajectories;
            trajectories.reserve(projDrain.trajectories.size());
            for (const auto& e : projDrain.trajectories) {
                if (teamFriendly(e.team) || posVisible(e.pos))
                    trajectories.push_back(e);
            }

            // Combat events also benefit from the same filter — the
            // current broadcast leaks fire+miss outcomes from fog.
            std::vector<CombatEventData> visibleCombat;
            visibleCombat.reserve(events.size());
            for (const auto& e : events) {
                if (viewerAllyTeam < 0 || posVisible(e.position))
                    visibleCombat.push_back(e);
            }

            // Sounds: same rule — owner team friendly OR position in LOS.
            // Drops the emission entirely for fog-of-war neutrals so
            // players can't audibly probe enemy positions.
            std::vector<SoundEventData> visibleSounds;
            visibleSounds.reserve(soundDrain.size());
            for (const auto& s : soundDrain) {
                if (teamFriendly(s.team) || posVisible(s.position))
                    visibleSounds.push_back(s);
            }

            // Seismic pings: emitted once per ally team that has a
            // seismic listener in range. Only forward pings whose
            // ally_team matches the viewer; spectators see all.
            std::vector<SeismicPingData> visiblePings;
            visiblePings.reserve(seismicDrain.size());
            for (const auto& p : seismicDrain) {
                if (viewerAllyTeam < 0 || p.allyTeam == viewerAllyTeam)
                    visiblePings.push_back(p);
            }

            // Statistical-combat volley outcomes — the PLAN-weapons.md
            // filtering matrix, finally implemented (PLAN §2.3, Q-D-c).
            //   * viewer sees the attacker (LOS/radar on the firing position,
            //     or the attacker is friendly)   -> FULL outcome (Hit/Miss,
            //     damage, attacker id + posture, team tint).
            //   * viewer OWNS the target but can't see the attacker -> UNKNOWN
            //     (no attacker id, no damage) PLUS a counterbattery radar-blip
            //     reveal at the firing position so statistical artillery is
            //     counterable (Q-D-c overrides the plan's v0 no-reveal default).
            //   * viewer sees only the target area -> UNKNOWN, no reveal.
            //   * viewer sees neither -> dropped.
            std::vector<VolleyOutcomeData> visibleVolleys;
            visibleVolleys.reserve(volleyDrain.size());
            for (const auto& v : volleyDrain) {
                const bool attackerVisible =
                    (viewerAllyTeam < 0) || teamFriendly(v.attackerTeam)
                    || posVisible(v.attackerPos);
                const bool viewerOwnsTarget =
                    (v.targetTeam != 255) && teamFriendly(v.targetTeam);
                const bool targetVisible =
                    (viewerAllyTeam < 0) || viewerOwnsTarget
                    || posVisible(v.targetPos);

                if (attackerVisible) {
                    // Full ground-truth outcome (spectators land here too).
                    visibleVolleys.push_back(v);
                    continue;
                }
                if (!targetVisible)
                    continue; // sees neither attacker nor impact — no leak.

                // Attacker hidden: strip the outcome to UNKNOWN, hide the
                // attacker id/team/posture/damage. Keep target_pos for impact FX
                // and the squad casualty hint; keep target_id only if the viewer
                // can legitimately resolve that unit.
                VolleyOutcomeData masked = v;
                masked.result       = 2; // CombatResult::Unknown
                masked.damage       = 0.0f;
                masked.attackerId   = 0;
                masked.attackerTeam = 255;
                masked.posture      = 0;
                if (!viewerOwnsTarget && !posVisible(v.targetPos))
                    masked.targetId = 0;
                // Counterbattery reveal only for the target's own team.
                if (viewerOwnsTarget) {
                    masked.revealAttacker = true;
                    masked.revealPos      = v.attackerPos;
                }
                visibleVolleys.push_back(masked);
            }

            // Damage-field lifecycle (Model 3, C6). Sent when the field area
            // overlaps the viewer's known space (center in LOS/radar), or the
            // field is the viewer's own — so a player always sees their own
            // barrage FX. Spectators see all. Removed events are forwarded to
            // any session that could have seen the Created (same predicate)
            // so stale barrage FX always gets torn down.
            std::vector<DamageFieldEventData> visibleFields;
            visibleFields.reserve(fieldDrain.size());
            for (const auto& f : fieldDrain) {
                if (viewerAllyTeam < 0 || teamFriendly(f.team) || posVisible(f.center))
                    visibleFields.push_back(f);
            }

            if (visibleCombat.empty() && fired.empty()
                && impacts.empty() && trajectories.empty()
                && visibleSounds.empty() && visiblePings.empty()
                && visibleVolleys.empty() && visibleFields.empty())
                return;

            auto batch = Protocol::BuildCombatEventBatch(
                frameNo, visibleCombat, fired, impacts, trajectories,
                visibleSounds, visiblePings, visibleVolleys, visibleFields);
            rtcServer.SendStream(clientId, StreamClass::Control, batch.data(), batch.size(), kEventLaneCombat);
        });
    }
}

// Broadcast unit deaths as EntityDestroy messages, filtered
// per-session by the LOS_INLOS mask captured at the moment of
// death (PLAN-intel.md Phase 7 ghost preservation). Sessions
// whose ally team had LOS see the destroy and clear the entity;
// sessions that only had PREVLOS/ghost or no contact at all
// never learn the unit died — their ghost persists until they
// LOS-scan the spot again (handled client-side). Spectators
// (allyTeam < 0) always receive the broadcast.
void StateStreamer::BroadcastEntityDeaths(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto deaths = unitDeaths.Drain();
    for (const auto& death : deaths) {
        auto msg = Protocol::BuildEntityDestroy(death.unitId, 1, death.x, death.y, death.z);
        // Bit 31 of losMask is the "ally team >= 32 — broadcast to
        // everyone" escape hatch (see UnitDeathEvent docs).
        const bool broadcastAll = (death.losMask & (1u << 31)) != 0;
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            int viewerAllyTeam = -1;
            if (session.role == "spectator") {
                if (session.spectatorVisibilityMode == SpectatorVisibilityMode::Team
                    && session.spectatorVisibilityTeam >= 0
                    && teamHandler.IsValidTeam(session.spectatorVisibilityTeam)) {
                    viewerAllyTeam = teamHandler.AllyTeam(session.spectatorVisibilityTeam);
                }
            } else if (session.team >= 0 && teamHandler.IsValidTeam(session.team)) {
                viewerAllyTeam = teamHandler.AllyTeam(session.team);
            }
            if (viewerAllyTeam < 0) {
                // Spectator — always notify.
                rtcServer.SendReliable(clientId, msg.data(), msg.size());
                return;
            }
            if (broadcastAll) {
                rtcServer.SendReliable(clientId, msg.data(), msg.size());
                return;
            }
            if (viewerAllyTeam < 32 && (death.losMask & (1u << viewerAllyTeam))) {
                rtcServer.SendReliable(clientId, msg.data(), msg.size());
            }
            // else: ally team had no LOS on the unit at death; skip
            // so the client's ghost (if any) persists. Snapshot
            // eviction handles cleanup for radar-only contacts since
            // the unit no longer appears in subsequent snapshots.
        });
    }
}

// Per-unit runtime sensor-radius changes — emitted by
// Spring.SetUnitSensorRadius. Broadcast reliably to every
// session so range-circle widgets (unit_stealth.lua etc.)
// refresh immediately. Spectators see all updates;
// visibility filtering is intentionally skipped because the
// override is also a visual-only hint and gives the same
// result the snapshot would carry once the underlying sim
// state propagates.
void StateStreamer::BroadcastSensorUpdates(int) {
    auto& rtcServer = ctx.rtcServer;
    auto sensorChanges = sensorUpdates.Drain();
    for (const auto& upd : sensorChanges) {
        auto msg = Protocol::BuildEntitySensorUpdate(
            upd.entityId,
            static_cast<SpringWeb::SensorType>(upd.sensorType),
            upd.radius);
        rtcServer.BroadcastReliable(msg.data(), msg.size());
    }
}

// Ground decals (scars from weapon explosions + track segments) —
// envelope 0x08. The explosion listener self-registers once on first
// reach (no separate init site needed). Drained once, then sent
// per-session with a LOS filter: each client only receives decals
// whose ground position its ally team can currently see (spectators
// and global-LOS see all). This stops scorch marks / treads from
// leaking enemy activity in unexplored fog. Reuses the same
// viewerAllyTeam + losHandler->InLos() machinery as the entity-state
// broadcast above.
void StateStreamer::BroadcastDecals(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto& sim = ctx.sim;
    static bool s_decalListenerReg = [](){ serverDecalHandler.Register(); return true; }();
    (void)s_decalListenerReg;
    // Lay vehicle tread segments for track-leaving movers this tick;
    // they join the scar drain below and share the LOS-filtered send.
    serverTrackEmitter.Emit(sim.GetFrameNum());
    auto scarDrain = scarEvents.Drain();
    auto trackDrain = trackSegmentEvents.Drain();
    if ((!scarDrain.empty() || !trackDrain.empty()) && rtcServer.GetClientCount() > 0) {
        const uint32_t decalFrame = static_cast<uint32_t>(sim.GetFrameNum());
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            int viewerAllyTeam = -1;
            if (session.role == "spectator") {
                if (session.spectatorVisibilityMode == SpectatorVisibilityMode::Team
                    && session.spectatorVisibilityTeam >= 0
                    && teamHandler.IsValidTeam(session.spectatorVisibilityTeam)) {
                    viewerAllyTeam = teamHandler.AllyTeam(session.spectatorVisibilityTeam);
                }
            } else if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                viewerAllyTeam = teamHandler.AllyTeam(session.team);

            // Spectators (no team) and global-LOS viewers see every
            // decal; everyone else is filtered to their LOS.
            const bool seeAll = (viewerAllyTeam < 0) ||
                (losHandler != nullptr && losHandler->GetGlobalLOS(viewerAllyTeam));

            std::vector<ScarEventData> visScars;
            std::vector<TrackSegmentEventData> visTracks;
            if (seeAll) {
                visScars = scarDrain;
                visTracks = trackDrain;
            } else if (losHandler != nullptr) {
                visScars.reserve(scarDrain.size());
                for (const auto& s : scarDrain)
                    if (losHandler->InLos(s.pos, viewerAllyTeam))
                        visScars.push_back(s);
                visTracks.reserve(trackDrain.size());
                for (const auto& t : trackDrain)
                    if (losHandler->InLos(t.pos, viewerAllyTeam))
                        visTracks.push_back(t);
            }
            if (visScars.empty() && visTracks.empty()) return;

            const auto decalBatch = Protocol::BuildDecalBatch(
                decalFrame, visScars, visTracks);
            rtcServer.SendStream(clientId, StreamClass::Bulk, decalBatch.data(), decalBatch.size(), kEventLaneDecals);
        });
    }
}

// Heightmap deformation broadcast (PLAN-deformable-terrain T2).
// Every synced height change this tick (engine craters via
// CBasicMapDamage::Update→RecalcArea, and the Spring.*HeightMap Lua
// family) recorded its changed corner-rect in CReadMap. Drain them,
// coalesce into one bounding rect (the common case is a single crater
// or one contiguous terraform op per tick), read the current corner
// heights, and broadcast to every client. Terrain has no fog of war,
// so no per-session LOS filtering — one BroadcastReliable for all.
void StateStreamer::BroadcastHeightmapUpdates(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sim = ctx.sim;
    if (readMap != nullptr) {
        // Always drain (bounds memory even with no clients connected);
        // only build + broadcast when someone is listening.
        auto dirty = readMap->DrainServerDirtyHeightRects();
        if (!dirty.empty() && rtcServer.GetClientCount() > 0) {
            int x1 = dirty[0].x1, z1 = dirty[0].z1;
            int x2 = dirty[0].x2, z2 = dirty[0].z2;
            for (const auto& r : dirty) {
                x1 = std::min(x1, r.x1); z1 = std::min(z1, r.z1);
                x2 = std::max(x2, r.x2); z2 = std::max(z2, r.z2);
            }
            // Clamp to inclusive corner bounds [0..mapx] x [0..mapy].
            x1 = std::max(x1, 0); z1 = std::max(z1, 0);
            x2 = std::min(x2, mapDims.mapx); z2 = std::min(z2, mapDims.mapy);
            if (x2 >= x1 && z2 >= z1) {
                const auto hmBatch = Protocol::BuildHeightmapUpdate(
                    static_cast<uint32_t>(sim.GetFrameNum()),
                    x1, z1, x2, z2,
                    readMap->GetCornerHeightMapSynced(), mapDims.mapxp1);
                rtcServer.BroadcastStream(StreamClass::Bulk, hmBatch.data(), hmBatch.size());
            }
        }
    }
}

// SendToUnsynced forwards — synced LuaRules gadgets call
// Spring.SendToUnsynced(topic, ...) to hand work to their
// unsynced halves. The unsynced state on the headless server is
// killed (see CSplitLuaHandle::InitUnsynced), so each call is
// queued by CSyncedLuaHandle::SendToUnsynced into
// sendToUnsyncedEvents and dispatched to every client here. The
// widget worker peels arg[0] as the topic and routes it through
// gadgetHandler:AddSyncAction.
void StateStreamer::BroadcastSendToUnsynced(int) {
    auto& rtcServer = ctx.rtcServer;
    auto syncEvents = sendToUnsyncedEvents.Drain();
    if (!syncEvents.empty() && rtcServer.GetClientCount() > 0) {
        for (const auto& ev : syncEvents) {
            auto msg = Protocol::BuildSendToUnsyncedEvent(ev);
            rtcServer.BroadcastReliable(msg.data(), msg.size());
        }
    }
}

// Player/team status changes — PlayerChanged (spec/team change),
// PlayerRemoved (disconnect), TeamDied. The server fires the matching
// eventHandler callins into its own synced Lua directly; this batch
// carries them across the network to the unsynced LuaUI worker, which
// updates its roster and fans out to the widget callins. Reliable,
// low-frequency, unfiltered (player/team identity + life/death are
// public). Drained even with zero clients so the queue can't grow
// unbounded in a connectionless game.
void StateStreamer::BroadcastPlayerTeamEvents(int) {
    auto& rtcServer = ctx.rtcServer;
    auto ptEvents = playerTeamEvents.Drain();
    if (!ptEvents.empty() && rtcServer.GetClientCount() > 0) {
        auto msg = Protocol::BuildPlayerTeamEventBatch(ptEvents);
        rtcServer.BroadcastStream(StreamClass::Control, msg.data(), msg.size(), kEventLaneControl);
    }
}

// Team stats-history (PLAN-bar Spring.GetTeamStatsHistory). The sim
// already accumulates each team's TeamStatistics in CTeam::statHistory
// (a new entry finalises every TeamStatistics::statsPeriod=15s; the
// back() entry is the live, still-accumulating one). Stream it as a
// once-per-game-second incremental batch: for each active team send the
// slots from our last-finalised cursor through the live tail, so newly
// finalised entries and the freshest live tail both reach the worker.
// Unfiltered (like TeamStartInfo / PlayerTeamEventBatch); the worker
// applies Recoil's alliance gate at the read site. Skipped when nobody
// is connected — the cursor stays put and catches up on first connect.
void StateStreamer::BroadcastTeamStats(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sim = ctx.sim;
    if (sim.GetFrameNum() > 0 && (sim.GetFrameNum() % GAME_SPEED) == 0 &&
        rtcServer.GetClientCount() > 0) {
        const int activeTeams = teamHandler.ActiveTeams();
        if (static_cast<int>(lastSentStatFinalized.size()) < activeTeams)
            lastSentStatFinalized.resize(activeTeams, 0);

        // A new client joined since the last broadcast → rewind every
        // cursor so this batch carries each team's full history (the late
        // joiner has none yet; existing clients overwrite by index).
        const int statClients = rtcServer.GetClientCount();
        if (statClients > lastStatBroadcastClients)
            std::fill(lastSentStatFinalized.begin(), lastSentStatFinalized.end(), 0u);
        lastStatBroadcastClients = statClients;

        std::vector<Protocol::TeamStatsHistoryItemData> items;
        for (int t = 0; t < activeTeams; ++t) {
            const CTeam* team = teamHandler.Team(t);
            if (team == nullptr || team->statHistory.empty()) continue;

            const uint32_t fullCount = static_cast<uint32_t>(team->statHistory.size());
            uint32_t base = lastSentStatFinalized[t];
            if (base > fullCount - 1) base = fullCount - 1;  // history never shrinks, defensive

            Protocol::TeamStatsHistoryItemData item;
            item.teamId = static_cast<uint32_t>(t);
            item.baseIndex = base;
            item.entries.reserve(fullCount - base);
            for (uint32_t i = base; i < fullCount; ++i) {
                const TeamStatistics& s = team->statHistory[i];
                item.entries.emplace_back(
                    s.frame,
                    s.metalUsed,     s.energyUsed,
                    s.metalProduced, s.energyProduced,
                    s.metalExcess,   s.energyExcess,
                    s.metalReceived, s.energyReceived,
                    s.metalSent,     s.energySent,
                    s.damageDealt,   s.damageReceived,
                    s.unitsProduced, s.unitsDied,
                    s.unitsReceived, s.unitsSent,
                    s.unitsCaptured, s.unitsOutCaptured, s.unitsKilled);
            }
            items.push_back(std::move(item));
            lastSentStatFinalized[t] = fullCount - 1;  // tail stays resendable
        }
        if (!items.empty()) {
            auto msg = Protocol::BuildTeamStatsHistoryBatch(items);
            rtcServer.BroadcastReliable(msg.data(), msg.size());
        }
    }
}

// Rules-param wire producer (Spring.Set{Game,Team}RulesParam → client).
// The backbone routes all strategic state through rules params — region
// control (game `region_*`/`regions_rev`), objectives (`objective_*`),
// authority pools/event-ring (team params). None of it reached the browser
// before this: `handleRulesParamUpdate` on the client was a dead consumer.
//
// Each tick we diff the live synced param maps (game + every team) against
// last-sent baselines. Game params are broadcast unfiltered (matching
// Spring.GetGameRulesParams, unconditionally public). Team params are
// LOS-filtered per receiving session, replicating
// LuaSyncedRead::GetTeamRulesParam(s): same-ally → PRIVATE-and-below,
// allied-team → ALLIED-and-below, others → PUBLIC only, spectators → all.
// A fresh session first gets a `replace=true` snapshot of current state
// (so late joiners converge); thereafter only per-tick deltas.
void StateStreamer::BroadcastRulesParams(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions  = ctx.sessions;

    const int activeTeams = teamHandler.ActiveTeams();
    if (static_cast<int>(lastTeamParams.size()) < activeTeams)
        lastTeamParams.resize(activeTeams);

    // Diff against baselines (session-independent) and refresh baselines. We
    // do this even with nobody connected so a joiner's snapshot starts from a
    // correct baseline and we never emit a spurious "everything changed" delta.
    const LuaRulesParams::Params& gameNow = CSplitLuaHandle::GetGameParams();
    std::vector<ChangedParam> gameChanged;
    ComputeParamDelta(lastGameParams, gameNow, gameChanged);
    lastGameParams = gameNow;

    std::vector<std::vector<ChangedParam>> teamChanged(activeTeams);
    for (int t = 0; t < activeTeams; ++t) {
        const CTeam* team = teamHandler.Team(t);
        if (team == nullptr) continue;
        ComputeParamDelta(lastTeamParams[t], team->modParams, teamChanged[t]);
        lastTeamParams[t] = team->modParams;
    }

    if (rtcServer.GetClientCount() == 0)
        return;  // baselines updated; nothing to send

    // Returns the losStatus mask a session viewing team `ownerTeam`'s params
    // should use (LuaSyncedRead::GetTeamRulesParams). Spectators / unassigned
    // (team < 0) are all-seeing readers.
    auto teamLosMask = [&](const ClientSession& session, int ownerTeam) -> int {
        using namespace LuaRulesParams;
        int mask = RULESPARAMLOS_PUBLIC;
        const bool allSeeing = !(session.team >= 0 && teamHandler.IsValidTeam(session.team));
        if (allSeeing || teamHandler.AllyTeam(session.team) == teamHandler.AllyTeam(ownerTeam))
            mask |= RULESPARAMLOS_PRIVATE_MASK;
        else if (teamHandler.AlliedTeams(ownerTeam, session.team))
            mask |= RULESPARAMLOS_ALLIED_MASK;
        return mask;
    };

    // Game-scope delta is the same for every already-snapshotted session
    // (unfiltered) — build the entry list once.
    std::vector<Protocol::RulesParamEntryData> gameDeltaEntries;
    gameDeltaEntries.reserve(gameChanged.size());
    for (const auto& c : gameChanged) {
        Protocol::RulesParamEntryData e;
        e.keyId = InternKey(c.key);  // W3: use interned key
        if (e.keyId == 0) e.key = c.key;
        e.kind = c.kind;
        e.numVal = c.numVal;
        e.strVal = c.strVal;
        gameDeltaEntries.push_back(std::move(e));
    }
    // W3: Increment game params rev when there are changes
    if (!gameChanged.empty()) {
        gameParamsRev++;
    }

    // Intern EVERY key any message this tick can reference *before* the
    // per-session send loop, so the key dictionary a session is handed (below)
    // already covers the keyIds in the snapshot/deltas that follow it on the
    // same ordered Control stream. The snapshot loops intern lazily as they
    // build; doing it here first is what lets the dictionary-sync check see the
    // final keyDictionaryRev. (Previously the dictionary was sent before the
    // snapshot interned its keys, so a client's dictionary was missing exactly
    // the keys its snapshot used → every keyId decoded to "unknown" → the whole
    // rules-param stream went dark for that client.)
    for (const auto& kv : gameNow) InternKey(kv.first);
    for (int t = 0; t < activeTeams; ++t) {
        const CTeam* team = teamHandler.Team(t);
        if (team == nullptr) continue;
        for (const auto& kv : team->modParams) InternKey(kv.first);
    }
    // Delta keys too (a Nil/removed-key delta references a key no longer in the
    // live maps above).
    for (const auto& c : gameChanged) InternKey(c.key);
    for (int t = 0; t < activeTeams; ++t)
        for (const auto& c : teamChanged[t]) InternKey(c.key);

    sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
        // Keep the client's key dictionary current before any update that
        // references interned ids. Covers both the join snapshot and any keys
        // interned mid-game after this session already joined; a stale
        // dictionary silently drops every param whose keyId it can't resolve.
        if (session.rulesParamsKeyDictRev < keyDictionaryRev) {
            SendKeyDictionary(clientId);
            session.rulesParamsKeyDictRev = keyDictionaryRev;
        }

        if (!session.rulesParamsSnapshotSent) {
            // Join snapshot: full current state, replace=true per scope.
            {
                Protocol::RulesParamUpdateData snap;
                snap.scope = SpringWeb::RulesParamScope_Game;
                snap.replace = true;
                snap.paramsRev = ++gameParamsRev;  // W3: increment generation counter
                snap.params.reserve(gameNow.size());
                for (const auto& kv : gameNow) {
                    Protocol::RulesParamEntryData e;
                    e.keyId = InternKey(kv.first);  // W3: use interned key
                    if (e.keyId == 0) e.key = kv.first;  // fallback to string if interning fails
                    ParamToWire(kv.second, e.kind, e.numVal, e.strVal);
                    snap.params.push_back(std::move(e));
                }
                auto msg = Protocol::BuildRulesParamUpdate(snap);
                rtcServer.SendStream(clientId, StreamClass::Control, msg.data(), msg.size(), kEventLaneParams);
            }
            for (int t = 0; t < activeTeams; ++t) {
                const CTeam* team = teamHandler.Team(t);
                if (team == nullptr || team->modParams.empty()) continue;
                const int losMask = teamLosMask(session, t);
                Protocol::RulesParamUpdateData snap;
                snap.scope = SpringWeb::RulesParamScope_Team;
                snap.id = static_cast<uint32_t>(t);
                snap.replace = true;
                // W3: ensure we have enough team param revs
                if (teamParamsRev.size() <= static_cast<size_t>(t))
                    teamParamsRev.resize(t + 1, 0);
                snap.paramsRev = ++teamParamsRev[t];
                for (const auto& kv : team->modParams) {
                    if (!(kv.second.los & losMask)) continue;
                    Protocol::RulesParamEntryData e;
                    e.keyId = InternKey(kv.first);  // W3: use interned key
                    if (e.keyId == 0) e.key = kv.first;
                    ParamToWire(kv.second, e.kind, e.numVal, e.strVal);
                    snap.params.push_back(std::move(e));
                }
                if (snap.params.empty()) continue;
                auto msg = Protocol::BuildRulesParamUpdate(snap);
                rtcServer.SendStream(clientId, StreamClass::Control, msg.data(), msg.size(), kEventLaneParams);
            }
            session.rulesParamsSnapshotSent = true;
            return;
        }

        // Established session: deltas only.
        if (!gameDeltaEntries.empty()) {
            Protocol::RulesParamUpdateData upd;
            upd.scope = SpringWeb::RulesParamScope_Game;
            upd.paramsRev = gameParamsRev;  // W3: include generation counter
            upd.params = gameDeltaEntries;
            auto msg = Protocol::BuildRulesParamUpdate(upd);
            rtcServer.SendStream(clientId, StreamClass::Control, msg.data(), msg.size(), kEventLaneParams);
        }
        for (int t = 0; t < activeTeams; ++t) {
            if (teamChanged[t].empty()) continue;
            const int losMask = teamLosMask(session, t);
            Protocol::RulesParamUpdateData upd;
            upd.scope = SpringWeb::RulesParamScope_Team;
            upd.id = static_cast<uint32_t>(t);
            // W3: ensure we have enough team param revs
            if (teamParamsRev.size() <= static_cast<size_t>(t))
                teamParamsRev.resize(t + 1, 0);
            if (!teamChanged[t].empty())
                teamParamsRev[t]++;
            upd.paramsRev = teamParamsRev[t];
            for (const auto& c : teamChanged[t]) {
                if (!(c.los & losMask)) continue;
                Protocol::RulesParamEntryData e;
                e.keyId = InternKey(c.key);  // W3: use interned key
                if (e.keyId == 0) e.key = c.key;
                e.kind = c.kind;
                e.numVal = c.numVal;
                e.strVal = c.strVal;
                upd.params.push_back(std::move(e));
            }
            if (upd.params.empty()) continue;
            auto msg = Protocol::BuildRulesParamUpdate(upd);
            rtcServer.SendStream(clientId, StreamClass::Control, msg.data(), msg.size(), kEventLaneParams);
        }
    });
}

// SendLuaRulesMsg loopback — synced gadgets call
// Spring.SendLuaRulesMsg(msg); in Spring the message round-trips the
// net and fires gadget:RecvLuaMsg on every synced state including the
// sender's. The client forward rides the SendToUnsynced wire above
// ("$RecvLuaMsg" topic); here we deliver the same message to the
// server's own synced LuaRules (regardless of client count). Drained
// off the Lua stack so it isn't re-entrant with the originating call.
void StateStreamer::PumpLuaRulesMsgLoopback(int) {
    if (luaRules != nullptr) {
        for (const auto& ev : luaRulesMsgEvents.Drain())
            luaRules->RecvLuaMsg(ev.msg, ev.playerID);
    }
}

// Unit lifecycle events — UnitCreated / UnitFromFactory /
// UnitTaken / UnitGiven. Drained each tick. FromFactory / Taken /
// Given are broadcast unfiltered (transfers are public). Created
// is filtered per-session to the viewer's ally team — enemy
// UnitCreated is synthesised client-side from first-visibility
// in the entity stream, so the server skips those.
void StateStreamer::BroadcastUnitLifecycle(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    if (unitLifecycleEvents != nullptr) {
        auto lifecycle = unitLifecycleEvents->Drain();
        if (!lifecycle.empty() && rtcServer.GetClientCount() > 0) {
            // Partition: public events (FromFactory/Taken/Given) go
            // out as one broadcast; Created is per-session filtered.
            std::vector<UnitLifecycleEventData> publicEvents;
            std::vector<UnitLifecycleEventData> createdEvents;
            publicEvents.reserve(lifecycle.size());
            for (const auto& e : lifecycle) {
                if (e.kind == UnitLifecycleKind::Created) {
                    createdEvents.push_back(e);
                } else {
                    publicEvents.push_back(e);
                }
            }

            if (!publicEvents.empty()) {
                auto msg = Protocol::BuildUnitLifecycleBatch(publicEvents);
                if (!msg.empty()) {
                    rtcServer.BroadcastReliable(msg.data(), msg.size());
                }
            }

            if (!createdEvents.empty()) {
                sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                    std::vector<UnitLifecycleEventData> filtered;
                    filtered.reserve(createdEvents.size());
                    for (const auto& e : createdEvents) {
                        if (session.team < 0) {
                            // Spectator — sees every team's Created.
                            filtered.push_back(e);
                            continue;
                        }
                        if (!teamHandler.IsValidTeam(static_cast<int>(e.unitTeam)))
                            continue;
                        if (teamHandler.AlliedTeams(
                                session.team, static_cast<int>(e.unitTeam)))
                        {
                            filtered.push_back(e);
                        }
                    }
                    if (filtered.empty()) return;
                    auto msg = Protocol::BuildUnitLifecycleBatch(filtered);
                    if (!msg.empty()) {
                        rtcServer.SendReliable(clientId, msg.data(), msg.size());
                    }
                });
            }
        }
    }
}

// Feature lifecycle events — FeatureCreated / FeatureDestroyed.
// Drained each tick. Broadcast unfiltered: wrecks and debris
// are visible to everyone (LOS gating on dynamic features
// isn't gameplay-critical in Spring; gadgets can hide a feature
// via the AllowFeatureCreation hook before it ever spawns, so
// by the time a Spawn event reaches us it's already public).
void StateStreamer::BroadcastFeatureLifecycle(int) {
    auto& rtcServer = ctx.rtcServer;
    if (featureLifecycleEvents != nullptr) {
        std::vector<FeatureSpawnEventData> featSpawns;
        std::vector<FeatureRemovedEventData> featRemoved;
        featureLifecycleEvents->Drain(featSpawns, featRemoved);
        if ((!featSpawns.empty() || !featRemoved.empty())
            && rtcServer.GetClientCount() > 0)
        {
            auto msg = Protocol::BuildFeatureLifecycleBatch(
                featSpawns, featRemoved);
            if (!msg.empty()) {
                rtcServer.BroadcastReliable(msg.data(), msg.size());
            }
        }
    }
}

// Unit command events — synced UnitCommand / UnitCmdDone
// callins. Filtered per-session to ally teams: a player only
// sees commands on units they're allowed to observe (own team
// + alliance). Spectators with team < 0 see every event.
// Drained once per tick regardless of subscribers.
void StateStreamer::BroadcastUnitCommands(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    if (unitCommandEvents != nullptr) {
        auto cmdEvents = unitCommandEvents->Drain();
        if (!cmdEvents.empty() && rtcServer.GetClientCount() > 0) {
            sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                std::vector<UnitCommandEventData> filtered;
                filtered.reserve(cmdEvents.size());
                for (const auto& e : cmdEvents) {
                    if (session.team < 0) {
                        // Spectator — sees everything.
                        filtered.push_back(e);
                        continue;
                    }
                    if (!teamHandler.IsValidTeam(static_cast<int>(e.unitTeam)))
                        continue;
                    if (teamHandler.AlliedTeams(
                            session.team, static_cast<int>(e.unitTeam)))
                    {
                        filtered.push_back(e);
                    }
                }
                if (filtered.empty()) return;
                auto msg = Protocol::BuildUnitCommandBatch(filtered);
                if (!msg.empty()) {
                    rtcServer.SendReliable(clientId, msg.data(), msg.size());
                }
            });
        }
    }
}

// Per-allyteam LOS bitmap stream (envelope 0x07). Sent 1 Hz
// per session; each player gets their own ally team's bitmap.
// Spectators receive every ally team's bitmap, round-robin
// capped at 4 per second to avoid bursts in 16-team FFA.
// The fog texture refresh is intentionally slower than entity
// updates — Recoil's minimap fog doesn't tick faster than 1 Hz
// either.
void StateStreamer::StreamLosBitmaps(int) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions = ctx.sessions;
    auto& sim = ctx.sim;
    int curFrame = sim.GetFrameNum();
    if (curFrame > 0 && (curFrame % GAME_SPEED) == 0
        && intelEvents != nullptr
        && losHandler != nullptr
        && rtcServer.GetClientCount() > 0)
    {
        const uint32_t frameNo = static_cast<uint32_t>(curFrame);
        const int activeAllyTeams = teamHandler.ActiveAllyTeams();
        // Per-spectator round-robin offset (in seconds). 4 ally
        // teams per second × 16 ally teams = full cycle in 4 s.
        const int specStride = 4;
        const int specSecond = curFrame / GAME_SPEED;

        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            int viewerAllyTeam = -1;
            if (session.role == "spectator") {
                if (session.spectatorVisibilityMode == SpectatorVisibilityMode::Team
                    && session.spectatorVisibilityTeam >= 0
                    && teamHandler.IsValidTeam(session.spectatorVisibilityTeam)) {
                    viewerAllyTeam = teamHandler.AllyTeam(session.spectatorVisibilityTeam);
                }
            } else if (session.team >= 0 && teamHandler.IsValidTeam(session.team)) {
                viewerAllyTeam = teamHandler.AllyTeam(session.team);
            }

            if (viewerAllyTeam >= 0) {
                auto bitmap = intelEvents->BuildLosBitmap(viewerAllyTeam, frameNo);
                if (!bitmap.empty())
                    // Vision tier (reliable uni, GW2): a LOS bitmap can be
                    // large; on its own stream it can't head-of-line-block
                    // the control bidi (commands/ACKs/chat).
                    rtcServer.SendStream(clientId, StreamClass::Vision,
                                         bitmap.data(), bitmap.size());
                return;
            }

            // Spectator (Global mode): stream up to `specStride` ally teams per
            // second, round-robin so all teams cycle every
            // (activeAllyTeams / specStride) seconds.
            if (activeAllyTeams <= 0) return;
            for (int slot = 0; slot < specStride; ++slot) {
                const int at = ((specSecond * specStride) + slot) % activeAllyTeams;
                auto bitmap = intelEvents->BuildLosBitmap(at, frameNo);
                if (!bitmap.empty())
                    rtcServer.SendStream(clientId, StreamClass::Vision,
                                         bitmap.data(), bitmap.size());
            }
        });
    }
}


// W3: Intern a key string and return its ID. Creates a new ID if not already interned.
uint16_t StateStreamer::InternKey(const std::string& key) {
    auto it = keyToId.find(key);
    if (it != keyToId.end()) {
        return it->second;
    }

    // Reserve 0 for "not interned"
    if (idToKey.empty()) {
        idToKey.push_back("");  // index 0 reserved
    }

    // Check if we have exhausted the ID space (16-bit)
    if (idToKey.size() >= 65535) {
        return 0;  // fall back to string key
    }

    uint16_t newId = static_cast<uint16_t>(idToKey.size());
    keyToId[key] = newId;
    idToKey.push_back(key);
    keyDictionaryRev++;  // increment revision when dictionary changes
    return newId;
}

// W3: Send the key dictionary to a client
void StateStreamer::SendKeyDictionary(int clientId) {
    auto& rtcServer = ctx.rtcServer;

    flatbuffers::FlatBufferBuilder fbb(1024);
    std::vector<flatbuffers::Offset<flatbuffers::String>> keyOffsets;

    // Skip index 0 (reserved)
    for (size_t i = 1; i < idToKey.size(); ++i) {
        keyOffsets.push_back(fbb.CreateString(idToKey[i]));
    }

    auto keysVec = fbb.CreateVector(keyOffsets);

    SpringWeb::RulesParamKeyDictionaryBuilder db(fbb);
    db.add_keys(keysVec);
    db.add_dictionary_rev(keyDictionaryRev);
    auto dictOff = db.Finish();

    auto msg = Protocol::BuildServerMessage(fbb,
        SpringWeb::ServerPayload_RulesParamKeyDictionary,
        dictOff.Union());

    rtcServer.SendStream(clientId, StreamClass::Control,
        msg.data(), msg.size(), kEventLaneParams);
}
