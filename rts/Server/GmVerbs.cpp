/**
 * GmVerbs — see GmVerbs.h.
 */
#include "GmVerbs.h"
#include "GameServerContext.h"

#include "NetworkServer.h"
#include "Database.h"
#include "HttpAuth.h"
#include "LuaExecEngine.h"
#include "ClientSession.h"
#include "Protocol.h"
#include "PerfMetrics.h"
#include "WebTransport/WebTransportServer.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Misc/TeamHandler.h"
#include "System/SpringLog/SpringLog.h"

#include <nlohmann/json.hpp>
#include <cstdio>
#include <optional>
#include <string>

#define LOG_SECTION "gm"

// NOTE: the pure rollback orchestration `DoRollback` lives in GmRollback.cpp
// (a dependency-light TU so the Opus-flagged rollback semantics are unit-
// testable against a mock store without linking this file's sim/net deps).

// ─────────────────────────── helpers ───────────────────────────

namespace {

using nlohmann::json;

/// Escape a string for a Lua double-quoted literal (grant reason → Award()).
/// Prevents the reason field from breaking out of the constructed Lua call.
std::string LuaStr(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; std::snprintf(b, sizeof(b), "\\%u", c); o += b; }
                else o += static_cast<char>(c);
        }
    }
    o += "\"";
    return o;
}

/// Parse a request body as JSON, tolerating an empty body as `{}`.
json ParseBody(const std::string& body) {
    if (body.empty()) return json::object();
    json j = json::parse(body, nullptr, /*allow_exceptions=*/false);
    return j.is_discarded() ? json::object() : j;
}

}  // namespace

// ─────────────────────────── registration ───────────────────────────

void RegisterGmVerbs(GameServerContext& ctx, ISnapshotStore& store) {
    // Belt-and-braces admin gate. The AdminOnly RouteAuth tag already blocks
    // non-admins at NetworkServer's dispatch, but each handler re-validates
    // (same pattern as /api/exec + /api/restart) so a future dispatch-gate
    // regression can never expose a GM verb. Fills `outUser` on success.
    struct AdminCtx { int64_t userId = 0; std::string username; };
    auto authAdmin = [&ctx](const HttpRequestHeaders& headers,
                            AdminCtx& out) -> std::optional<HttpResponse> {
        int64_t userId = HttpAuth::ValidateToken(ctx.db, headers.authorization);
        if (userId <= 0)
            return HttpAuth::JsonResponse(401, R"({"ok":false,"error":"unauthorized"})");
        auto user = ctx.db.FindUserById(userId);
        if (!user || user->role != "admin")
            return HttpAuth::JsonResponse(403, R"({"ok":false,"error":"forbidden — admin role required"})");
        out.userId = userId;
        out.username = user->username;
        return std::nullopt;
    };
    const std::string roomTag = "room=" + std::to_string(ctx.roomId);

    // --- pause / resume: existing gs->paused, via the server exec scope ---
    ctx.net.AddHttpPost("/api/gm/pause", RouteAuth::AdminOnly,
        [&ctx, authAdmin, roomTag](const std::string&, const std::string&,
                                    const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            ctx.db.LogAudit(a.userId, a.username, "gm_pause", ctx.gameId, roomTag);
            ctx.luaExecEngine.ExecSync("server", "pause", 5000);
            return HttpAuth::JsonResponse(200, R"({"ok":true,"state":"paused"})");
        });

    ctx.net.AddHttpPost("/api/gm/resume", RouteAuth::AdminOnly,
        [&ctx, authAdmin, roomTag](const std::string&, const std::string&,
                                    const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            ctx.db.LogAudit(a.userId, a.username, "gm_resume", ctx.gameId, roomTag);
            ctx.luaExecEngine.ExecSync("server", "unpause", 5000);
            return HttpAuth::JsonResponse(200, R"({"ok":true,"state":"running"})");
        });

    // --- grant: authority award via the game's GG.Authority (Metalstorm) ---
    ctx.net.AddHttpPost("/api/gm/grant", RouteAuth::AdminOnly,
        [&ctx, authAdmin](const std::string&, const std::string& body,
                          const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            json j = ParseBody(body);
            const std::string target = j.value("target", std::string("team"));
            const int id = j.value("id", -1);
            const double amount = j.value("amount", 0.0);
            const std::string reason = j.value("reason", std::string(""));
            if ((target != "team" && target != "player") || id < 0 || amount == 0.0)
                return HttpAuth::JsonResponse(400,
                    R"({"ok":false,"error":"target(team|player)+id>=0+amount!=0 required"})");

            // Server-constructed, bounded Lua — never client code. The `reason`
            // is escaped into a literal so it can't break out of the Award call.
            // Tagged 'admin_grant' so the economy ledger keeps it out of balance
            // metrics (PLAN-metalstorm-economy §7).
            char idbuf[32]; std::snprintf(idbuf, sizeof(idbuf), "%d", id);
            char ambuf[64]; std::snprintf(ambuf, sizeof(ambuf), "%.6g", amount);
            std::string code =
                "if GG and GG.Authority and GG.Authority.Award then "
                "GG.Authority.Award({" + target + "=" + idbuf + "}, " + ambuf + ", " +
                LuaStr("admin_grant:" + reason) + ") return \"granted\" "
                "else return \"unsupported\" end";

            ctx.db.LogAudit(a.userId, a.username, "gm_grant", target + ":" + idbuf,
                            std::string("amount=") + ambuf + " reason=" + reason.substr(0, 120));

            auto r = ctx.luaExecEngine.ExecSync("LuaRules", code, 5000);
            if (r.output.find("unsupported") != std::string::npos)
                return HttpAuth::JsonResponse(501,
                    R"({"ok":false,"error":"grant unsupported — game defines no GG.Authority"})");
            if (!r.success || r.output.find("granted") == std::string::npos)
                return HttpAuth::JsonResponse(500,
                    std::string(R"({"ok":false,"error":")") + HttpAuth::JsonEscape(r.output) + "\"}");
            return HttpAuth::JsonResponse(200,
                std::string(R"({"ok":true,"target":")") + target + "\",\"id\":" + idbuf +
                ",\"amount\":" + ambuf + "}");
        });

    // --- broadcast: a GM system message to every connected client ---
    ctx.net.AddHttpPost("/api/gm/broadcast", RouteAuth::AdminOnly,
        [&ctx, authAdmin](const std::string&, const std::string& body,
                          const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            json j = ParseBody(body);
            const std::string message = j.value("message", std::string(""));
            if (message.empty())
                return HttpAuth::JsonResponse(400, R"({"ok":false,"error":"message required"})");
            // Delivered as a LuaUIMsgRelay with the GM sentinel + player_id -1;
            // the client worker intercepts the sentinel before widget dispatch
            // and renders a toast (never reaches a widget → can't crash one).
            const std::string payload = std::string(kGmBroadcastSentinel) + message;
            auto relay = Protocol::BuildLuaUIMsgRelay(payload, -1);
            ctx.rtcServer.BroadcastReliable(relay.data(), relay.size());
            ctx.db.LogAudit(a.userId, a.username, "gm_broadcast", ctx.gameId, message.substr(0, 160));
            const int clients = ctx.rtcServer.GetClientCount();
            char buf[96]; std::snprintf(buf, sizeof(buf), R"({"ok":true,"delivered":%d})", clients);
            return HttpAuth::JsonResponse(200, buf);
        });

    // --- inspect: read-only live state dump (scriptable triage) ---
    ctx.net.AddHttpPost("/api/gm/inspect", RouteAuth::AdminOnly,
        [&ctx, authAdmin](const std::string&, const std::string&,
                          const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            const auto snap = perfMetrics.GetSnapshot();
            json out;
            out["ok"] = true;
            out["roomId"] = ctx.roomId;
            out["gameId"] = ctx.gameId;
            out["mapId"] = ctx.mapId;
            out["port"] = ctx.port;
            out["frame"] = snap.frame;
            out["paused"] = gs ? gs->paused : false;
            out["speed"] = gs ? gs->speedFactor : 0.0f;
            out["tickUs"] = snap.tickTimeUs;
            out["simFps"] = snap.simFps;
            out["entities"] = snap.entityCount;
            out["clients"] = snap.clientCount;
            out["ais"] = snap.aiCount;
            out["teams"] = teamHandler.ActiveTeams();
            json players = json::array();
            ctx.sessions.ForEachSession([&](ClientID id, ClientSession& s) {
                players.push_back({{"clientId", id}, {"username", s.username},
                                   {"team", s.team}, {"role", s.role}});
            });
            out["players"] = players;
            ctx.db.LogAudit(a.userId, a.username, "gm_inspect", ctx.gameId, "");
            return HttpAuth::JsonResponse(200, out.dump());
        });

    // --- kick: force-disconnect a connected player from THIS game ---
    ctx.net.AddHttpPost("/api/gm/kick", RouteAuth::AdminOnly,
        [&ctx, authAdmin, roomTag](const std::string&, const std::string& body,
                                    const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            json j = ParseBody(body);
            const std::string player = j.value("player", std::string(""));
            if (player.empty())
                return HttpAuth::JsonResponse(400, R"({"ok":false,"error":"player required"})");
            ClientID targetId = 0;
            ctx.sessions.ForEachSession([&](ClientID id, ClientSession& s) {
                if (s.username == player) targetId = id;
            });
            if (targetId == 0)
                return HttpAuth::JsonResponse(404, R"({"ok":false,"error":"player not connected"})");
            ctx.rtcServer.KickClient(targetId);
            ctx.db.LogAudit(a.userId, a.username, "gm_kick", player, roomTag);
            return HttpAuth::JsonResponse(200,
                std::string(R"({"ok":true,"kicked":")") + HttpAuth::JsonEscape(player) + "\"}");
        });

    // --- snapshots: rollback targets for the dashboard (empty until persistence) ---
    ctx.net.AddHttpPost("/api/gm/snapshots", RouteAuth::AdminOnly,
        [&ctx, &store, authAdmin](const std::string&, const std::string&,
                                   const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            json out;
            out["ok"] = true;
            out["available"] = store.Available();
            json snaps = json::array();
            for (const auto& s : store.List(ctx.roomId))
                snaps.push_back({{"frame", s.frame}, {"takenAt", s.takenAt},
                                 {"sizeBytes", s.sizeBytes}, {"label", s.label}});
            out["snapshots"] = snaps;
            return HttpAuth::JsonResponse(200, out.dump());
        });

    // --- rollback: the flagship verb (Opus-flagged semantics) ---
    ctx.net.AddHttpPost("/api/gm/rollback", RouteAuth::AdminOnly,
        [&ctx, &store, authAdmin](const std::string&, const std::string& body,
                                   const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            json j = ParseBody(body);
            const int frame = j.value("frame", -1);
            const std::string reason = j.value("reason", std::string(""));
            // Reason is mandatory — it lands in the audit trail AND the player-
            // visible digest (E3 transparency). No anonymous rollbacks.
            if (frame < 0 || reason.empty())
                return HttpAuth::JsonResponse(400,
                    R"({"ok":false,"error":"frame>=0 and reason required"})");

            char fbuf[32]; std::snprintf(fbuf, sizeof(fbuf), "frame=%d", frame);
            ctx.db.LogAudit(a.userId, a.username, "gm_rollback_attempt", fbuf, reason.substr(0, 160));

            const GmRollbackOutcome o = DoRollback(store, ctx.roomId, frame);

            if (o.status == GmRollbackStatus::Ok) {
                // Generation-nonce full-boot (E1): a real nonce mechanism is
                // persistence/quickstart machinery not yet built; GameRestarting
                // is the available full-reentry signal — clients reset + reconnect
                // and re-auth into the restored state.
                auto msg = Protocol::BuildGameRestarting();
                ctx.rtcServer.BroadcastReliable(msg.data(), msg.size());
                char digest[96];
                std::snprintf(digest, sizeof(digest), "pre=%d reason=", o.preCheckpointFrame);
                ctx.db.LogAudit(a.userId, a.username, "gm_rollback", fbuf,
                                std::string(digest) + reason.substr(0, 120));
                char resp[128];
                std::snprintf(resp, sizeof(resp),
                    R"({"ok":true,"frame":%d,"preCheckpointFrame":%d})",
                    frame, o.preCheckpointFrame);
                return HttpAuth::JsonResponse(200, resp);
            }

            int code = 500;
            const char* status = "error";
            switch (o.status) {
                case GmRollbackStatus::Unavailable:      code = 503; status = "unavailable"; break;
                case GmRollbackStatus::NoSuchSnapshot:   code = 404; status = "no_such_snapshot"; break;
                case GmRollbackStatus::CheckpointFailed: code = 500; status = "checkpoint_failed"; break;
                case GmRollbackStatus::RestoreFailed:    code = 500; status = "restore_failed"; break;
                default: break;
            }
            ctx.db.LogAudit(a.userId, a.username, "gm_rollback_failed", fbuf, o.error.substr(0, 160));
            return HttpAuth::JsonResponse(code,
                std::string(R"({"ok":false,"status":")") + status +
                R"(","error":")" + HttpAuth::JsonEscape(o.error) + "\"}");
        });

    // --- checkpoint: manual snapshot (persistence-gated) ---
    ctx.net.AddHttpPost("/api/gm/checkpoint", RouteAuth::AdminOnly,
        [&ctx, &store, authAdmin, roomTag](const std::string&, const std::string&,
                                            const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            ctx.db.LogAudit(a.userId, a.username, "gm_checkpoint", ctx.gameId, roomTag);
            if (!store.Available())
                return HttpAuth::JsonResponse(503,
                    R"({"ok":false,"error":"persistence layer not built — PLAN-persistence"})");
            std::string err;
            const int32_t frame = store.Checkpoint(ctx.roomId, "manual", err);
            if (frame < 0)
                return HttpAuth::JsonResponse(500,
                    std::string(R"({"ok":false,"error":")") + HttpAuth::JsonEscape(err) + "\"}");
            char buf[64]; std::snprintf(buf, sizeof(buf), R"({"ok":true,"frame":%d})", frame);
            return HttpAuth::JsonResponse(200, buf);
        });

    // --- hibernate: lobby-owned lifecycle, exposed but not driven from here ---
    ctx.net.AddHttpPost("/api/gm/hibernate", RouteAuth::AdminOnly,
        [&ctx, authAdmin, roomTag](const std::string&, const std::string&,
                                    const HttpRequestHeaders& headers) -> HttpResponse {
            AdminCtx a; if (auto e = authAdmin(headers, a)) return *e;
            ctx.db.LogAudit(a.userId, a.username, "gm_hibernate", ctx.gameId, roomTag);
            // Hibernation is a checkpoint-then-exit process transition owned by
            // the lobby state machine (PLAN-persistence §3 task 3), not built.
            return HttpAuth::JsonResponse(501,
                R"({"ok":false,"error":"hibernate lifecycle not built — PLAN-persistence task 3"})");
        });

    SLOG(SPRING_LOG_INFO, "GM verbs registered (rollback store: %s)",
         store.Available() ? "live" : "unavailable");
}
