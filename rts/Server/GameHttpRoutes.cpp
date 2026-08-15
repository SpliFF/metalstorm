#include "GameHttpRoutes.h"
#include "GameServerContext.h"

#include "NetworkServer.h"
#include "ContentServer.h"
#include "CacheControl.h"
#include "Database.h"
#include "EngineIdentity.h"
#include "FactionData.h"
#include "LuaExecEngine.h"
#include "ClientEvalBroker.h"
#include "ClientSession.h"
#include "Protocol.h"
#include "HttpAuth.h"
#include "PathTraversal.h"
#include "PerfMetrics.h"
#include "SimFrameProfiler.h"
#include "WebTransport/WebTransportServer.h"
#include "Map/ReadMap.h"
#include "Sim/Misc/GlobalConstants.h"
#include "System/SpringLog/SpringLog.h"

#include <nlohmann/json.hpp>
#include <array>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <algorithm>
#include <iterator>
#include <set>
#include <unordered_map>
#include <unistd.h>   // getpid() for /api/metrics identity

#define LOG_SECTION "server"

void RegisterGameHttpRoutes(GameServerContext& ctx,
                            ContentServer& content,
                            const std::vector<std::string>& contentRoots,
                            const std::string& mapsDir,
                            std::atomic<bool>& restartRequested,
                            std::atomic<bool>& keepRunning) {
    auto& net = ctx.net;

    // PLAN-security-hardening task 6 (G20): wire the default-deny dispatch
    // gate for RouteAuth::TokenRequired/AdminOnly/LocalhostOrAdmin routes.
    net.SetRouteAuthCallbacks({
        .validateToken = [&ctx](const std::string& authHeader) -> int64_t {
            return HttpAuth::ValidateAuth(ctx.db, authHeader);
        },
        .isAdmin = [&ctx](int64_t userId) -> bool {
            auto user = ctx.db.FindUserById(userId);
            return user && user->role == "admin";
        },
    });

    // HTTP endpoints for terrain data (handlers check readMap at request time)
    net.AddHttpGet("/api/map/heightmap", RouteAuth::Public, [](const std::string&) -> HttpResponse {
        if (readMap == nullptr)
            return {.contentType = "text/plain", .body = {}, .status = 404};

        const float* hm = readMap->GetCornerHeightMapSynced();
        int w = mapDims.mapxp1;
        int h = mapDims.mapyp1;

        // Binary format: u32 width, u32 height, then f32[w*h] row-major
        size_t headerSize = 8;
        size_t dataSize = w * h * sizeof(float);
        std::vector<uint8_t> body(headerSize + dataSize);

        uint32_t wu = static_cast<uint32_t>(w);
        uint32_t hu = static_cast<uint32_t>(h);
        memcpy(body.data(), &wu, 4);
        memcpy(body.data() + 4, &hu, 4);
        memcpy(body.data() + 8, hm, dataSize);

        return {.contentType = "application/octet-stream", .body = std::move(body), .status = 200};
    });

    net.AddHttpGet("/api/map/info", RouteAuth::Public, [](const std::string&) -> HttpResponse {
        if (readMap == nullptr)
            return {.contentType = "text/plain", .body = {}, .status = 404};

        // Simple JSON with map dimensions
        char buf[256];
        int len = snprintf(buf, sizeof(buf),
            "{\"mapx\":%d,\"mapy\":%d,\"squareSize\":%d,\"widthElmos\":%d,\"heightElmos\":%d}",
            mapDims.mapx, mapDims.mapy, SQUARE_SIZE,
            mapDims.mapx * SQUARE_SIZE, mapDims.mapy * SQUARE_SIZE);

        std::vector<uint8_t> body(buf, buf + len);
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // Available maps endpoint — scans mapsDir for SMF files
    net.AddHttpGet("/api/maps", RouteAuth::Public, [&mapsDir](const std::string&) -> HttpResponse {
        namespace fs = std::filesystem;
        std::string json = "[";
        bool first = true;
        if (!fs::is_directory(mapsDir))
            return {.contentType = "application/json", .body = {'[', ']'}, .status = 200};

        for (auto& mapDir : fs::directory_iterator(mapsDir)) {
            if (!mapDir.is_directory()) continue;

            // Find .smf file
            std::string smfPath;
            std::string thumbPath;
            for (auto& entry : fs::recursive_directory_iterator(mapDir.path())) {
                if (entry.is_regular_file()) {
                    auto ext = entry.path().extension().string();
                    if (ext == ".smf" && smfPath.empty())
                        smfPath = entry.path().string();
                    auto fname = entry.path().filename().string();
                    if (fname.find("minimap") != std::string::npos &&
                        (ext == ".png" || ext == ".jpg"))
                        thumbPath = entry.path().string();
                }
            }
            if (smfPath.empty()) continue;

            // Read SMF header for dimensions
            int mapx = 0, mapy = 0;
            float minH = 0, maxH = 0;
            {
                std::ifstream f(smfPath, std::ios::binary);
                if (f.is_open()) {
                    char magic[16];
                    int version, mapid;
                    f.read(magic, 16);
                    f.read(reinterpret_cast<char*>(&version), 4);
                    f.read(reinterpret_cast<char*>(&mapid), 4);
                    f.read(reinterpret_cast<char*>(&mapx), 4);
                    f.read(reinterpret_cast<char*>(&mapy), 4);
                    f.seekg(4, std::ios::cur); // squareSize
                    f.seekg(4, std::ios::cur); // texelPerSquare
                    f.seekg(4, std::ios::cur); // tilesize
                    f.read(reinterpret_cast<char*>(&minH), 4);
                    f.read(reinterpret_cast<char*>(&maxH), 4);
                }
            }

            std::string dirName = mapDir.path().filename().string();
            std::string thumbUrl = thumbPath.empty() ? "" :
                "/api/content/assets/" + fs::relative(thumbPath, mapDir.path()).string();

            if (!first) json += ",";
            first = false;
            char buf[512];
            snprintf(buf, sizeof(buf),
                "{\"id\":\"%s\",\"name\":\"%s\",\"path\":\"%s\","
                "\"mapx\":%d,\"mapy\":%d,\"widthElmos\":%d,\"heightElmos\":%d,"
                "\"minHeight\":%.1f,\"maxHeight\":%.1f,\"thumbnail\":\"%s\"}",
                dirName.c_str(), dirName.c_str(), mapDir.path().string().c_str(),
                mapx, mapy, mapx * 8, mapy * 8,
                minH, maxH, thumbUrl.c_str());
            json += buf;
        }
        json += "]";
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // Serve map thumbnail images
    net.AddHttpGet("/api/maps/thumb/*", RouteAuth::Public, [&mapsDir](const std::string& url) -> HttpResponse {
        std::string mapId = url.substr(std::string("/api/maps/thumb/").size());
        // G11 (PLAN-security-hardening.md): every sibling content route
        // guards against `..` traversal in the client-supplied id; this one
        // didn't, letting `mapId` walk `mapsDir` to an arbitrary file read.
        if (HasPathTraversal(mapId))
            return {.contentType = "text/plain", .body = {}, .status = 403};
        namespace fs = std::filesystem;
        fs::path mapDir = fs::path(mapsDir) / mapId;
        if (!fs::is_directory(mapDir))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        // Search for a browser-displayable thumbnail. Maps do not agree on
        // what to call it: the older hand-made maps ship `minimap.png`, the
        // generated ones (Meridian Basin, Skerry Reach) ship `preview.png`,
        // and some ship only `thumbnail.webp`. Matching `minimap` + png/jpg
        // alone left the lobby's map picker with a blank card for the
        // flagship map (PLAN-endtoend.md, fire 15). `.ktx2` is deliberately
        // not served here — it is the in-game minimap texture and no <img>
        // can decode it.
        static const std::array<std::string_view, 3> kStems =
            {"thumbnail", "preview", "minimap"};
        auto contentTypeFor = [](const std::string& ext) -> const char* {
            if (ext == ".png") return "image/png";
            if (ext == ".webp") return "image/webp";
            if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
            return nullptr;
        };
        // Ranked by stem so a map shipping several gets the most
        // thumbnail-like one, not whichever the directory walk reached first.
        for (auto stem : kStems) {
            for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
                if (!entry.is_regular_file()) continue;
                auto fname = entry.path().filename().string();
                auto ext = entry.path().extension().string();
                const char* ct = contentTypeFor(ext);
                if (ct == nullptr || fname.find(stem) == std::string::npos)
                    continue;
                std::ifstream f(entry.path(), std::ios::binary);
                if (!f.is_open()) continue;
                std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                           std::istreambuf_iterator<char>());
                return {.contentType = ct, .body = std::move(data), .status = 200};
            }
        }
        return {.contentType = "text/plain", .body = {}, .status = 404};
    });

    // Performance metrics endpoint. Base fields come from PerfMetrics
    // (whole-tick timing, entity/client counts); `simFrame` adds the
    // PLAN-server-cpp-optimisation.md P0 phase breakdown of
    // CSimulation::SimFrame() (native sim / unit-script tick / synced Lua
    // call-ins) when that profiler has been enabled via the `server sim
    // profile on` console verb — empty/zeroed otherwise, so this route is
    // cheap to poll even when nobody has turned the profiler on.
    net.AddHttpGet("/api/metrics", RouteAuth::Public, [](const std::string&) -> HttpResponse {
        nlohmann::json j = nlohmann::json::parse(perfMetrics.ToJSON(), nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
            j = nlohmann::json::object();

        nlohmann::json simFrame = nlohmann::json::object();
        simFrame["enabled"] = SimFrameProfiler::IsEnabled();
        const auto& frame = SimFrameProfiler::GetFrame();
        simFrame["frameSamples"] = frame.samples;
        if (frame.samples > 0) {
            const double avgFrameUs = frame.totalUs / static_cast<double>(frame.samples);
            simFrame["avgFrameUs"] = avgFrameUs;
            simFrame["maxFrameUs"] = frame.maxUs;

            nlohmann::json phases = nlohmann::json::object();
            for (int i = 0; i < SimFrameProfiler::Phase_Count; ++i) {
                const auto phase = static_cast<SimFrameProfiler::Phase>(i);
                const auto& e = SimFrameProfiler::GetPhase(phase);
                const double avgUs = e.samples != 0 ? e.totalUs / static_cast<double>(e.samples) : 0.0;
                const double share = frame.totalUs > 0.0 ? (100.0 * e.totalUs / frame.totalUs) : 0.0;
                phases[SimFrameProfiler::PhaseName(phase)] = {
                    {"avgUs", avgUs}, {"maxUs", e.maxUs}, {"sharePct", share}
                };
            }
            simFrame["phases"] = phases;
        }
        j["simFrame"] = simFrame;

        // Binary identity for stale-binary detection (PLAN-test-automation P8):
        // which build is actually serving this room, comparable against
        // `spring-server --print-engine-hash` of the on-disk binary. The MCP's
        // list_stack flags `stale-binary-running` when the two disagree — the
        // "you rebuilt, but the process you are testing is the old one" trap.
        //
        // Prod-safe, deliberately NOT compiled out under SPRING_PROD: `stamp`
        // is already public via the lobby's /api/version, `engineHash` is a
        // pure function of it (EngineIdentity.h), and the pid of a localhost
        // dev server is not sensitive. The stamp comes via CacheControl so the
        // `#if __has_include("BuildStamp.h")` guard lives in exactly one place.
        const char* stamp = CacheControl::BuildStamp();
        j["identity"] = {
            {"stamp",      stamp},
            {"engineHash", engineid::HashHex(engineid::StampHash(stamp))},
            {"pid",        static_cast<int>(getpid())},
        };

        std::string json = j.dump();
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // --- Content server ---
    content.Init(net, contentRoots);

    // --- HTTP auth + exec endpoints ---
    // PLAN-metalstorm-lobby.md task 0: this game server instance is scoped
    // to a single game (contentRoots[0], when present, is server_main's
    // `gamePath`), so unlike the lobby's per-process registry spanning many
    // games, this one is just that game's declared factions. `static`
    // because HttpAuth::RegisterEndpoints captures it by reference into
    // route handlers that outlive this function call — a plain local would
    // dangle the moment RegisterGameHttpRoutes returns.
    static const std::unordered_map<std::string, FactionData::FactionInfo> factionRegistry = [&contentRoots] {
        std::unordered_map<std::string, FactionData::FactionInfo> reg;
        if (!contentRoots.empty())
            for (const auto& f : FactionData::Discover(contentRoots[0]))
                reg.emplace(f.key, f);
        return reg;
    }();
    HttpAuth::RegisterEndpoints(net, ctx.db, factionRegistry);

    // Restart-in-place: re-exec this binary with the same argv.
    // Clients get a GameRestarting message before the connection drops.
    net.AddHttpPost("/api/restart", RouteAuth::AdminOnly, [&ctx, &restartRequested, &keepRunning](const std::string&, const std::string&, const HttpRequestHeaders& headers) -> HttpResponse {
        // S2-adjacent: restarting the game server is a privileged action —
        // admin only, same gate as /api/exec. Was previously unauthenticated.
        int64_t userId = HttpAuth::ValidateToken(ctx.db, headers.authorization);
        if (userId <= 0)
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");
        auto adminUser = ctx.db.FindUserById(userId);
        if (!adminUser || adminUser->role != "admin")
            return HttpAuth::JsonResponse(403, R"({"error":"forbidden — admin role required"})");

        ctx.db.LogAudit(userId, adminUser->username, "restart", "", "");
        SLOG(SPRING_LOG_NOTICE, "restart requested via /api/restart");
        restartRequested.store(true);
        keepRunning.store(false);
        return {.contentType = "application/json",
                .body = {'{',' ','"','o','k','"',':','t','r','u','e',' ','}'},
                .status = 200};
    });

    // PLAN-security-hardening task 2: compiled OUT entirely under
    // SPRING_PROD — ExecSync runs arbitrary Lua in synced scopes, total game
    // compromise if reachable at all. In a non-prod build the route is
    // LocalhostOrAdmin, NOT AdminOnly: the browser model-viewer / scenario
    // harness POSTs /api/exec to the game server from the same machine
    // (loopback), but its dev session (lobby ensureDevSession) is a plain
    // "player", never an admin — the G20 AdminOnly gate 403'd (or 401'd on a
    // stale token) every harness exec: spawn, probes, showcases. Trusting a
    // loopback caller is safe because the whole route is compiled out under
    // SPRING_PROD, so it is unreachable in any production binary regardless of
    // origin. A NON-loopback caller (remote admin console) still needs a valid
    // admin token — re-checked below, mirroring the LocalhostOrAdmin gate.
#ifndef SPRING_PROD
    net.AddHttpPost("/api/exec", RouteAuth::LocalhostOrAdmin, [&ctx](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        // Resolve the acting user for the audit trail + the non-loopback
        // admin re-check. Loopback (dev/test harness) is allowed even with an
        // empty/expired token; the dispatch gate already enforced
        // remoteIsLoopback || (valid token && admin) before we get here.
        int64_t userId = HttpAuth::ValidateToken(ctx.db, headers.authorization);
        std::string execUsername = headers.remoteIsLoopback ? "localhost" : "";
        if (userId > 0) {
            auto execUser = ctx.db.FindUserById(userId);
            // S2: ExecSync runs arbitrary Lua in synced scopes. A remote
            // caller must be an admin; a loopback caller is trusted.
            if (!headers.remoteIsLoopback && (!execUser || execUser->role != "admin")) {
                return HttpAuth::JsonResponse(403, R"({"error":"forbidden — admin role required"})");
            }
            if (execUser) execUsername = execUser->username;
        } else if (!headers.remoteIsLoopback) {
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized — use POST /api/auth/login first"})");
        }

        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string scope = j.value("scope", "");
        std::string code = j.value("code", "");

        // Task 6: append-only admin audit trail.
        ctx.db.LogAudit(userId, execUsername, "exec", scope, code.substr(0, 200));

        if (scope.empty() || code.empty()) {
            return HttpAuth::JsonResponse(400, R"({"success":false,"output":"missing scope or code"})");
        }

        auto result = ctx.luaExecEngine.ExecSync(scope, code, 5000);

        std::string json = "{\"success\":" + std::string(result.success ? "true" : "false")
            + ",\"output\":\"" + HttpAuth::JsonEscape(result.output) + "\"}";
        return HttpAuth::JsonResponse(200, json);
    });

    // PLAN-test-automation P7: browser-eval relay. Runs arbitrary code in a
    // CONNECTED browser and returns the result — same threat class as
    // /api/exec above (arbitrary code; a different victim, the client rather
    // than the sim), so it lives inside the same `#ifndef SPRING_PROD` block
    // and inherits the same loopback-or-admin argument: trusting a loopback
    // caller is safe precisely because the route cannot exist in a production
    // binary. The client-side DEV gate is policy in a bundle the server
    // cannot verify, so it is a third gate, not the only one.
    //
    // Three stacked gates: (1) this route's auth + prod compile-out,
    // (2) only an admin-role session is ever addressed, (3) the browser
    // itself refuses unless it is a DEV build or booted ?allowClientEval=1.
    //
    // All refusals answer 200 with success:false so a caller can branch on
    // `output`; 400 is reserved for a malformed request, and a 404 (route
    // absent) means a prod binary — the MCP falls back to printing snippets.
    net.AddHttpPost("/api/client/eval", RouteAuth::LocalhostOrAdmin, [&ctx](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        // Auth preamble mirrors /api/exec exactly (see its comment above).
        int64_t userId = HttpAuth::ValidateToken(ctx.db, headers.authorization);
        std::string execUsername = headers.remoteIsLoopback ? "localhost" : "";
        if (userId > 0) {
            auto execUser = ctx.db.FindUserById(userId);
            if (!headers.remoteIsLoopback && (!execUser || execUser->role != "admin")) {
                return HttpAuth::JsonResponse(403, R"({"error":"forbidden — admin role required"})");
            }
            if (execUser) execUsername = execUser->username;
        } else if (!headers.remoteIsLoopback) {
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized — use POST /api/auth/login first"})");
        }

        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        const std::string target = j.value("target", "js");
        const std::string code   = j.value("code", "");
        const uint32_t requestedClient = j.value("clientId", 0u);
        const int timeoutMs = std::max(500, std::min(60000, j.value("timeoutMs", 10000)));

        static const std::set<std::string> kTargets{"js", "worker", "widgets", "test"};
        if (code.empty() || !kTargets.count(target)) {
            return HttpAuth::JsonResponse(400,
                R"({"success":false,"output":"need code + target js|worker|widgets|test"})");
        }

        ctx.db.LogAudit(userId, execUsername, "client_eval", target, code.substr(0, 200));

        // Gate 2: resolve the addressed session. An explicit clientId must
        // ALSO be a live admin session; otherwise take the HIGHEST-id live
        // admin. Role is per-session, the same check ConsoleCommand enforces.
        //
        // Two traps are encoded here. `s.disconnected` sessions linger in the
        // map so a reload can reclaim its player slot — addressing one sends
        // the request into a transport that no longer exists and the caller
        // eats the full timeout with no clue why. And the tiebreak is
        // newest-wins rather than lowest-id: a reload of the same tab arrives
        // as a NEW client id beside the corpse of the old one, so "lowest"
        // reliably picks the tab that just went away. NOTE the documented
        // role trap: a /api/rooms/direct dev account is role "player", so a
        // browser booted that way is never eligible and gets
        // "no connected admin client".
        uint32_t chosen = 0;
        ctx.sessions.ForEachSession([&](ClientID id, ClientSession& s) {
            if (s.role != "admin" || s.disconnected) return;
            if (requestedClient != 0) {
                if (id == requestedClient) chosen = id;
            } else if (id > chosen) {
                chosen = id;
            }
        });
        if (chosen == 0) {
            return HttpAuth::JsonResponse(200,
                R"({"success":false,"output":"no connected admin client"})");
        }

        const uint32_t reqId = ctx.evalBroker.Begin(chosen);
        auto msg = Protocol::BuildClientEvalRequest(reqId, target, code);
        // SendReliable only locks txMutex and queues, so calling it from the
        // HTTP thread is safe — no sim-thread bounce needed (unlike anything
        // that touches sim state).
        ctx.rtcServer.SendReliable(chosen, msg.data(), msg.size());

        bool success = false;
        std::string output;
        if (!ctx.evalBroker.Wait(reqId, timeoutMs, success, output)) {
            return HttpAuth::JsonResponse(200,
                std::string(R"({"success":false,"clientId":)") + std::to_string(chosen)
                + R"(,"output":"timeout: client did not answer in )"
                + std::to_string(timeoutMs) + R"(ms"})");
        }
        std::string json = "{\"success\":" + std::string(success ? "true" : "false")
            + ",\"clientId\":" + std::to_string(chosen)
            + ",\"output\":\"" + HttpAuth::JsonEscape(output) + "\"}";
        return HttpAuth::JsonResponse(200, json);
    });
#endif // !SPRING_PROD

    // WebTransport endpoint discovery (PLAN-security-hardening.md task 5, G3).
    // Dual mode: `webpki` (--wt-cert/--wt-key given — a CA cert, browsers
    // validate normally, no hash published since a rotating CA cert can't be
    // pinned without breaking clients on renewal) vs `hashes` (self-signed
    // rolling pair — the client pins via serverCertificateHashes; both the
    // active and the already-generated "next" hash are published so a client
    // holding a stale answer can still connect across a rotation).
    net.AddHttpGet("/api/wt/info", RouteAuth::Public, [&ctx](const std::string&) -> HttpResponse {
        const bool webpki = ctx.rtcServer.CertMode() == WtCertMode::Webpki;
        nlohmann::json j;
        j["port"] = ctx.rtcServer.Port();
        j["transport"] = "webtransport";
        j["certMode"] = webpki ? "webpki" : "hashes";
        if (!webpki) {
            j["certHashes"] = ctx.rtcServer.CertHashes();
            // Back-compat single-hash field for clients built before the
            // dual-mode change.
            j["certHash"] = ctx.rtcServer.CertHash();
        }
        return HttpAuth::JsonResponse(200, j.dump());
    });
}
