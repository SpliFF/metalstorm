/**
 * PlayerRosterBroadcast — the game server's authoritative player roster.
 *
 * Before this existed the client had no roster at all: `protocol.fbs` carried
 * no player table, so the only names a client ever saw came from the *lobby*
 * room snapshot on the main thread. That snapshot is not a substitute — it
 * holds no AI slots (Metalstorm registers each AI as a real virtual player,
 * PLAN-metalstorm-ai.md §1), no sim player numbers (it keys by DB account id),
 * and it is frozen at game start so a mid-game join or reconnect never shows
 * up. Consequence, measured live: Metalstorm's scoreboard rendered one `You`
 * row and never named the opponent (PLAN-endtoend.md D3).
 *
 * The roster is rebuilt from `playerHandler` — the same source
 * `Spring.GetPlayerList()` reads — and broadcast in full on every change. It
 * is a handful of rows, and a client that missed a delta would be permanently
 * wrong, so completeness beats bandwidth here.
 *
 * `account_id` is the one field `playerHandler` cannot supply: CPlayer has no
 * notion of a DB account. It is joined in from the live sessions via
 * `clientPlayerNum`, and is therefore 0 for AI virtual players (no account)
 * and for a player who has since disconnected (session gone) — in both cases
 * the sim `player_num` remains correct, which is what callers key on.
 */
#pragma once

#include "GameServerContext.h"
#include "Protocol.h"
#include "ClientSession.h"
#include "WebTransport/WebTransportServer.h"
#include "Game/Players/Player.h"
#include "Game/Players/PlayerHandler.h"
#include "Sim/Misc/TeamHandler.h"

#include <cstdint>
#include <vector>

namespace Protocol {

/// Snapshot every CPlayer in `playerHandler` as roster rows.
inline std::vector<PlayerRosterRow> CollectPlayerRoster(GameServerContext& ctx) {
    // playerNum -> account id, joined in from the live sessions (see header).
    std::unordered_map<int, uint32_t> accountByPlayerNum;
    for (const auto& [clientId, pNum] : ctx.clientPlayerNum) {
        if (auto* s = ctx.sessions.GetSession(clientId))
            accountByPlayerNum[pNum] = static_cast<uint32_t>(s->userId);
    }

    std::vector<PlayerRosterRow> rows;
    const int n = playerHandler.ActivePlayers();
    rows.reserve(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
        const CPlayer* p = playerHandler.Player(i);
        if (p == nullptr)
            continue;
        // A war's pre-allocated seats are places, not people
        // (PLAN-metalstorm-wars.md §8.1): the block exists from frame 0 so a
        // dynamic joiner has somewhere to land, and broadcasting the empty
        // ones would put Σ slotCap nameless rows on every scoreboard and
        // player list before anybody joined. Claimed slots carry a name and
        // broadcast normally; AddPlayer's own gap stubs are named "unknown"
        // and still do, because those are holes in the numbering rather than
        // seats somebody is expected to take.
        if (playerHandler.IsUnclaimedSlot(i))
            continue;
        PlayerRosterRow row;
        row.playerNum = i;
        row.name      = p->name;
        row.team      = static_cast<int16_t>(p->team);
        // A spectator has no team, so it has no ally team either; likewise a
        // team the sim never activated. -1 rather than a guessed 0 — the
        // client uses this to decide "is this player on my side".
        row.allyTeam  = teamHandler.IsValidTeam(p->team)
            ? static_cast<int16_t>(teamHandler.AllyTeam(p->team))
            : static_cast<int16_t>(-1);
        row.spectator = p->spectator;
        row.isAI      = p->isAI;
        row.active    = p->active;
        auto it = accountByPlayerNum.find(i);
        row.accountId = (it != accountByPlayerNum.end()) ? it->second : 0u;
        rows.push_back(std::move(row));
    }
    return rows;
}

/// Send the current roster to one client (post-auth one-shot).
inline void SendPlayerRosterTo(GameServerContext& ctx, ClientID clientId) {
    auto msg = BuildPlayerRoster(CollectPlayerRoster(ctx));
    ctx.rtcServer.SendReliable(clientId, msg.data(), msg.size());
}

/// Re-broadcast the roster to everyone. Call after any change to
/// `playerHandler` or to the client→playerNum mapping (join, reconnect, leave).
inline void BroadcastPlayerRoster(GameServerContext& ctx) {
    auto msg = BuildPlayerRoster(CollectPlayerRoster(ctx));
    ctx.rtcServer.BroadcastReliable(msg.data(), msg.size());
}

}  // namespace Protocol
