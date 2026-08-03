#include "StateStreamer.h"
#include "GameServerContext.h"

#include "Simulation.h"
#include "Protocol.h"
#include "ClientSession.h"
#include "EntityStateSerializer.h"
#include "PieceStateSerializer.h"
#include "BuildActivitySerializer.h"
#include "CombatEventCollector.h"
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
#include "PerfMetrics.h"
#include "System/Log/ILog.h"
#include "AI/AIRuntimePool.h"
#include "WebTransport/WebTransportServer.h"
#include "Lua/LuaRules.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/Wind.h"
#include "Sim/Misc/ModInfo.h"
#include "Sim/Misc/GlobalConstants.h"
#include "Map/ReadMap.h"
#include "System/SpringLog/SpringLog.h"

#include <algorithm>
#include <vector>

#define LOG_SECTION "server"

void StateStreamer::Tick(int /*frameNum*/) {
    CheckWinCondition(0);
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
            rtcServer.BroadcastReliable(gameOver.data(), gameOver.size());
            return;
        }
    }

    // 2. Hardcoded last-team-standing fallback for games/scenarios with no
    //    game_over gadget (2-team only). Skipped under cheats so scenarios that
    //    empty a team on purpose don't self-terminate.
    if (frame > 30 && (frame % 30) == 0 && winningTeam < 0 && !gs->cheatEnabled) {
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
            // Broadcast GameInfo with game_over=true (NOT via paused — a normal
            // pause must not end the game) + the winning allyteam.
            auto gameOver = Protocol::BuildGameInfo(
                ctx.mapId, ctx.gameId, gs->speedFactor,
                static_cast<uint32_t>(frame), gs->paused,
                0, 0, 0, 0, 0, modInfo.legacyCoordSystem, unitHandler.MaxUnits(),
                /*gameOver*/ true, winners);
            rtcServer.BroadcastReliable(gameOver.data(), gameOver.size());
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
        rtcServer.BroadcastReliable(msg.data(), msg.size());
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
            int viewerAllyTeam = -1;
            if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                viewerAllyTeam = teamHandler.AllyTeam(session.team);

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
            if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                viewerAllyTeam = teamHandler.AllyTeam(session.team);

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
            if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                viewerAllyTeam = teamHandler.AllyTeam(session.team);

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
    }
}

// Tick AI runtime and drain AI commands
void StateStreamer::TickAI(int) {
    auto& aiPool = ctx.aiPool;
    auto& sim = ctx.sim;
    aiPool.Tick(sim.GetFrameNum());
    {
        auto aiCmds = aiPool.DrainCommands();
        for (const auto& cmd : aiCmds) {
            CUnit* unit = unitHandler.GetUnit(cmd.unitId);
            if (unit == nullptr || unit->isDead) continue;
            if (unit->team != cmd.teamId) continue; // validate ownership

            Command simCmd(cmd.commandId, cmd.options);
            for (int i = 0; i < cmd.numParams; i++)
                simCmd.PushParam(cmd.params[i]);
            unit->commandAI->GiveCommand(simCmd);
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
    auto projDrain = projectileEvents.Drain();
    auto soundDrain = soundEvents.Drain();
    auto seismicDrain = intelEvents != nullptr
        ? intelEvents->DrainSeismicPings()
        : std::vector<SeismicPingData>{};
    const bool hasAny = !events.empty()
        || !projDrain.fired.empty()
        || !projDrain.impacts.empty()
        || !projDrain.trajectories.empty()
        || !projDrain.fireOutcomes.empty()
        || !projDrain.keyframes.empty()
        || !projDrain.outcomesKnown.empty()
        || !soundDrain.empty()
        || !seismicDrain.empty();
    if (hasAny && rtcServer.GetClientCount() > 0) {
        const uint32_t frameNo = static_cast<uint32_t>(sim.GetFrameNum());

        // PLAN-latency L3 — pre-filter emission tally, summarised every
        // L3_TALLY_PERIOD frames. This is what the L3 gate's bandwidth
        // bullet measures against, and before the client decodes keyframes
        // it is the only way to tell "the stream is live" from "the stream
        // is empty" — a distinction this lane has twice paid for learning
        // late. L_INFO because an L_DEBUG line is invisible under the
        // server's default filter, and the period keeps it to one line per
        // 10 s of game time. Counted pre-filter on purpose: this is what the
        // sim produced, not what one session was allowed to see.
        {
            constexpr uint32_t L3_TALLY_PERIOD = 300;
            static uint64_t tallyKeyframes = 0;
            static uint64_t tallyOutcomes = 0;
            static uint64_t tallyTrajectories = 0;
            static uint32_t tallyLastReport = 0;

            tallyKeyframes    += projDrain.keyframes.size();
            tallyOutcomes     += projDrain.outcomesKnown.size();
            tallyTrajectories += projDrain.trajectories.size();

            if (frameNo >= tallyLastReport + L3_TALLY_PERIOD) {
                if (tallyKeyframes > 0 || tallyTrajectories > 0 || tallyOutcomes > 0) {
                    LOG_L(L_INFO, "[L3tally] frame=%u cumulative: keyframes=%llu"
                                  " outcomes=%llu trajectories=%llu",
                          frameNo,
                          static_cast<unsigned long long>(tallyKeyframes),
                          static_cast<unsigned long long>(tallyOutcomes),
                          static_cast<unsigned long long>(tallyTrajectories));
                }
                tallyLastReport = frameNo;
            }
        }

        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            int viewerAllyTeam = -1;
            if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                viewerAllyTeam = teamHandler.AllyTeam(session.team);

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

            // Tier-C fire outcomes (PLAN-latency L2.1). Filtered on the same
            // rule as Fired, which this event replaces: owner-friendly, OR
            // the muzzle in LOS, OR the impact point in LOS — the last so a
            // player sees a shell arriving out of the fog rather than an
            // explosion with no shot attached.
            std::vector<FireOutcomeEventData> fireOutcomes;
            fireOutcomes.reserve(projDrain.fireOutcomes.size());
            for (const auto& e : projDrain.fireOutcomes) {
                if (teamFriendly(e.team)
                    || posVisible(e.origin)
                    || posVisible(e.impactPos))
                    fireOutcomes.push_back(e);
            }

            // PLAN-latency L3 — Tier-S keyframes. Same rule as the
            // trajectory events they replace: owner-friendly, or the knot
            // itself in LOS. A projectile crossing a LOS bubble therefore
            // contributes only the knots inside it, which is exactly the
            // segment the viewer can see.
            std::vector<TrajectoryKeyframeData> keyframes;
            keyframes.reserve(projDrain.keyframes.size());
            for (const auto& e : projDrain.keyframes) {
                if (teamFriendly(e.team) || posVisible(e.pos))
                    keyframes.push_back(e);
            }

            // Frame-stamped outcomes. Filtered like ProjectileImpactEvent,
            // whose resolution this restates.
            std::vector<OutcomeKnownEventData> outcomesKnown;
            outcomesKnown.reserve(projDrain.outcomesKnown.size());
            for (const auto& e : projDrain.outcomesKnown) {
                if (teamFriendly(e.team) || posVisible(e.outcomePos))
                    outcomesKnown.push_back(e);
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

            if (visibleCombat.empty() && fired.empty()
                && impacts.empty() && trajectories.empty()
                && fireOutcomes.empty()
                && keyframes.empty() && outcomesKnown.empty()
                && visibleSounds.empty() && visiblePings.empty())
                return;

            auto batch = Protocol::BuildCombatEventBatch(
                frameNo, visibleCombat, fired, impacts, trajectories,
                visibleSounds, visiblePings, fireOutcomes,
                keyframes, outcomesKnown);
            rtcServer.SendReliable(clientId, batch.data(), batch.size());
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
        auto msg = Protocol::BuildEntityDestroy(death.unitId, 1, death.x, death.y, death.z,
                                                death.frame);
        // Bit 31 of losMask is the "ally team >= 32 — broadcast to
        // everyone" escape hatch (see UnitDeathEvent docs).
        const bool broadcastAll = (death.losMask & (1u << 31)) != 0;
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            int viewerAllyTeam = -1;
            if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                viewerAllyTeam = teamHandler.AllyTeam(session.team);
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
            if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
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
            rtcServer.SendReliable(clientId, decalBatch.data(), decalBatch.size());
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
                rtcServer.BroadcastReliable(hmBatch.data(), hmBatch.size());
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
        rtcServer.BroadcastReliable(msg.data(), msg.size());
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
            if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                viewerAllyTeam = teamHandler.AllyTeam(session.team);

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

            // Spectator: stream up to `specStride` ally teams per
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
