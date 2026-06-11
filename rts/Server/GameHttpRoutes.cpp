#include "GameHttpRoutes.h"
#include "GameServerContext.h"

#include "NetworkServer.h"
#include "ContentServer.h"
#include "Database.h"
#include "LuaExecEngine.h"
#include "HttpAuth.h"
#include "PerfMetrics.h"
#include "WebTransport/WebTransportServer.h"
#include "Map/ReadMap.h"
#include "Sim/Misc/GlobalConstants.h"
#include "System/SpringLog/SpringLog.h"

#include <nlohmann/json.hpp>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>

#define LOG_SECTION "server"

void RegisterGameHttpRoutes(GameServerContext& ctx,
                            ContentServer& content,
                            const std::vector<std::string>& contentRoots,
                            const std::string& mapsDir,
                            std::atomic<bool>& restartRequested,
                            std::atomic<bool>& keepRunning) {
    auto& net = ctx.net;

    // HTTP endpoints for terrain data (handlers check readMap at request time)
    net.AddHttpGet("/api/map/heightmap", [](const std::string&) -> HttpResponse {
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

    net.AddHttpGet("/api/map/info", [](const std::string&) -> HttpResponse {
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
    net.AddHttpGet("/api/maps", [&mapsDir](const std::string&) -> HttpResponse {
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
    net.AddHttpGet("/api/maps/thumb/*", [&mapsDir](const std::string& url) -> HttpResponse {
        std::string mapId = url.substr(std::string("/api/maps/thumb/").size());
        namespace fs = std::filesystem;
        fs::path mapDir = fs::path(mapsDir) / mapId;
        if (!fs::is_directory(mapDir))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        // Search for minimap image
        for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
            if (!entry.is_regular_file()) continue;
            auto fname = entry.path().filename().string();
            auto ext = entry.path().extension().string();
            if (fname.find("minimap") != std::string::npos &&
                (ext == ".png" || ext == ".jpg")) {
                std::ifstream f(entry.path(), std::ios::binary);
                if (!f.is_open()) continue;
                std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                           std::istreambuf_iterator<char>());
                std::string ct = (ext == ".png") ? "image/png" : "image/jpeg";
                return {.contentType = ct, .body = std::move(data), .status = 200};
            }
        }
        return {.contentType = "text/plain", .body = {}, .status = 404};
    });

    // Performance metrics endpoint
    net.AddHttpGet("/api/metrics", [](const std::string&) -> HttpResponse {
        std::string json = perfMetrics.ToJSON();
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // --- Content server ---
    content.Init(net, contentRoots);

    // --- HTTP auth + exec endpoints ---
    HttpAuth::RegisterEndpoints(net, ctx.db);

    // Restart-in-place: re-exec this binary with the same argv.
    // Clients get a GameRestarting message before the connection drops.
    net.AddHttpPost("/api/restart", [&ctx, &restartRequested, &keepRunning](const std::string&, const std::string&, const HttpRequestHeaders& headers) -> HttpResponse {
        // S2-adjacent: restarting the game server is a privileged action —
        // admin only, same gate as /api/exec. Was previously unauthenticated.
        int64_t userId = HttpAuth::ValidateToken(ctx.db, headers.authorization);
        if (userId <= 0)
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");
        auto adminUser = ctx.db.FindUserById(userId);
        if (!adminUser || adminUser->role != "admin")
            return HttpAuth::JsonResponse(403, R"({"error":"forbidden — admin role required"})");

        SLOG(SPRING_LOG_NOTICE, "restart requested via /api/restart");
        restartRequested.store(true);
        keepRunning.store(false);
        return {.contentType = "application/json",
                .body = {'{',' ','"','o','k','"',':','t','r','u','e',' ','}'},
                .status = 200};
    });

    net.AddHttpPost("/api/exec", [&ctx](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        // Validate auth token
        int64_t userId = HttpAuth::ValidateToken(ctx.db, headers.authorization);
        if (userId <= 0) {
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized — use POST /api/auth/login first"})");
        }
        // S2: ExecSync runs arbitrary Lua in synced scopes. Admin-only.
        {
            auto execUser = ctx.db.FindUserById(userId);
            if (!execUser || execUser->role != "admin") {
                return HttpAuth::JsonResponse(403, R"({"error":"forbidden — admin role required"})");
            }
        }

        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string scope = j.value("scope", "");
        std::string code = j.value("code", "");

        if (scope.empty() || code.empty()) {
            return HttpAuth::JsonResponse(400, R"({"success":false,"output":"missing scope or code"})");
        }

        auto result = ctx.luaExecEngine.ExecSync(scope, code, 5000);

        std::string json = "{\"success\":" + std::string(result.success ? "true" : "false")
            + ",\"output\":\"" + HttpAuth::JsonEscape(result.output) + "\"}";
        return HttpAuth::JsonResponse(200, json);
    });

    // Cert-hash discovery: the client pins the dev server's ephemeral
    // self-signed cert via serverCertificateHashes. It learns the hash (and the
    // WT port) from this endpoint over the already-trusted HTTP plane.
    net.AddHttpGet("/api/wt/info", [&ctx](const std::string&) -> HttpResponse {
        std::string json = "{\"port\":" + std::to_string(ctx.rtcServer.Port())
            + ",\"certHash\":\"" + ctx.rtcServer.CertHash() + "\""
            + ",\"transport\":\"webtransport\"}";
        return HttpAuth::JsonResponse(200, json);
    });
}
